import { sameViewport } from '../background/rectangle.mjs';
import './verify-library.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import os from 'node:os';
import { auditPublicRelease, isAllowedHistoryIdentity } from './public-release-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const mathContext = vm.createContext({});
vm.runInContext(read('shared/capture-math.js'), mathContext);
const captureMath = mathContext.SiteDossierCapture;

test('release identity exceptions are bound to reviewed commits and authors', () => {
  const reviewed = 'b5ee10c1be2b9548b80fbbe36aa63cd2c2d8a734';
  const unknown = '0'.repeat(40);
  const owner = '123+example@users.noreply.github.com';
  assert.ok(isAllowedHistoryIdentity(unknown, owner, owner));
  assert.ok(isAllowedHistoryIdentity(unknown, 'example@users.noreply.github.com', 'noreply@github.com'));
  assert.ok(isAllowedHistoryIdentity(unknown, '49699333+dependabot[bot]@users.noreply.github.com', 'noreply@github.com'));
  assert.ok(isAllowedHistoryIdentity(reviewed, 'reviewed@example.invalid', 'noreply@github.com'));
  assert.ok(!isAllowedHistoryIdentity(unknown, 'reviewed@example.invalid', 'noreply@github.com'));
  assert.ok(!isAllowedHistoryIdentity(reviewed, owner, 'unreviewed@example.invalid'));
  assert.ok(!isAllowedHistoryIdentity(unknown, owner, 'noreply@github.com.example.invalid'));
});

test('release audit still checks future identity and private content across every ref', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'site-dossier-release-audit-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: fixture, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = message => { git('add', '.'); git('commit', '-m', message); };
  try {
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'Release Test');
    git('config', 'user.email', '123+example@users.noreply.github.com');
    fs.writeFileSync(path.join(fixture, 'README.md'), 'Public source\n');
    commit('Safe initial source');
    assert.deepEqual(auditPublicRelease(fixture), []);
    git('config', 'user.email', 'unreviewed@example.invalid');
    assert.ok(auditPublicRelease(fixture).some(error => error.includes('Future commits')));
    git('switch', '-c', 'unreviewed-history');
    fs.writeFileSync(path.join(fixture, 'README.md'), 'Public source changed\n');
    commit('Unreviewed contributor identity');
    git('config', 'user.email', '123+example@users.noreply.github.com');
    git('switch', 'main');
    assert.ok(auditPublicRelease(fixture).some(error => error.includes('unreviewed author or committer')));
    git('switch', '-c', 'private-history');
    fs.writeFileSync(path.join(fixture, 'STATUS.md'), 'Private working notes\n');
    fs.writeFileSync(path.join(fixture, 'README.md'), ['private', 'gmail.com'].join('@'));
    git('add', '.');
    const dirtyErrors = auditPublicRelease(fixture);
    assert.ok(dirtyErrors.some(error => error.includes('still tracked: STATUS.md')));
    assert.ok(dirtyErrors.some(error => error.includes('Publishable files contain personal path or email markers')));
    git('commit', '-m', 'Historical private files');
    git('switch', 'main');
    const historicalErrors = auditPublicRelease(fixture);
    assert.ok(historicalErrors.some(error => error.includes('Release-excluded paths in Git history: STATUS.md')));
    assert.ok(historicalErrors.some(error => error.includes('Publishable files contain personal markers in Git history: README.md')));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function backgroundHarness(shared = {}) {
  const listeners = [];
  const state = shared.state || new Map();
  const captured = [];
  const sentToTabs = [];
  const offscreenWrites = [];
  const notifications = [];
  let onTabRemoved = null;
  let onTabUpdated = null;
  let tabUrl = "https://example.com/one";
  let activeTabId = 4;
  let streamId = 'stream';
  let offscreenResponse = { ok: true, result: { folderName: 'bundle', viewport: 'desktop', merged: false } };
  let tabStopResponse = { ok: true };
  let switchDuringCapture = null;
  const tab = id => ({ id, active: id === activeTabId, windowId: 1, url: tabUrl });
  const chrome = {
    runtime: {
      id: 'test-extension',
      getManifest: () => JSON.parse(read('manifest.json')),
      onMessage: { addListener(fn) { listeners.push(fn); } },
      getURL(value) { return 'chrome-extension://test/' + value; },
      async getContexts() { return [{}]; },
      async sendMessage(message) {
        offscreenWrites.push(message);
        return offscreenResponse;
      },
      lastError: null
    },
    notifications: { create(options) { notifications.push(options); } },
    offscreen: { async createDocument() {} },
    storage: {
      session: {
        async get(key) { return { [key]: state.get(key) }; },
        async set(values) { for (const [key, value] of Object.entries(values)) state.set(key, value); },
        async remove(key) { state.delete(key); }
      }
    },
    tabs: {
      onRemoved: { addListener(fn) { onTabRemoved = fn; } },
      onUpdated: { addListener(fn) { onTabUpdated = fn; } },
      async get(id) { if (id !== 4) throw new Error('tab missing'); return tab(id); },
      async query() { return [tab(activeTabId)]; },
      async sendMessage(id, message) {
        sentToTabs.push({ id, message });
        return message.type === 'STOP_RECORDING' ? tabStopResponse : { ok: true };
      },
      async captureVisibleTab() { captured.push(activeTabId); if (switchDuringCapture !== null) activeTabId = switchDuringCapture; return 'data:image/png;base64,AA=='; }
    },
    scripting: { async executeScript() { return [{}]; }, async insertCSS() {} },
    tabCapture: { getMediaStreamId(_options, callback) { callback(streamId); } }
  };
  vm.runInNewContext(read('background/background.js').replace("import './collector.mjs';", ''), { chrome, console, Date,
    fetch: async () => ({ ok: true, text: async () => read('content/banner.css') }) });
  const send = (message, sender = {}) => new Promise(resolve => {
    for (const listener of listeners) {
      if (listener(message, sender, resolve) === true) return;
    }
    resolve(undefined);
  });
  return {
    send, state, captured, sentToTabs, offscreenWrites, notifications,
    setActiveTab(id) { activeTabId = id; },
    setSwitchDuringCapture(id) { switchDuringCapture = id; },
    setStreamId(id) { streamId = id; },
    setOffscreenResponse(response) { offscreenResponse = response; },
    setTabStopResponse(response) { tabStopResponse = response; },
    removeTab(id) { onTabRemoved(id); },
    updateTab(url) { tabUrl = url; onTabUpdated(4, { status: "loading", url }); }
  };
}

const startMessage = {
  type: 'CAPTURE_START', tabId: 4, url: 'https://example.com/one',
  title: 'Example — design',
  note: 'layout', tags: ['dark'], viewportSize: { width: 1000, height: 800 },
  preferences: { liked_aspects: ['typography', 'motion'], focus: 'Opening', avoid: 'Gradients', intended_use: 'Portfolio' },
  viewportName: 'desktop', mode: 'auto'
};
const fromTab = { tab: { id: 4 } };

test('selection starts without a media stream, survives restart, and cancels without writing files', async () => {
  const shared = { state: new Map() };
  const app = backgroundHarness(shared);
  app.setStreamId(null);
  assert.equal((await app.send({ ...startMessage, kind: 'selection', selectionTool: 'rectangle' })).ok, true);
  assert.equal(app.state.get('capture').phase, 'selecting');
  assert.equal(app.sentToTabs.some(item => item.message.type === 'START_RECORDING'), false);
  assert.equal(app.sentToTabs.find(item => item.message.type === 'START_SELECTION').message.tool, 'rectangle');
  const restarted = backgroundHarness(shared);
  await restarted.send({ type: 'SELECTION_CANCEL' }, { tab: { id: 5 } });
  assert.equal(shared.state.has('capture'), true);
  await restarted.send({ type: 'SELECTION_CANCEL' }, fromTab);
  assert.equal(shared.state.has('capture'), false);
  assert.equal(restarted.offscreenWrites.length, 0);
});

test('selection bundles retain their kind and item notes across a worker restart', async () => {
  const shared = { state: new Map() };
  const app = backgroundHarness(shared);
  await app.send({ ...startMessage, kind: 'selection' });
  const restarted = backgroundHarness(shared);
  const selection = { items: [{ kind: 'element', note: 'Only this icon' }] };
  const mismatch = await restarted.send({ type: 'CAPTURE_BUNDLE_READY' }, fromTab);
  assert.equal(mismatch.ok, false);
  const saved = await restarted.send({ type: 'SELECTION_BUNDLE_READY', selection, screenshot: {} }, fromTab);
  assert.equal(saved.ok, true);
  assert.equal(restarted.offscreenWrites[0].payload.kind, 'selection');
  assert.deepEqual(restarted.offscreenWrites[0].payload.selection, selection);
  assert.equal(shared.state.get('capture').phase, 'selecting');
  const again = await restarted.send({ type: 'SELECTION_BUNDLE_READY', selection, screenshot: {} }, fromTab);
  assert.equal(again.ok, true);
  assert.equal(restarted.offscreenWrites.length, 2);
  assert.equal(shared.state.get('capture').phase, 'selecting');
  await restarted.send({ type: 'SELECTION_CANCEL' }, fromTab);
  assert.equal(shared.state.has('capture'), false);
});

test('failed selection writes keep the session ready to retry', async () => {
  const app = backgroundHarness();
  await app.send({ ...startMessage, kind: 'selection' });
  app.setOffscreenResponse({ ok: false, error: 'Disk unavailable' });
  const result = await app.send({ type: 'SELECTION_BUNDLE_READY' }, fromTab);
  assert.equal(result.ok, false);
  assert.equal(app.notifications.at(-1).title, 'Capture failed');
  assert.equal(app.notifications.at(-1).message, 'Disk unavailable');
  assert.equal(app.state.get('capture').phase, 'selecting');
  await app.send({ type: 'SELECTION_CANCEL' }, fromTab);
  assert.equal(app.state.has('capture'), false);
});

test('navigation during a selection save never revives the old picker session', async () => {
  for (const url of ['https://example.com/two', 'https://example.com/one']) {
    const app = backgroundHarness();
    await app.send({ ...startMessage, kind: 'selection' });
    let release;
    app.setOffscreenResponse(new Promise(resolve => { release = resolve; }));
    const pending = app.send({ type: 'SELECTION_BUNDLE_READY' }, fromTab);
    await new Promise(resolve => setImmediate(resolve));
    const duplicate = await app.send({ type: 'SELECTION_BUNDLE_READY' }, fromTab);
    assert.equal(duplicate.ok, false);
    assert.equal(app.offscreenWrites.length, 1);
    app.updateTab(url);
    await new Promise(resolve => setImmediate(resolve));
    release({ ok: true, result: { folderName: 'bundle', viewport: 'selection-desktop' } });
    assert.equal((await pending).ok, true);
    assert.equal(app.state.has('capture'), false);
  }
});

test('open picker does not expire while the user is choosing another selection', async () => {
  const app = backgroundHarness();
  await app.send({ ...startMessage, kind: 'selection' });
  app.state.get('capture').startedAt = new Date(Date.now() - 3600000).toISOString();
  assert.equal((await app.send(startMessage)).ok, false);
  assert.equal(app.state.get('capture').kind, 'selection');
});

test('selected browser animations freeze without starting paused or unrelated animations', () => {
  const child = { contains: other => other === child };
  const parent = { contains: other => other === parent || other === child };
  const outside = { contains: other => other === outside };
  const animation = (target, playState = 'running') => ({ effect: { target }, playState, currentTime: 123,
    pauses: 0, plays: 0, pause() { this.pauses++; this.playState = 'paused'; },
    play() { this.plays++; this.playState = 'running'; } });
  const entries = [animation(parent), animation(child), animation(child, 'paused'), animation(outside)];
  const win = {};
  const source = read('content/selection.js').replace(/\}\)\(\);\s*$/, 'window.auditAnimations = syncAnimations; })();');
  vm.runInNewContext(source, { window: win, document: { getAnimations: () => entries }, chrome: { runtime: { onMessage: { addListener() {} } } } });
  win.auditAnimations([child]);
  assert.deepEqual(entries.map(a => a.pauses), [1, 1, 0, 0]);
  win.auditAnimations([child]);
  assert.deepEqual(entries.map(a => a.pauses), [1, 1, 0, 0]);
  assert.equal(entries[0].currentTime, 123);
  win.auditAnimations([]);
  assert.deepEqual(entries.map(a => a.plays), [1, 1, 0, 0]);
  assert.equal(entries[2].playState, 'paused');
});

test('selection crop coordinates follow actual screenshot scale and reject clipping', () => {
  for (const scale of [1, 1.25, 2]) {
    const rect = captureMath.pixelBounds({ x: 10, y: 20, width: 100, height: 80 }, { width: 1000, height: 800 }, { width: 1000 * scale, height: 800 * scale });
    assert.equal(rect.x, Math.floor(10 * scale));
    assert.equal(rect.width, Math.ceil(110 * scale) - Math.floor(10 * scale));
    assert.equal(rect.height, 80 * scale);
  }
  for (const bounds of [{ x: -1, y: 0, width: 10, height: 10 }, { x: 999, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: NaN, height: 10 }, { x: 0, y: 0, width: 0, height: 10 }]) {
    assert.throws(() => captureMath.pixelBounds(bounds, { width: 1000, height: 800 }, { width: 2000, height: 1600 }));
  }
});

test('visible thin SVG strokes remain capturable even with zero geometric width or height', () => {
  const win = {};
  const source = read('content/selection.js').replace(/\}\)\(\);\s*$/, 'window.auditRect = rectOf; })();');
  vm.runInNewContext(source, { window: win, chrome: { runtime: { onMessage: { addListener() {} } } },
    getComputedStyle: element => element.style });
  const element = { isConnected: true, getBoundingClientRect: () => ({ x: 100, y: 200, width: 0, height: 50 }),
    getScreenCTM: () => ({ a: 2, b: 0, c: 0, d: 2 }),
    style: { stroke: '#000', strokeOpacity: '1', strokeWidth: '2px', vectorEffect: 'none' } };
  const bounds = () => JSON.parse(JSON.stringify(win.auditRect({ kind: 'element', element })));
  assert.deepEqual(bounds(), { x: 98, y: 200, width: 4, height: 50 });
  assert.equal(captureMath.pixelBounds(bounds(), { width: 500, height: 500 }, { width: 1000, height: 1000 }).width, 8);
  element.style.vectorEffect = 'non-scaling-stroke';
  assert.equal(bounds().width, 2);
  element.getBoundingClientRect = () => ({ x: 100, y: 200, width: 50, height: 0 });
  assert.deepEqual(bounds(), { x: 100, y: 199, width: 50, height: 2 });
  element.style.stroke = 'none';
  assert.equal(bounds().height, 0, 'invisible geometry remains invalid');
  element.isConnected = false;
  assert.equal(win.auditRect({ kind: 'element', element }), null);
});

test('bounded visual sampling includes the opening and final useful state', () => {
  const indices = Array.from(captureMath.sampleIndices(100, 24));
  assert.equal(indices.length, 24);
  assert.equal(indices[0], 0);
  assert.equal(indices.at(-1), 99);
  assert.equal(new Set(indices).size, 24);
  assert.deepEqual(Array.from(captureMath.sampleIndices(2, 24)), [0, 1]);
  const times = Array.from(captureMath.frameTimes(10));
  assert.equal(times[0], 0);
  assert.equal(times.at(-1), 9.9);
  assert.equal(times.length, 9);
  assert.throws(() => captureMath.frameTimes(Infinity));
});

test('typography retains variable-font ranges and does not invent system sources or weight 400', () => {
  class Face {
    style = { getPropertyValue: key => ({ 'font-family': 'Variable', 'font-weight': '100 900', src: 'url("/font.woff2")' })[key] || '' };
  }
  const win = {};
  const observed = [{ fontFamily: 'Variable', fontWeight: '650', fontSize: '40px' },
    { fontFamily: 'Mystery', fontWeight: '300', fontSize: '16px' }];
  const context = { window: win, chrome: { runtime: { onMessage: { addListener() {} } } },
    document: { styleSheets: [{ cssRules: [new Face()] }], querySelectorAll: () => observed, querySelector: () => null },
    CSSFontFaceRule: Face, getComputedStyle: el => el, SiteDossierCapture: captureMath, location: { host: 'example.com' } };
  const source = read('content/content.js').replace(/\}\)\(\);\s*$/, 'window.auditType = extractTypography; })();');
  vm.runInNewContext(source, context);
  const data = JSON.parse(JSON.stringify(win.auditType()));
  const variable = data.fonts.find(font => font.family === 'Variable');
  assert.deepEqual(variable.weight_ranges, [[100, 900]]);
  assert.deepEqual(variable.weights, [650]);
  assert.deepEqual(variable.declared_weights, ['100 900']);
  const unknown = data.fonts.find(font => font.family === 'Mystery');
  assert.deepEqual(unknown.sources, ['unknown']);
  assert.deepEqual(unknown.weights, [300]);
});

test('picked icon structure preserves geometry and marks bounded/truncated observations', () => {
  const win = {};
  const source = read('content/selection.js').replace(/\}\)\(\);\s*$/, 'window.auditStructure = observedStructure; })();');
  vm.runInNewContext(source, { window: win, chrome: { runtime: { onMessage: { addListener() {} } } }, Node: { TEXT_NODE: 3 },
    getComputedStyle: () => ({ getPropertyValue: () => '', content: 'none' }) });
  const element = (tag, attributes = {}, children = []) => ({ localName: tag, children, childNodes: [],
    hasAttribute: key => key in attributes, getAttribute: key => attributes[key] });
  const icon = element('svg', { viewBox: '0 0 80 80' }, [element('circle', { cx: '40', cy: '40', r: '30' })]);
  const data = JSON.parse(JSON.stringify(win.auditStructure(icon)));
  assert.equal(data.nodes[1].attributes.r, '30');
  assert.equal(data.nodes[0].attributes.viewBox, '0 0 80 80');
  assert.equal(data.nodes[1].parent, 0);
  assert.equal(data.truncated, false);
  const large = win.auditStructure(element('div', {}, Array.from({ length: 200 }, () => element('span'))));
  assert.equal(large.nodes.length, 100);
  assert.equal(large.truncated, true);
  const longPath = win.auditStructure(element('path', { d: 'M'.repeat(2000) }));
  assert.equal(longPath.nodes[0].attributes.d.length, 1600);
  assert.equal(longPath.truncated, true);
});

test('syntax, manifest, and required package files', () => {
  for (const file of ['background/background.js', 'background/collector.mjs', 'background/rectangle.mjs', 'sidepanel/sidepanel.mjs', 'shared/library.mjs', 'shared/collector-db.mjs', 'content/content.js', 'content/selection.js', 'shared/capture-math.js', 'popup/popup.js', 'offscreen/offscreen.js', 'offscreen/media.js']) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, '116');
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  assert.ok(!manifest.optional_host_permissions);
  assert.ok(!manifest.permissions.includes('downloads'));
  for (const file of ['manifest.json', 'background/background.js', 'content/content.js', 'content/banner.css',
    'popup/popup.html', 'popup/popup.css', 'popup/popup.js', 'offscreen/offscreen.html',
    'offscreen/offscreen.js', 'reference/SITE-DOSSIER.md', 'reference/use-site-dossier/SKILL.md',
    'content/selection.js', 'content/selection.css', 'shared/capture-math.js', 'offscreen/media.js', 'reference/legacy-entry-v1.md',
    'icons/16.png', 'icons/48.png', 'icons/128.png', 'LICENSE']) {
    assert.ok(fs.existsSync(path.join(root, file)), file);
  }
});

test('start failures reach the popup and clear session state', async () => {
  const app = backgroundHarness();
  app.setStreamId(null);
  const response = await app.send(startMessage);
  assert.equal(response.ok, false);
  assert.match(response.error, /stream ID/);
  assert.equal(app.state.has('capture'), false);
});

test('capture details survive a service worker restart and write failures reach the page', async () => {
  const shared = { state: new Map() };
  const firstWorker = backgroundHarness(shared);
  assert.equal((await firstWorker.send(startMessage)).ok, true);
  const secondWorker = backgroundHarness(shared);
  assert.equal((await secondWorker.send({ type: 'CAPTURE_STATUS' })).capture.phase, 'recording');
  secondWorker.setOffscreenResponse({ ok: false, error: 'disk full' });
  const response = await secondWorker.send({ type: 'CAPTURE_BUNDLE_READY', video: {}, screenshot: {}, html: '', tokens: {} }, fromTab);
  assert.equal(response.ok, false);
  assert.equal(response.error, 'disk full');
  assert.equal(secondWorker.notifications.at(-1).title, 'Capture failed');
  assert.equal(secondWorker.notifications.at(-1).message, 'disk full');
  assert.equal(secondWorker.offscreenWrites[0].payload.note, 'layout');
  assert.equal(secondWorker.offscreenWrites[0].payload.title, startMessage.title);
  assert.deepEqual(secondWorker.offscreenWrites[0].payload.preferences, startMessage.preferences);
  assert.equal(secondWorker.offscreenWrites[0].payload.toolVersion, JSON.parse(read('manifest.json')).version);
  assert.equal(shared.state.has('capture'), false);
});

test('successful bundle reports the saved folder and clears session state', async () => {
  const app = backgroundHarness();
  assert.equal((await app.send(startMessage)).ok, true);
  const response = await app.send({ type: 'CAPTURE_BUNDLE_READY', video: {}, screenshot: {}, html: '', tokens: {} }, fromTab);
  assert.equal(response.ok, true);
  assert.equal(response.result.folderName, 'bundle');
  assert.equal(app.state.has('capture'), false);
});

test('optional preview warnings retain diagnostics without changing successful capture notifications', async () => {
  for (const kind of ['page', 'selection']) {
    const app = backgroundHarness();
    const viewport = kind === 'selection' ? 'selection-desktop' : 'desktop';
    const warnings = ['Video stills unavailable.', 'Page tiles incomplete.', 'Folder reading guide unavailable.'];
    await app.send({ ...startMessage, kind });
    app.setOffscreenResponse({ ok: true, result: { folderName: 'bundle', viewport, merged: true, warnings } });
    const response = await app.send({ type: kind === 'selection' ? 'SELECTION_BUNDLE_READY' : 'CAPTURE_BUNDLE_READY' }, fromTab);
    assert.equal(response.ok, true);
    assert.deepEqual(response.result.warnings, warnings);
    assert.equal(app.notifications.at(-1).title, 'Captured');
    assert.equal(app.notifications.at(-1).message, `Merged into bundle/${viewport}`);
  }
});

test('screenshot request fails if another tab becomes active', async () => {
  const app = backgroundHarness();
  assert.equal((await app.send(startMessage)).ok, true);
  app.setActiveTab(5);
  const response = await app.send({ type: 'CAPTURE_VISIBLE_TAB' }, fromTab);
  assert.match(response.error, /no longer active/);
  assert.equal(app.captured.length, 0);
  app.setActiveTab(4);
  const messagesBeforeScreenshot = app.sentToTabs.length;
  assert.match((await app.send({ type: 'CAPTURE_VISIBLE_TAB' }, fromTab)).dataUrl, /^data:image/);
  assert.equal(app.sentToTabs.length, messagesBeforeScreenshot, 'screenshot must not hide or restore the control');
  app.setSwitchDuringCapture(5);
  assert.match((await app.send({ type: 'CAPTURE_VISIBLE_TAB' }, fromTab)).error, /changed during screenshot/);
});

class FakeDir {
  constructor() { this.kind = 'directory'; this.dirs = new Map(); this.files = new Map(); }
  async *entries() {
    yield* this.dirs.entries();
    for (const name of this.files.keys()) yield [name, { kind: 'file' }];
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    if (this.files.has(name)) throw Object.assign(new Error('file occupies directory name'), { name: 'TypeMismatchError' });
    if (!this.dirs.has(name)) {
      if (!create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      this.dirs.set(name, new FakeDir());
    }
    return this.dirs.get(name);
  }
  async getFileHandle(name, { create = false } = {}) {
    if (this.dirs.has(name)) throw Object.assign(new Error('directory occupies file name'), { name: 'TypeMismatchError' });
    if (!this.files.has(name) && !create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
    if (!this.files.has(name)) this.files.set(name, '');
    return {
      getFile: async () => new Blob([this.files.get(name) || '']),
      createWritable: async () => {
        let contents = '';
        return { write: async blob => { contents = await blob.text(); },
          close: async () => { this.files.set(name, contents); }, abort: async () => {} };
      }
    };
  }
  async removeEntry(name) { this.files.delete(name); }
}

function writerHarness(rootDir = new FakeDir(), assetFetch = async file => new Response(read(file)), overrides = {}) {
  const context = vm.createContext({
    rootDir, Blob, URL, AbortController, SiteDossierCapture: captureMath,
    fetch: url => url.startsWith('reference/') ? assetFetch(url) : fetch(url), setTimeout, clearTimeout,
    generateVideoEvidence: async (_blob, _elapsed, writeFrame) => {
      await writeFrame(new Blob(['frame']), { timestamp_s: 0, time_basis: 'media-timeline', width: 1280, height: 800 });
      return { sheet: new Blob(['sheet']), duration_s: 1, duration_basis: 'media-timeline' };
    },
    document: { getElementById: () => ({ textContent: '' }), createElement: () => { throw new Error('no video decoder in test'); } },
    BroadcastChannel: class { set onmessage(_value) {} },
    // Real offscreen documents expose runtime messaging, but not getManifest.
    chrome: { runtime: { onMessage: { addListener() {} }, getURL: value => value } },
    console: { warn() {}, log() {} }, ...overrides
  });
  vm.runInContext(read('offscreen/offscreen.js'), context);
  vm.runInContext('cachedDirHandle = rootDir', context);
  const writeBundle = vm.runInContext('writeBundle', context);
  return { rootDir, writeBundle };
}

const bundlePayload = (url = 'https://example.com/one') => ({
    url, startedAt: '2026-09-25T12:00:00Z', viewportName: 'desktop',
    toolVersion: JSON.parse(read('manifest.json')).version,
    viewportSize: { width: 1000, height: 800 }, note: 'hello',
    tags: ['x: y', '[nested]'], video: { dataUrl: 'data:video/webm;base64,AA==', durationS: 1, stopReason: 'user' },
    screenshot: { dataUrl: 'data:image/jpeg;base64,AA==', stopReason: 'page-end' }, html: '<html></html>', tokens: {}
  });

test('Auto, later Manual and mobile captures share a page bundle across days and preserve prior context', async () => {
  const { rootDir, writeBundle } = writerHarness();
  const payload = bundlePayload;
  const firstPayload = { ...payload('https://example.com/one'), tokens: { colors: ['#abcdef'] },
    title: 'Example — "设计"', preferences: startMessage.preferences };
  const one = await writeBundle(firstPayload);
  const two = await writeBundle(payload('https://example.com/two'));
  const repeatedPayload = {
    ...payload('https://example.com/one'),
    startedAt: '2026-09-26T15:00:00Z', mode: 'manual',
    note: 'desktop navigation', tags: ['navigation'], tokens: { colors: ['#123456'] },
    preferences: { liked_aspects: ['interactions'], focus: 'Menu only', avoid: '', intended_use: '' }
  };
  const repeat = await writeBundle(repeatedPayload);
  const mobilePayload = {
    ...payload('https://example.com/one'), startedAt: '2026-10-01T10:00:00Z', viewportName: 'mobile', viewportSize: { width: 390, height: 844 },
    note: 'mobile menu', tags: ['mobile', 'menu'], tokens: { colors: ['#fedcba'] }
  };
  const mobile = await writeBundle(mobilePayload);
  assert.equal(one.folderName, 'example-com-2026-09-25');
  assert.equal(two.folderName, 'example-com-2026-09-25-2');
  assert.equal(repeat.folderName, one.folderName);
  assert.equal(repeat.viewport, 'desktop-2');
  assert.equal(mobile.folderName, one.folderName);
  assert.equal(mobile.viewport, 'mobile');
  assert.equal(rootDir.dirs.get(one.folderName).files.get('url.txt').trim(), 'https://example.com/one');
  assert.match(rootDir.dirs.get(one.folderName).files.get('note.md'), /tags: \["x: y","\[nested\]"\]/);
  const saved = rootDir.dirs.get(one.folderName);
  assert.match(saved.dirs.get('desktop-2').files.get('note.md') || '', /desktop navigation/);
  assert.match(saved.dirs.get('desktop-2').files.get('note.md'), /tags: \["navigation"\]/);
  assert.deepEqual(JSON.parse(saved.dirs.get('desktop-2').files.get('tokens.json') || '{}'), repeatedPayload.tokens);
  assert.match(saved.dirs.get('desktop').files.get('note.md') || '', /hello/);
  assert.match(saved.dirs.get('desktop').files.get('note.md'), /tags: \["x: y","\[nested\]"\]/);
  assert.deepEqual(JSON.parse(saved.dirs.get('desktop').files.get('tokens.json')), firstPayload.tokens);
  assert.match(saved.dirs.get('mobile').files.get('note.md') || '', /mobile menu/);
  assert.match(saved.dirs.get('mobile').files.get('note.md'), /tags: \["mobile","menu"\]/);
  assert.deepEqual(JSON.parse(saved.dirs.get('mobile').files.get('tokens.json') || '{}'), mobilePayload.tokens);
  assert.match(saved.files.get('note.md'), /hello/);
  assert.deepEqual(JSON.parse(saved.files.get('tokens.json')), firstPayload.tokens);
  for (const file of ['url.txt', 'note.md', 'tokens.json']) assert.ok(saved.files.has(file), file);
  for (const file of ['scroll.webm', 'page.jpg', 'page.html', 'meta.json']) {
    assert.ok(saved.dirs.get('desktop').files.has(file), file);
  }
  const meta = JSON.parse(saved.dirs.get('desktop').files.get('meta.json'));
  assert.equal(meta.capture_mode, 'auto');
  assert.equal(meta.video.stop_reason, 'user');
  assert.equal(meta.screenshot.stop_reason, 'page-end');
  assert.equal(meta.tool_version, JSON.parse(read('manifest.json')).version);
  assert.equal(meta.schema_version, 2);
  assert.equal(meta.title, firstPayload.title);
  assert.deepEqual(meta.user_preferences, firstPayload.preferences);
  assert.deepEqual(JSON.parse(saved.dirs.get('desktop-2').files.get('meta.json')).user_preferences, repeatedPayload.preferences);
  assert.equal(JSON.parse(saved.dirs.get('desktop-2').files.get('meta.json')).captured_at, repeatedPayload.startedAt);
  assert.equal(JSON.parse(saved.dirs.get('desktop-2').files.get('meta.json')).capture_mode, 'manual');
  assert.equal(JSON.parse(saved.dirs.get('mobile').files.get('meta.json')).captured_at, mobilePayload.startedAt);
  assert.deepEqual(JSON.parse(saved.dirs.get('mobile').files.get('meta.json')).user_preferences.liked_aspects, []);
  assert.match(saved.files.get('note.md'), /liked_aspects: \["typography","motion"\]/);
  assert.deepEqual(Array.from(one.warnings), []);
});

test('historical duplicate bundles append to the earliest dated match without moving old captures', async () => {
  const root = new FakeDir();
  // Deliberately enumerate the newer match first, and include a renamed match.
  for (const name of ['example-com-2026-09-28', 'example-com-2026-09-25-3', 'a-renamed-reference']) {
    const dir = await root.getDirectoryHandle(name, { create: true });
    dir.files.set('url.txt', 'https://example.com/one\n');
    dir.files.set('note.md', `Original ${name}`);
    const desktop = await dir.getDirectoryHandle('desktop', { create: true });
    desktop.files.set('scroll.webm', `Original video ${name}`);
  }
  const { writeBundle } = writerHarness(root);
  const result = await writeBundle({ ...bundlePayload(), startedAt: '2026-10-21T12:00:00Z' });
  assert.equal(result.folderName, 'example-com-2026-09-25-3');
  assert.equal(result.viewport, 'desktop-2');
  assert.equal(result.merged, true);
  for (const name of ['example-com-2026-09-28', 'example-com-2026-09-25-3', 'a-renamed-reference']) {
    const dir = root.dirs.get(name);
    assert.equal(dir.files.get('note.md'), `Original ${name}`);
    assert.equal(dir.dirs.get('desktop').files.get('scroll.webm'), `Original video ${name}`);
  }
  assert.equal(root.dirs.has('example-com-2026-10-21'), false);
  assert.equal(root.dirs.get('example-com-2026-09-28').dirs.size, 1);
  assert.equal(root.dirs.get('a-renamed-reference').dirs.size, 1);
});

test('renamed bundles are found by URL without relying on an in-memory folder cache', async () => {
  const first = writerHarness();
  const saved = await first.writeBundle(bundlePayload());
  const dir = first.rootDir.dirs.get(saved.folderName);
  first.rootDir.dirs.delete(saved.folderName);
  first.rootDir.dirs.set('My reference', dir);
  const restarted = writerHarness(first.rootDir);
  const again = await restarted.writeBundle({ ...bundlePayload(), startedAt: '2026-10-21T12:00:00Z' });
  assert.equal(again.folderName, 'My reference');
  assert.equal(again.viewport, 'desktop-2');
  assert.equal(again.merged, true);
});

test('cross-day bundle lookup keeps different page URLs and destinations separate', async () => {
  const { rootDir, writeBundle } = writerHarness();
  const first = await writeBundle(bundlePayload());
  const folders = new Set([first.folderName]);
  for (const url of ['https://example.com/two', 'https://example.com/one?view=two', 'https://example.com/one#two', 'https://other.example/one']) {
    const result = await writeBundle({ ...bundlePayload(url), startedAt: '2026-10-21T12:00:00Z' });
    assert.equal(result.merged, false);
    assert.equal(folders.has(result.folderName), false);
    folders.add(result.folderName);
    assert.equal(rootDir.dirs.get(result.folderName).files.get('url.txt').trim(), url);
  }
  const otherLibrary = writerHarness();
  const separate = await otherLibrary.writeBundle({ ...bundlePayload(), startedAt: '2026-10-21T12:00:00Z' });
  assert.equal(separate.merged, false);
  assert.equal(separate.folderName, 'example-com-2026-10-21');
  assert.equal(separate.viewport, 'desktop');
});

test('bundle lookup ignores non-bundles without modifying them', async () => {
  const root = new FakeDir();
  root.files.set('README.md', 'My collection');
  const incomplete = await root.getDirectoryHandle('example-com-2026-09-25', { create: true });
  incomplete.files.set('note.md', 'No source URL saved');
  const unrelated = await root.getDirectoryHandle('Other project', { create: true });
  await unrelated.getDirectoryHandle('url.txt', { create: true });
  const result = await writerHarness(root).writeBundle(bundlePayload());
  assert.equal(result.folderName, 'example-com-2026-09-25-2');
  assert.equal(root.files.get('README.md'), 'My collection');
  assert.equal(incomplete.files.get('note.md'), 'No source URL saved');
  assert.equal(incomplete.dirs.size, 0);
  assert.equal(unrelated.files.size, 0);
});

test('library listing and URL-read failures stop before writing a duplicate bundle', async () => {
  for (const failure of ['listing', 'url-read']) {
    const root = new FakeDir();
    const saved = await root.getDirectoryHandle('example-com-2026-09-24', { create: true });
    saved.files.set('url.txt', 'https://example.com/one\n');
    if (failure === 'listing') root.entries = async function* () { throw new Error('Folder unavailable'); };
    else saved.getFileHandle = async () => { throw Object.assign(new Error('Source URL unreadable'), { name: 'NotReadableError' }); };
    await assert.rejects(writerHarness(root).writeBundle(bundlePayload()), /unavailable|unreadable/);
    assert.deepEqual([...root.dirs.keys()], ['example-com-2026-09-24']);
    assert.equal(root.files.size, 0);
    assert.equal(saved.dirs.size, 0);
    assert.equal(saved.files.get('url.txt'), 'https://example.com/one\n');
  }
});

test('folder skill is portable, preserves edited guides and legacy files, and restores a missing guide', async () => {
  const { rootDir, writeBundle } = writerHarness();
  const legacy = await rootDir.getDirectoryHandle('old-reference', { create: true });
  legacy.files.set('note.md', 'Old preference, unchanged.');
  await writeBundle(bundlePayload());
  const skill = rootDir.dirs.get('.site-dossier').dirs.get('skills').dirs.get('use-site-dossier-v2');
  assert.equal(rootDir.files.get('SITE-DOSSIER.md'), read('reference/SITE-DOSSIER.md'));
  assert.equal(skill.files.get('SKILL.md'), read('reference/use-site-dossier/SKILL.md'));
  rootDir.files.set('SITE-DOSSIER.md', 'My edited guide');
  rootDir.files.set('AGENTS.md', 'Existing agent instructions');
  rootDir.files.set('README.md', 'Existing README');
  skill.files.set('SKILL.md', 'My edited skill');
  await writeBundle(bundlePayload());
  assert.equal(rootDir.files.get('SITE-DOSSIER.md'), 'My edited guide');
  assert.equal(skill.files.get('SKILL.md'), 'My edited skill');
  assert.equal(rootDir.files.get('AGENTS.md'), 'Existing agent instructions');
  assert.equal(rootDir.files.get('README.md'), 'Existing README');
  assert.equal(legacy.files.get('note.md'), 'Old preference, unchanged.');
  skill.files.delete('SKILL.md');
  await writeBundle(bundlePayload());
  assert.equal(skill.files.get('SKILL.md'), read('reference/use-site-dossier/SKILL.md'));
  assert.equal(rootDir.files.get('SITE-DOSSIER.md'), 'My edited guide');
});

test('notes preserve exact text and safely encode quotes, newlines, and non-English preferences', async () => {
  const { rootDir, writeBundle } = writerHarness();
  const preferences = { liked_aspects: ['colors', 'typography'], focus: 'Заголовок: "Привіт"\n---\nnext',
    avoid: '  No `code`, ${interpolation}, or <script> tags\n', intended_use: '设计 / портфоліо' };
  const note = '  Keep leading space\n---\n# My note\n';
  const result = await writeBundle({ ...bundlePayload(), note, preferences });
  const dir = rootDir.dirs.get(result.folderName).dirs.get(result.viewport);
  const markdown = dir.files.get('note.md');
  const [frontmatter, body] = markdown.slice(4).split('\n---\n\n');
  assert.equal(body, note + '\n');
  const fields = Object.fromEntries(frontmatter.split('\n').map(line => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon), JSON.parse(line.slice(colon + 1))];
  }));
  for (const [key, value] of Object.entries(preferences)) assert.deepEqual(fields[key], value);
  assert.deepEqual(JSON.parse(dir.files.get('meta.json')).user_preferences, preferences);
});

test('missing and malformed preferences remain unspecified and unknown aspects are filtered', async () => {
  const { rootDir, writeBundle } = writerHarness();
  for (const preferences of [undefined, null, { liked_aspects: 'colors', focus: 4 },
    { liked_aspects: ['colors', 'invented', 'colors'], avoid: [] }]) {
    const result = await writeBundle({ ...bundlePayload(), note: '', tags: [], preferences });
    const dir = rootDir.dirs.get(result.folderName).dirs.get(result.viewport);
    const saved = JSON.parse(dir.files.get('meta.json'));
    assert.deepEqual(saved.user_preferences, {
      liked_aspects: Array.isArray(preferences?.liked_aspects) ? ['colors'] : [], focus: '', avoid: '', intended_use: ''
    });
    assert.match(dir.files.get('note.md'), /\n---\n\n\n$/);
  }
});

test('guide asset failure reports a warning, retains capture metadata, and retries on next capture', async () => {
  const rootDir = new FakeDir();
  let fail = true;
  const { writeBundle } = writerHarness(rootDir, async file => fail ? new Response('missing', { status: 404 }) : new Response(read(file)));
  const first = await writeBundle(bundlePayload());
  assert.equal(first.warnings.length, 1);
  assert.equal(rootDir.files.has('SITE-DOSSIER.md'), false, 'entry must not point at missing skill');
  assert.ok(rootDir.dirs.get(first.folderName).dirs.get(first.viewport).files.has('meta.json'));
  fail = false;
  const second = await writeBundle(bundlePayload());
  assert.equal(second.warnings.length, 0);
  assert.ok(rootDir.files.has('SITE-DOSSIER.md'));
});

test('directory conflicts in guidance do not turn a saved capture into a failure', async () => {
  const rootDir = new FakeDir();
  rootDir.files.set('.site-dossier', 'Existing user file');
  const { writeBundle } = writerHarness(rootDir);
  const result = await writeBundle(bundlePayload());
  assert.equal(result.warnings.length, 1);
  assert.ok(rootDir.dirs.get(result.folderName).dirs.get(result.viewport).files.has('note.md'));
  assert.equal(rootDir.files.get('.site-dossier'), 'Existing user file');
});

test('failed first guide write removes its empty placeholder so a later save can retry', async () => {
  const { rootDir, writeBundle } = writerHarness();
  const original = rootDir.getFileHandle.bind(rootDir);
  rootDir.getFileHandle = async (name, options) => {
    const handle = await original(name, options);
    if (name === 'SITE-DOSSIER.md') handle.createWritable = async () => { throw new Error('disk full'); };
    return handle;
  };
  const first = await writeBundle(bundlePayload());
  assert.equal(first.warnings.length, 1);
  assert.equal(rootDir.files.has('SITE-DOSSIER.md'), false);
  rootDir.getFileHandle = original;
  const second = await writeBundle(bundlePayload());
  assert.equal(second.warnings.length, 0);
  assert.equal(rootDir.files.get('SITE-DOSSIER.md'), read('reference/SITE-DOSSIER.md'));
});

test('an existing empty guide is preserved and reported rather than silently accepted', async () => {
  const { rootDir, writeBundle } = writerHarness();
  rootDir.files.set('SITE-DOSSIER.md', '');
  const result = await writeBundle(bundlePayload());
  assert.equal(result.warnings.length, 1);
  assert.equal(rootDir.files.get('SITE-DOSSIER.md'), '');
});

test('unchanged v1 entries upgrade to the new reader while custom entries stay intact', async () => {
  const { rootDir, writeBundle } = writerHarness();
  rootDir.files.set('SITE-DOSSIER.md', read('reference/legacy-entry-v1.md'));
  await writeBundle(bundlePayload());
  assert.equal(rootDir.files.get('SITE-DOSSIER.md'), read('reference/SITE-DOSSIER.md'));
  rootDir.files.set('SITE-DOSSIER.md', read('reference/legacy-entry-v1.md') + '\nMy changes');
  await writeBundle(bundlePayload());
  assert.match(rootDir.files.get('SITE-DOSSIER.md'), /My changes$/);
  assert.ok(rootDir.dirs.get('.site-dossier').dirs.get('skills').dirs.get('use-site-dossier-v2').files.has('SKILL.md'));
});

test('page tiles save readable files and their actual document positions without changing the overview', async () => {
  const { rootDir, writeBundle } = writerHarness();
  const payload = bundlePayload();
  payload.screenshot.evidence = { overview_px: { width: 1000, height: 16384 }, scale_px_per_css_px: 0.5,
    position_basis: 'document-scroll', total_slices: 30, omitted_tiles: 29, tiles: [
      { dataUrl: 'data:image/jpeg;base64,AA==', x: 0, y: 2500, css_width: 1000, css_height: 800, width: 1280, height: 1024, source_slice: 4 }
    ] };
  const result = await writeBundle(payload);
  const dir = rootDir.dirs.get(result.folderName).dirs.get(result.viewport);
  const index = JSON.parse(dir.dirs.get('page-tiles').files.get('index.json'));
  assert.equal(index.tiles[0].y, 2500);
  assert.equal(index.tiles[0].file, 'tile-001.jpg');
  assert.equal(index.tiles[0].dataUrl, undefined);
  assert.ok(dir.files.has('page.jpg'));
  const meta = JSON.parse(dir.files.get('meta.json'));
  assert.equal(meta.screenshot.tiles_file, 'page-tiles/index.json');
  assert.equal(meta.screenshot.tiles_saved, 1);
  assert.equal(meta.screenshot.omitted_tiles, 29);
  assert.equal(index.omitted_tiles, 29);
  assert.deepEqual(Array.from(result.warnings), [], 'expected sampling must not report a failed or incomplete save');
});

test('readable tile write failures still warn and preserve the overview', async () => {
  const { rootDir, writeBundle } = writerHarness();
  const first = await writeBundle(bundlePayload());
  const bundle = rootDir.dirs.get(first.folderName);
  const repeat = await bundle.getDirectoryHandle('desktop-2', { create: true });
  const tiles = await repeat.getDirectoryHandle('page-tiles', { create: true });
  tiles.getFileHandle = async () => { throw new Error('disk full'); };
  // Reuse the prepared viewport in this fixture to simulate the write failure.
  const original = bundle.getDirectoryHandle.bind(bundle);
  bundle.getDirectoryHandle = async (name, options) => {
    if (name === 'desktop-2' && !options?.create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
    return original(name, options);
  };
  const payload = bundlePayload();
  payload.screenshot.evidence = { total_slices: 1, omitted_tiles: 0, tiles: [{ dataUrl: 'data:image/jpeg;base64,AA==' }] };
  const result = await writeBundle(payload);
  assert.match(result.warnings[0], /could not be saved/);
  assert.ok(repeat.files.has('page.jpg'));
  assert.equal(JSON.parse(repeat.files.get('meta.json')).screenshot.tiles_saved, 0);
});

test('partial video decoding keeps recorded video and indexes frames that were saved', async () => {
  const { rootDir, writeBundle } = writerHarness(new FakeDir(), undefined, {
    generateVideoEvidence: async (_blob, _elapsed, writeFrame) => {
      await writeFrame(new Blob(['frame']), { timestamp_s: 0, time_basis: 'recording-elapsed-estimate' });
      throw new Error('decoder stopped');
    }
  });
  const result = await writeBundle(bundlePayload());
  const dir = rootDir.dirs.get(result.folderName).dirs.get(result.viewport);
  assert.ok(dir.files.has('scroll.webm'));
  const meta = JSON.parse(dir.files.get('meta.json'));
  assert.equal(meta.video.frames_sampled, 1);
  assert.equal(meta.video.frames_file, 'video-frames/index.json');
  assert.equal(meta.video.contact_sheet, null);
  const frames = JSON.parse(dir.dirs.get('video-frames').files.get('index.json')).frames;
  assert.equal(frames[0].timestamp_s, 0);
  assert.match(result.warnings[0], /stills are incomplete/);
});

test('selection bundles save item context and scaled crops, stay separate from page captures, and omit invented structure for rectangles', async () => {
  const cropCalls = [];
  const { rootDir, writeBundle } = writerHarness(new FakeDir(), undefined, {
    decodeImage: async () => ({ naturalWidth: 2000, naturalHeight: 1600 }),
    canvasBlob: async () => new Blob(['image']),
    document: { getElementById: () => ({}), createElement: () => ({ width: 0, height: 0,
      getContext: () => ({ drawImage: (...args) => cropCalls.push(args.slice(1)) }) }) }
  });
  const payload = { ...bundlePayload(), kind: 'selection', selection: { captured_at: '2026-09-25T12:01:00Z',
    viewport: { width: 1000, height: 800, scroll_y: 400 }, items: [
      { kind: 'element', bounds: { x: 10, y: 20, width: 100, height: 80 }, note: 'Icon only — Привіт', structure: { nodes: [{ tag: 'svg' }] } },
      { kind: 'rectangle', bounds: { x: 200, y: 200, width: 250, height: 100 }, note: 'These colors' }
    ] } };
  const one = await writeBundle(payload);
  const repeat = await writeBundle({ ...payload, startedAt: '2026-09-26T12:00:00Z' });
  const page = await writeBundle({ ...bundlePayload(), startedAt: '2026-10-21T12:00:00Z' });
  assert.equal(one.viewport, 'selection-desktop');
  assert.equal(repeat.viewport, 'selection-desktop-2');
  assert.equal(page.viewport, 'desktop');
  assert.equal(repeat.folderName, one.folderName);
  assert.equal(page.folderName, one.folderName);
  const dir = rootDir.dirs.get(one.folderName).dirs.get(one.viewport);
  assert.deepEqual(cropCalls[0], [20, 40, 200, 160, 0, 0, 200, 160]);
  const items = JSON.parse(dir.files.get('selections.json')).items;
  assert.equal(items[0].note, payload.selection.items[0].note);
  assert.equal(items[0].structure_file, 'selection-01.json');
  assert.equal(items[1].structure_file, undefined);
  assert.equal(dir.files.has('scroll.webm'), false);
  assert.ok(dir.files.has('context.jpg'));
  assert.equal(JSON.parse(dir.files.get('meta.json')).capture_kind, 'selection');
});

test('invalid or clipped selections fail before creating output folders', async () => {
  const { rootDir, writeBundle } = writerHarness();
  for (const items of [[], [{ kind: 'element', bounds: { x: -20, y: 0, width: 100, height: 100 } }], Array(9).fill({})]) {
    await assert.rejects(writeBundle({ ...bundlePayload(), kind: 'selection', selection: { viewport: { width: 100, height: 100 }, items } }));
  }
  assert.equal(rootDir.dirs.size, 0);
});

test('last screenshot tile uses actual clamped scroll position', async () => {
  const drawings = [];
  const canvas = {
    width: 0, height: 0,
    getContext() { return { drawImage(_img, x, y) { drawings.push({ x, y }); } }; },
    toDataURL() { return 'data:image/jpeg;base64,AA=='; }
  };
  const win = {
    innerWidth: 1000, innerHeight: 1000, devicePixelRatio: 1,
    scrollX: 0, scrollY: 0,
    scrollTo(x, y) {
      this.scrollX = Math.max(0, Math.min(x, 1500));
      this.scrollY = Math.max(0, Math.min(y, 1500));
    }
  };
  const doc = {
    documentElement: { scrollWidth: 2500, scrollHeight: 2500 },
    body: { scrollWidth: 2500, scrollHeight: 2500 },
    createElement: () => !canvas.width ? canvas : { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: canvas.toDataURL }
  };
  class FakeImage {
    naturalWidth = 1000; naturalHeight = 1000;
    set src(_value) { queueMicrotask(() => this.onload()); }
  }
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(_message, callback) { callback({ dataUrl: 'data:image/png;base64,AA==' }); },
      lastError: null
    }
  };
  const context = vm.createContext({
    window: win, document: doc, chrome, Image: FakeImage, SiteDossierCapture: captureMath,
    setTimeout: callback => queueMicrotask(callback),
    console: { log() {}, warn() {} }, Date, Math
  });
  const source = read('content/content.js').replace(/\}\)\(\);\s*$/, '  window.auditCapture = captureFullPagePng;' + String.fromCharCode(10) + '})();');
  vm.runInContext(source, context);
  await win.auditCapture({ chunkPause: 0, timeBudgetMs: 1000 });
  assert.equal(canvas.width, 2500);
  assert.equal(canvas.height, 2500);
  assert.deepEqual([...new Set(drawings.map(item => item.x))], [0, 1000, 1500]);
  assert.deepEqual([...new Set(drawings.map(item => item.y))], [0, 1000, 1500]);
});

async function popupHarness({ tabUrl = 'https://example.com/one', savedHandle = null, activeCapture = null,
  startResponse = { ok: true }, stopResponse = { ok: true }, statusGate = null, waitForReady = true,
  sharedConfig = null, pickerError = null, storeError = null, sharedDrafts = null,
  draftReadError = null, draftWriteError = null, draftReadGate = null } = {}) {
  const elements = new Map();
  const messages = [];
  const pickerOptions = [];
  const createdTabs = [];
  let closed = false;
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        textContent: '', dataset: {}, attributes: {}, disabled: false, hidden: false, value: '', open: false, checked: false,
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(type, callback) { this[type] = callback; }
      });
    }
    return elements.get(id);
  };
  const config = sharedConfig || new Map(savedHandle ? [['inspoDirHandle', savedHandle]] : []);
  const drafts = sharedDrafts || new Map();
  const db = {
    transaction() {
      const tx = {
        objectStore() {
          return {
            get(key) {
              const req = {};
              queueMicrotask(() => { req.result = config.get(key); req.onsuccess(); });
              return req;
            },
            put(value, key) {
              if (storeError) { queueMicrotask(() => { tx.error = storeError; tx.onerror(); }); return; }
              config.set(key, value);
              queueMicrotask(() => tx.oncomplete());
            }
          };
        }
      };
      return tx;
    }
  };
  const context = {
    document: { documentElement: { dataset: {} }, getElementById: element },
    indexedDB: {
      open() {
        const req = {};
        queueMicrotask(() => { req.result = db; req.onsuccess(); });
        return req;
      }
    },
    chrome: {
      storage: { local: {
        async get(key) {
          if (draftReadGate) await draftReadGate;
          if (draftReadError) throw draftReadError;
          return { [key]: drafts.get(key) };
        },
        async set(values) {
          if (draftWriteError) throw draftWriteError;
          for (const [key, value] of Object.entries(values)) drafts.set(key, JSON.parse(JSON.stringify(value)));
        }
      } },
      tabs: {
        async query() { return [{ id: 4, url: tabUrl, title: 'Example design', width: 1200, height: 800 }]; },
        async create(options) { createdTabs.push(options); return { id: 9 }; }
      },
      runtime: {
        getURL: value => 'chrome-extension://test/' + value,
        async sendMessage(message) {
          messages.push(message);
          if (message.type === 'CAPTURE_STATUS') {
            if (statusGate) await statusGate;
            return { ok: true, capture: activeCapture };
          }
          if (message.type === 'CAPTURE_START') return startResponse;
          if (message.type === 'CAPTURE_STOP') return stopResponse;
          return { ok: true };
        }
      }
    },
    window: {
      location: { href: 'chrome-extension://test/popup/popup.html' },
      async showDirectoryPicker(options) { pickerOptions.push(options); if (pickerError) throw pickerError; return savedHandle || handle; },
      close() { closed = true; }
    },
    BroadcastChannel: class {
      postMessage() { queueMicrotask(() => this.onmessage({ data: { type: 'ACK' } })); }
      close() {}
    },
    URL, setTimeout, clearTimeout
  };
  const handle = {
    name: 'Design references',
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; }
  };
  await vm.runInNewContext(`(async () => { ${read('popup/popup.js')} })()`, context);
  if (waitForReady) await new Promise(resolve => setImmediate(resolve));
  return { element, messages, pickerOptions, createdTabs, config, drafts, document: context.document,
    setDraftWriteError(error) { draftWriteError = error; }, get closed() { return closed; } };
}

test('popup restores the full page draft after closing before capture', async () => {
  const first = await popupHarness();
  first.element('note').value = '  Привіт — soft gradients\nKeep the spacing.  ';
  await first.element('note').input();
  first.element('tags').value = 'gradients,  portfolio, ';
  await first.element('tags').input();
  for (const aspect of ['colors', 'spacing']) {
    first.element(`like-${aspect}`).checked = true;
    await first.element(`like-${aspect}`).change();
  }
  for (const id of ['mode-manual', 'kind-selection', 'selection-rectangle']) {
    first.element(id).checked = true;
    first.element(id).change();
  }
  first.element('note-fields').open = true;
  await first.element('note-fields').toggle();
  const reopened = await popupHarness({ sharedDrafts: first.drafts });
  for (const id of ['note', 'tags']) assert.equal(reopened.element(id).value, first.element(id).value);
  for (const id of ['like-colors', 'like-spacing', 'mode-manual', 'kind-selection', 'selection-rectangle']) {
    assert.equal(reopened.element(id).checked, true, id);
  }
  for (const id of ['like-motion', 'mode-auto', 'kind-page', 'selection-elements']) assert.equal(reopened.element(id).checked, false, id);
  assert.equal(reopened.element('note-fields').open, true);
  assert.equal(reopened.element('start').textContent, 'Draw a rectangle');
  assert.equal(first.messages.some(message => message.type === 'CAPTURE_START'), false);
});

test('popup drafts stay separate across tabs, page paths, queries and fragments', async () => {
  const first = await popupHarness();
  first.element('note').value = 'First page only';
  await first.element('note').input();
  for (const tabUrl of ['https://other.example/', 'https://example.com/two', 'https://example.com/one?view=two', 'https://example.com/one#two']) {
    const other = await popupHarness({ tabUrl, sharedDrafts: first.drafts });
    assert.equal(other.element('note').value, '');
    other.element('note').value = 'A different page';
    await other.element('note').input();
  }
  const returned = await popupHarness({ sharedDrafts: first.drafts });
  assert.equal(returned.element('note').value, 'First page only');
});

test('popup saves the last keystroke immediately and preserves cleared fields', async () => {
  const first = await popupHarness();
  first.element('note').value = 'Old';
  void first.element('note').input();
  first.element('note').value = 'Latest';
  void first.element('note').input();
  const reopened = await popupHarness({ sharedDrafts: first.drafts });
  assert.equal(reopened.element('note').value, 'Latest');
  reopened.element('note').value = '';
  await reopened.element('note').input();
  reopened.element('like-colors').checked = true;
  await reopened.element('like-colors').change();
  reopened.element('like-colors').checked = false;
  await reopened.element('like-colors').change();
  const cleared = await popupHarness({ sharedDrafts: first.drafts });
  assert.equal(cleared.element('note').value, '');
  assert.equal(cleared.element('like-colors').checked, false);
});

test('popup waits for draft restoration before enabling editing', async () => {
  let release;
  const draftReadGate = new Promise(resolve => { release = resolve; });
  const popup = await popupHarness({ draftReadGate, waitForReady: false,
    sharedDrafts: new Map([['capture-draft:https://example.com/one', { schema_version: 1, note: 'Remembered' }]]) });
  assert.equal(popup.element('note').disabled, true);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(popup.element('note').disabled, false);
  assert.equal(popup.element('note').value, 'Remembered');
});

test('draft storage failures stay visible without losing the current form or blocking capture', async () => {
  const readFailed = await popupHarness({ draftReadError: new Error('Unavailable') });
  assert.match(readFailed.element('message').textContent, /Could not restore/);
  assert.equal(readFailed.element('note').disabled, false);
  const popup = await popupHarness({ draftWriteError: new Error('Full'),
    savedHandle: { name: 'Refs', async queryPermission() { return 'granted'; } } });
  popup.element('note').value = 'Keep this note';
  await popup.element('note').input();
  assert.match(popup.element('message').textContent, /Could not keep this form/);
  assert.equal(popup.element('note').value, 'Keep this note');
  await popup.element('start').click();
  assert.equal(popup.closed, true);
  assert.equal(popup.messages.find(message => message.type === 'CAPTURE_START').note, 'Keep this note');
  popup.setDraftWriteError(null);
  await popup.element('note').input();
  assert.equal(popup.element('message').hidden, true);
});

test('folder choice stays in the popup, preserves context, and persists for the next popup', async () => {
  let popup = await popupHarness();
  assert.equal(popup.element('start').disabled, true);
  assert.equal(popup.element('state-badge').textContent, 'Select folder');
  popup.element('note').value = '  strong type  ';
  popup.element('tags').value = 'scroll-driven, storytelling';
  popup.element('like-motion').checked = true;
  await popup.element('pick-dir').click();
  assert.equal(popup.closed, false);
  assert.equal(popup.createdTabs.length, 0);
  assert.equal(popup.pickerOptions[0].startIn, 'downloads');
  assert.equal(popup.pickerOptions[0].id, 'site-dossier-local');
  assert.equal(popup.pickerOptions[0].mode, 'readwrite');
  assert.equal(popup.element('folder-name').textContent, 'Design references');
  assert.equal(popup.element('start').disabled, false);
  assert.equal(popup.element('note').value, '  strong type  ');
  assert.equal(popup.element('like-motion').checked, true);
  await popup.element('start').click();
  assert.equal(popup.closed, true);
  const start = popup.messages.find(message => message.type === 'CAPTURE_START');
  assert.equal(start.note, '  strong type  ');
  assert.deepEqual(Array.from(start.tags), ['scroll-driven', 'storytelling']);
  assert.deepEqual(Array.from(start.preferences.liked_aspects), ['motion']);
  popup = await popupHarness({ sharedConfig: popup.config });
  assert.equal(popup.element('folder-name').textContent, 'Design references');
  assert.equal(popup.element('start').disabled, false);
  assert.equal(popup.element('state-badge').hidden, true);
});

test('popup sends optional taste context and title without carrying choices to another page', async () => {
  const handle = { name: 'References', async queryPermission() { return 'granted'; } };
  const first = await popupHarness({ savedHandle: handle });
  for (const aspect of ['colors', 'typography', 'layout', 'spacing', 'imagery', 'motion', 'interactions', 'details']) {
    assert.ok(!first.element(`like-${aspect}`).checked);
    assert.equal(first.element(`like-${aspect}`).disabled, false);
  }
  first.element('like-colors').checked = true;
  first.element('like-motion').checked = true;
  first.element('note').value = '  Intro "Привіт" — Studio project\nSkip the footer. Keep the hero.  ';
  first.element('tags').value = 'portfolio, studio refresh';
  await first.element('start').click();
  const sent = first.messages.find(message => message.type === 'CAPTURE_START');
  assert.equal(sent.title, 'Example design');
  assert.deepEqual(JSON.parse(JSON.stringify(sent.preferences)), { liked_aspects: ['colors', 'motion'] });
  assert.equal(sent.note, '  Intro "Привіт" — Studio project\nSkip the footer. Keep the hero.  ');
  assert.deepEqual(Array.from(sent.tags), ['portfolio', 'studio refresh']);
  const next = await popupHarness({ tabUrl: 'https://other.example/', sharedConfig: first.config, sharedDrafts: first.drafts });
  await next.element('start').click();
  const blank = next.messages.find(message => message.type === 'CAPTURE_START');
  assert.deepEqual(JSON.parse(JSON.stringify(blank.preferences)), { liked_aspects: [] });
  assert.equal(blank.note, '');
  const returned = await popupHarness({ sharedConfig: first.config, sharedDrafts: first.drafts });
  assert.equal(returned.element('note').value, sent.note);
  assert.equal(returned.element('like-colors').checked, true);
});

test('taste inputs disable during capture and retain values on start failure', async () => {
  const active = await popupHarness({ activeCapture: { tabId: 4, phase: 'recording' } });
  for (const id of ['like-colors', 'like-details', 'note', 'tags']) assert.equal(active.element(id).disabled, true);
  const popup = await popupHarness({ savedHandle: { name: 'Refs', async queryPermission() { return 'granted'; } },
    startResponse: { ok: false, error: 'test failure' } });
  popup.element('like-layout').checked = true;
  popup.element('note').value = 'No shadows';
  await popup.element('start').click();
  assert.equal(popup.closed, false);
  assert.equal(popup.element('like-layout').checked, true);
  assert.equal(popup.element('note').value, 'No shadows');
  assert.equal(popup.element('note').disabled, false);
  const reopened = await popupHarness({ sharedDrafts: popup.drafts });
  assert.equal(reopened.element('note').value, 'No shadows');
  assert.equal(reopened.element('like-layout').checked, true);
});

test('completed Auto capture retains the form for a later Manual pass', async () => {
  const auto = await popupHarness({ savedHandle: { name: 'Refs', async queryPermission() { return 'granted'; } } });
  auto.element('note').value = 'Use the gradient and spacing';
  auto.element('tags').value = 'scroll-driven, portfolio';
  auto.element('like-colors').checked = true;
  auto.element('like-spacing').checked = true;
  await auto.element('start').click();
  const first = auto.messages.find(message => message.type === 'CAPTURE_START');
  assert.equal(first.mode, 'auto');
  // Reopen after the background reports no active capture.
  const manual = await popupHarness({ sharedConfig: auto.config, sharedDrafts: auto.drafts, activeCapture: null });
  assert.equal(manual.element('note').value, first.note);
  assert.equal(manual.element('like-colors').checked, true);
  manual.element('mode-manual').checked = true;
  manual.element('mode-auto').checked = false;
  manual.element('mode-manual').change();
  await manual.element('start').click();
  const next = manual.messages.find(message => message.type === 'CAPTURE_START');
  assert.equal(next.mode, 'manual');
  assert.equal(next.note, first.note);
  assert.deepEqual(Array.from(next.tags), Array.from(first.tags));
  assert.deepEqual(JSON.parse(JSON.stringify(next.preferences)), JSON.parse(JSON.stringify(first.preferences)));
});

test('popup switches between Page and Selection without dropping taste context, and cancels an active picker', async () => {
  const handle = { name: 'References', async queryPermission() { return 'granted'; } };
  const popup = await popupHarness({ savedHandle: handle });
  popup.element('kind-selection').checked = true;
  popup.element('kind-selection').change();
  assert.equal(popup.element('page-mode').hidden, true);
  assert.equal(popup.element('selection-mode').hidden, false);
  popup.element('selection-rectangle').checked = true;
  popup.element('selection-rectangle').change();
  assert.equal(popup.element('start').textContent, 'Draw a rectangle');
  popup.element('like-layout').checked = true;
  await popup.element('start').click();
  const message = popup.messages.find(item => item.type === 'CAPTURE_START');
  assert.equal(message.kind, 'selection');
  assert.equal(message.selectionTool, 'rectangle');
  assert.deepEqual(Array.from(message.preferences.liked_aspects), ['layout']);
  const active = await popupHarness({ savedHandle: handle, activeCapture: { tabId: 4, kind: 'selection', phase: 'selecting' } });
  assert.equal(active.element('stop').textContent, 'Close selection');
  assert.equal(active.element('stop').hidden, false);
  await active.element('stop').click();
  assert.equal(active.element('start').hidden, false);
});

test('cancelled folder choice preserves the existing destination and remains usable', async () => {
  const handle = { name: 'Existing folder', async queryPermission() { return 'granted'; } };
  const setup = await popupHarness({ savedHandle: handle,
    pickerError: Object.assign(new Error('Cancelled'), { name: 'AbortError' }) });
  await setup.element('pick-dir').click();
  assert.equal(setup.config.get('inspoDirHandle'), handle);
  assert.equal(setup.element('folder-name').textContent, 'Existing folder');
  assert.equal(setup.element('pick-dir').disabled, false);
  assert.equal(setup.element('message').hidden, true);
  assert.equal(setup.closed, false);
});

test('popup stays open when storing the chosen folder fails', async () => {
  const setup = await popupHarness({ storeError: new Error('Storage unavailable') });
  await setup.element('pick-dir').click();
  assert.equal(setup.closed, false);
  assert.equal(setup.config.has('inspoDirHandle'), false);
  assert.equal(setup.element('pick-dir').disabled, false);
  assert.match(setup.element('message').textContent, /Storage unavailable/);
});

test('folder picker failure stays visible in the popup', async () => {
  const popup = await popupHarness({ pickerError: new Error('Picker unavailable') });
  await popup.element('pick-dir').click();
  assert.equal(popup.closed, false);
  assert.match(popup.element('message').textContent, /Picker unavailable/);
  assert.equal(popup.element('pick-dir').disabled, false);
});

test('popup blocks restricted pages and concurrent captures', async () => {
  const restricted = await popupHarness({ tabUrl: 'chrome://extensions/' });
  assert.equal(restricted.element('start').disabled, true);
  assert.equal(restricted.element('note').disabled, true);
  assert.equal(restricted.element('state-badge').textContent, 'Unavailable');

  const recording = await popupHarness({ savedHandle: {
    name: 'Design references', async queryPermission() { return 'granted'; }
  }, activeCapture: { phase: 'recording' } });
  assert.equal(recording.element('start').disabled, true);
  assert.equal(recording.element('pick-dir').disabled, true);
  assert.equal(recording.element('state-badge').textContent, 'Recording');
});


test('popup requests folder access again and keeps start errors visible', async () => {
  let permissionRequests = 0;
  const savedHandle = {
    name: 'Design references',
    async queryPermission() { return 'prompt'; },
    async requestPermission() { permissionRequests++; return 'granted'; }
  };
  const popup = await popupHarness({ savedHandle, startResponse: { ok: false, error: 'Tab changed' } });
  assert.equal(popup.element('folder-name').textContent, 'Design references');
  assert.equal(popup.element('state-badge').hidden, true);
  assert.equal(popup.element('folder-hint').hidden, false);
  assert.match(popup.element('folder-hint').textContent, /Used by all capture modes/);
  assert.equal(permissionRequests, 0, 'opening the popup must not request permission');
  assert.equal(popup.element('start').disabled, false);
  await popup.element('start').click();
  assert.equal(permissionRequests, 1);
  assert.equal(popup.closed, false);
  assert.equal(popup.element('start').disabled, false);
  assert.match(popup.element('message').textContent, /Tab changed/);
});

test('denied folder access stops capture, preserves the selection, and can be retried', async () => {
  let permissionRequests = 0;
  const popup = await popupHarness({ savedHandle: {
    name: 'Design references',
    async queryPermission() { return 'prompt'; },
    async requestPermission() { return ++permissionRequests === 1 ? 'denied' : 'granted'; }
  } });
  assert.equal(popup.element('state-badge').hidden, true);
  await popup.element('start').click();
  assert.equal(permissionRequests, 1);
  assert.equal(popup.closed, false);
  assert.equal(popup.messages.some(message => message.type === 'CAPTURE_START'), false);
  assert.equal(popup.element('folder-name').textContent, 'Design references');
  assert.equal(popup.element('state-badge').textContent, 'Access denied');
  assert.equal(popup.element('state-badge').hidden, false);
  assert.equal(popup.element('folder-hint').hidden, false);
  assert.match(popup.element('message').textContent, /access was not granted/);
  await popup.element('start').click();
  assert.equal(permissionRequests, 2);
  assert.equal(popup.closed, true);
  assert.equal(popup.messages.filter(message => message.type === 'CAPTURE_START').length, 1);
});

test('popup manual mode and Stop action use the active tab', async () => {
  const manual = await popupHarness({ savedHandle: {
    name: 'Design references', async queryPermission() { return 'granted'; }
  } });
  manual.element('mode-manual').checked = true;
  await manual.element('start').click();
  assert.equal(manual.messages.find(message => message.type === 'CAPTURE_START').mode, 'manual');

  const running = await popupHarness({ activeCapture: { tabId: 4, phase: 'recording', mode: 'manual' } });
  assert.equal(running.element('stop').hidden, false);
  await running.element('stop').click();
  assert.deepEqual(JSON.parse(JSON.stringify(running.messages.find(message => message.type === 'CAPTURE_STOP'))),
    { type: 'CAPTURE_STOP', tabId: 4 });
  assert.equal(running.element('state-badge').textContent, 'Saving');
  assert.equal(running.element('stop').hidden, true);
});

test('Stop updates session state and early processing failures clear it', async () => {
  const app = backgroundHarness();
  assert.equal((await app.send(startMessage)).ok, true);
  assert.equal((await app.send({ type: 'CAPTURE_STOP', tabId: 4 }, { id: 'wrong', url: 'chrome-extension://test/popup/popup.html' })).ok, false);
  assert.equal((await app.send({ type: 'CAPTURE_STOP', tabId: 4 },
    { id: 'test-extension' })).ok, true);
  assert.equal(app.state.get('capture').phase, 'stopping');
  assert.equal(app.sentToTabs.filter(item => item.message.type === 'STOP_RECORDING').length, 1);
  assert.equal((await app.send({ type: 'CAPTURE_PROCESSING' }, fromTab)).ok, true);
  assert.equal(app.state.get('capture').phase, 'processing');
  assert.equal((await app.send({ type: 'CAPTURE_FAILED', error: 'screenshot failed' }, fromTab)).ok, true);
  assert.equal(app.state.has('capture'), false);
});

test('failed Stop leaves recording retryable', async () => {
  const app = backgroundHarness();
  assert.equal((await app.send(startMessage)).ok, true);
  app.setTabStopResponse({ ok: false, error: 'content tab did not respond' });
  const stopped = await app.send({ type: 'CAPTURE_STOP', tabId: 4 },
    { id: 'test-extension', url: 'chrome-extension://test/popup/popup.html' });
  assert.equal(stopped.ok, false);
  assert.match(stopped.error, /did not respond/);
  assert.equal(app.state.get('capture').phase, 'recording');
});

function contentControlHarness({ screenshotError = null, saveError = null, pageHeight = 2200, growingPage = false, scrollBlocked = false, warnings = [] } = {}) {
  const listeners = [];
  const messages = [];
  const timers = new Map();
  const scrolls = [];
  const flashes = [];
  const controlRemovals = [];
  let nextTimer = 1;
  let now = 100000;
  let banner;
  let bannerHost;
  let recorder;
  let tracksStopped = false;
  const timer = (callback, delay) => {
    const id = nextTimer++;
    timers.set(id, { callback, due: now + delay });
    return id;
  };
  const window = {
    innerWidth: 1000, innerHeight: 1000, devicePixelRatio: 1, scrollX: 0, scrollY: 0,
    scrollTo(x, y) {
      this.scrollX = typeof x === 'object' ? x.left || 0 : x;
      const top = typeof x === 'object' ? x.top : y;
      this.scrollY = scrollBlocked ? 0 : Math.max(0, Math.min(top, document.documentElement.scrollHeight - this.innerHeight));
      scrolls.push(this.scrollY);
    }
  };
  const canvas = {
    width: 0, height: 0,
    getContext() { return { drawImage() {} }; },
    toDataURL() { return 'data:image/jpeg;base64,AA=='; }
  };
  const document = {
    location: { href: 'https://example.com/' }, baseURI: 'https://example.com/', styleSheets: [],
    documentElement: {
      scrollWidth: 1000, scrollHeight: pageHeight, dataset: {},
      appendChild(element) { bannerHost = element; return element; }
    },
    body: { scrollWidth: 1000, scrollHeight: pageHeight },
    querySelectorAll() { return []; }, querySelector() { return null; },
    getElementById(id) { return id === 'site-dossier-root' ? bannerHost : null; },
    cloneNode() {
      return {
        querySelector() { return null; }, querySelectorAll() { return []; },
        createElement() { return {}; }, head: { insertBefore() {} },
        documentElement: { outerHTML: '<html><body>Test page</body></html>' }
      };
    },
    createElement(tag) {
      if (tag === 'canvas') return { ...canvas };
      if (!['div', 'site-dossier-control'].includes(tag)) throw new Error('unexpected element: ' + tag);
      const children = new Map();
      for (const name of ['.state', '.timer', '.shots', 'button']) {
        children.set(name, { textContent: '', disabled: false, hidden: false, addEventListener(_event, fn) { this.click = fn; } });
      }
      const element = {
        dataset: {}, style: {
          values: new Map(),
          getPropertyValue(name) { return this.values.get(name)?.value || ''; },
          getPropertyPriority(name) { return this.values.get(name)?.priority || ''; },
          setProperty(name, value, priority = '') { this.values.set(name, { value, priority }); },
          removeProperty(name) { this.values.delete(name); }
        }, shadowRoot: null, popoverOpen: false,
        classList: { add(name) { if (name === 'flash') flashes.push(now); }, remove() {} },
        attachShadow(options) {
          assert.equal(options.mode, 'closed');
          return { append(surface) { banner = surface; } };
        },
        showPopover() { this.popoverOpen = true; },
        querySelector(name) { return children.get(name); },
        remove() { this.popoverOpen = false; if (this === bannerHost) controlRemovals.push(now); }
      };
      return element;
    }
  };
  class FakeRecorder {
    constructor() { this.state = 'inactive'; recorder = this; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.finished = this.onstop(); }); }
  }
  class FakeImage { naturalWidth = 1000; naturalHeight = 1000; set src(_value) { queueMicrotask(() => this.onload()); } }
  class FakeReader {
    readAsDataURL() { this.result = 'data:video/webm;base64,AA=='; queueMicrotask(() => this.onloadend()); }
  }
  class FakeSheet { replaceSync(css) { assert.equal(css, read('content/banner.css')); } }
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const chrome = {
    runtime: {
      onMessage: { addListener(fn) { listeners.push(fn); } },
      sendMessage(message, callback) {
        messages.push(message);
        if (message.type === 'CAPTURE_VISIBLE_TAB') {
          Promise.resolve().then(() => {
            if (growingPage) document.documentElement.scrollHeight += 1000;
            assert.equal(bannerHost.popoverOpen, true, 'control must stay in the top layer during screenshots');
            assert.equal(banner.style.getPropertyValue('opacity'), '');
            assert.equal(banner.style.getPropertyValue('visibility'), '');
            assert.equal(controlRemovals.length, 0, 'control must remain mounted through saving');
            callback(screenshotError ? { error: screenshotError } : { dataUrl: 'data:image/png;base64,AA==' });
          });
        }
        else if (message.type === 'CAPTURE_BUNDLE_READY') callback(saveError ? { ok: false, error: saveError } : { ok: true, result: { folderName: 'bundle', viewport: 'desktop', warnings } });
        else callback?.({ ok: true });
      },
      lastError: null
    }
  };
  vm.runInNewContext(read('content/content.js'), {
    window, document, chrome, MediaRecorder: FakeRecorder, Image: FakeImage, SiteDossierCapture: captureMath,
    Blob, FileReader: FakeReader, CSSStyleSheet: FakeSheet,
    navigator: { mediaDevices: { async getUserMedia() { return { getTracks() { return [{ stop() { tracksStopped = true; } }]; } }; } } },
    requestAnimationFrame: callback => queueMicrotask(callback),
    setTimeout: timer, clearTimeout: id => timers.delete(id),
    setInterval: () => nextTimer++, clearInterval() {},
    console: { log() {}, warn() {}, error() {} }, Date: FakeDate, Math
  });
  const send = message => new Promise(resolve => {
    if (message.type === 'INJECT_BANNER') message = { ...message, css: read('content/banner.css') };
    for (const listener of listeners) {
      const result = listener(message, {}, resolve);
      if (result === true || ['INJECT_BANNER', 'REMOVE_BANNER'].includes(message.type)) return;
    }
  });
  const runNext = async () => {
    const [id, entry] = [...timers].sort((a, b) => a[1].due - b[1].due)[0] || [];
    if (!entry) return false;
    timers.delete(id);
    now = entry.due;
    entry.callback();
    await new Promise(resolve => setImmediate(resolve));
    return true;
  };
  const runUntil = async predicate => {
    for (let i = 0; i < 1000 && !predicate(); i++) assert.equal(await runNext(), true);
    assert.ok(predicate(), 'capture did not reach expected state');
  };
  const advance = async ms => {
    const end = now + ms;
    while ([...timers.values()].some(entry => entry.due <= end)) await runNext();
    now = end;
  };
  return { send, runNext, runUntil, advance, messages, scrolls, flashes, controlRemovals, window,
    get banner() { return banner; }, get bannerHost() { return bannerHost; },
    get recorder() { return recorder; }, get tracksStopped() { return tracksStopped; } };
}

test('Auto records and captures screenshots in one pass, then reuses them during saving', async () => {
  const auto = contentControlHarness();
  assert.equal((await auto.send({ type: 'INJECT_BANNER' })).ok, true);
  assert.equal(auto.bannerHost.shadowRoot, null);
  assert.equal(auto.bannerHost.popoverOpen, true);
  assert.equal((await auto.send({ type: 'START_RECORDING', streamId: 'stream', mode: 'auto' })).ok, true);
  assert.equal(auto.banner.dataset.state, 'recording');
  assert.equal(auto.banner.querySelector('.state').textContent, 'Auto capture');
  await auto.runUntil(() => auto.banner.dataset.state === 'saved');
  assert.equal(auto.recorder.state, 'inactive');
  assert.deepEqual(auto.scrolls, [0, 0, 1000, 1200]);
  assert.equal(auto.messages.filter(message => message.type === 'CAPTURE_VISIBLE_TAB').length, 3);
  assert.equal(auto.flashes.length, 3);
  assert.equal(auto.controlRemovals.length, 0);
  assert.ok(auto.messages.some(message => message.type === 'CAPTURE_PROCESSING'));
  assert.equal(auto.messages.filter(message => message.type === 'CAPTURE_BUNDLE_READY').length, 1);
  assert.equal(auto.banner.querySelector('.shots').textContent, 'bundle/desktop');
  assert.equal(auto.bannerHost.popoverOpen, true);
  assert.equal(auto.tracksStopped, true);
});

test('optional preview warnings use the ordinary saved banner and dismissal time', async () => {
  const auto = contentControlHarness({ warnings: ['Video stills unavailable.', 'Page tiles incomplete.', 'Folder reading guide unavailable.'] });
  await auto.send({ type: 'INJECT_BANNER' });
  await auto.send({ type: 'START_RECORDING', streamId: 'stream', mode: 'auto' });
  await auto.runUntil(() => auto.banner.dataset.state === 'saved');
  assert.equal(auto.banner.querySelector('.state').textContent, 'Saved');
  assert.equal(auto.banner.querySelector('.shots').textContent, 'bundle/desktop');
  assert.equal(auto.messages.some(message => message.type === 'CAPTURE_FAILED'), false);
  await auto.advance(8000);
  assert.equal(auto.controlRemovals.length, 1);
});

test('failed core writes still show the save error and report capture failure', async () => {
  const auto = contentControlHarness({ saveError: 'Disk unavailable' });
  await auto.send({ type: 'INJECT_BANNER' });
  await auto.send({ type: 'START_RECORDING', streamId: 'stream', mode: 'auto' });
  await auto.runUntil(() => auto.banner.dataset.state === 'failed');
  assert.equal(auto.banner.querySelector('.state').textContent, 'Save failed');
  assert.equal(auto.banner.querySelector('.shots').textContent, 'Disk unavailable');
  assert.equal(auto.messages.find(message => message.type === 'CAPTURE_FAILED').error, 'Disk unavailable');
});

test('Stop during Auto saves captured tiles without starting a second scroll pass', async () => {
  const auto = contentControlHarness();
  await auto.send({ type: 'INJECT_BANNER' });
  await auto.send({ type: 'START_RECORDING', streamId: 'stream', mode: 'auto' });
  await auto.runNext();
  assert.equal(auto.flashes.length, 1);
  auto.banner.querySelector('button').click();
  assert.equal(auto.banner.dataset.state, 'saving');
  assert.equal(auto.banner.querySelector('button').hidden, true);
  const movesAtStop = auto.scrolls.length;
  await auto.runUntil(() => auto.banner.dataset.state === 'saved');
  assert.equal(auto.scrolls.length, movesAtStop);
  assert.ok(auto.messages.filter(message => message.type === 'CAPTURE_VISIBLE_TAB').length <= 2);
});

test('Manual waits for Stop, then captures the final page and restores its position', async () => {
  const manual = contentControlHarness();
  await manual.send({ type: 'INJECT_BANNER' });
  assert.equal((await manual.send({ type: 'START_RECORDING', streamId: 'stream', mode: 'manual' })).ok, true);
  assert.equal(manual.banner.querySelector('.state').textContent, 'Manual recording');
  assert.equal(manual.scrolls.length, 0);
  manual.window.scrollY = 400;
  assert.equal((await manual.send({ type: 'STOP_RECORDING' })).ok, true);
  assert.equal(manual.recorder.state, 'inactive');
  assert.equal(manual.banner.dataset.state, 'saving');
  await new Promise(resolve => setImmediate(resolve));
  await manual.runUntil(() => manual.banner.dataset.state === 'saved');
  assert.deepEqual(manual.scrolls, [0, 1000, 1200, 400]);
  assert.equal(manual.flashes.length, 3);
  assert.equal(manual.controlRemovals.length, 0);
});

test('Auto reaches the end of a long page beyond the former 30-second cutoff', async () => {
  const auto = contentControlHarness({ pageHeight: 50000 });
  await auto.send({ type: 'INJECT_BANNER' });
  await auto.send({ type: 'START_RECORDING', streamId: 'stream', mode: 'auto' });
  await auto.runUntil(() => auto.banner.dataset.state === 'saved');
  assert.equal(auto.window.scrollY, 49000);
  assert.equal(auto.flashes.length, 50);
  const bundle = auto.messages.find(message => message.type === 'CAPTURE_BUNDLE_READY');
  assert.ok(bundle.video.durationS > 30);
  assert.equal(bundle.video.stopReason, 'page-end');
  assert.equal(bundle.screenshot.stopReason, 'page-end');
});

test('Manual records beyond 30 seconds and completes a long screenshot pass after Stop', async () => {
  const manual = contentControlHarness({ pageHeight: 50000 });
  await manual.send({ type: 'INJECT_BANNER' });
  await manual.send({ type: 'START_RECORDING', streamId: 'stream', mode: 'manual' });
  await manual.advance(40000);
  assert.equal(manual.recorder.state, 'recording');
  assert.equal(manual.scrolls.length, 0);
  manual.window.scrollY = 7000;
  await manual.send({ type: 'STOP_RECORDING' });
  await new Promise(resolve => setImmediate(resolve));
  await manual.runUntil(() => manual.banner.dataset.state === 'saved');
  assert.equal(manual.flashes.length, 50);
  assert.equal(manual.window.scrollY, 7000);
  const bundle = manual.messages.find(message => message.type === 'CAPTURE_BUNDLE_READY');
  assert.equal(bundle.video.durationS, 40, 'post-stop screenshots must not extend video duration');
  assert.equal(bundle.video.stopReason, 'user');
  assert.equal(bundle.screenshot.stopReason, 'page-end');
});

test('Manual keeps the 180-second cap and explains it in the saved result', async () => {
  const manual = contentControlHarness();
  await manual.send({ type: 'INJECT_BANNER' });
  await manual.send({ type: 'START_RECORDING', streamId: 'stream', mode: 'manual' });
  await manual.advance(179000);
  assert.equal(manual.recorder.state, 'recording');
  await manual.advance(1000);
  assert.equal(manual.recorder.state, 'inactive');
  await manual.runUntil(() => manual.banner.dataset.state === 'saved');
  const bundle = manual.messages.find(message => message.type === 'CAPTURE_BUNDLE_READY');
  assert.equal(bundle.video.durationS, 180);
  assert.equal(bundle.video.stopReason, 'time-limit');
  assert.match(manual.banner.querySelector('.state').textContent, /3-minute limit/);
});

test('Auto on an endlessly growing page remains bounded and reports a partial capture', async () => {
  const auto = contentControlHarness({ growingPage: true });
  await auto.send({ type: 'INJECT_BANNER' });
  await auto.send({ type: 'START_RECORDING', streamId: 'stream', mode: 'auto' });
  await auto.runUntil(() => auto.banner.dataset.state === 'saved');
  const bundle = auto.messages.find(message => message.type === 'CAPTURE_BUNDLE_READY');
  assert.equal(bundle.video.durationS, 180);
  assert.equal(bundle.video.stopReason, 'time-limit');
  assert.notEqual(bundle.screenshot.stopReason, 'page-end');
  assert.match(auto.banner.querySelector('.state').textContent, /limit|partial/i);
  assert.equal(auto.tracksStopped, true);
});

test('Blocked scrolling saves the available tiles with a visible partial-result warning', async () => {
  const auto = contentControlHarness({ pageHeight: 5000, scrollBlocked: true });
  await auto.send({ type: 'INJECT_BANNER' });
  await auto.send({ type: 'START_RECORDING', streamId: 'stream', mode: 'auto' });
  await auto.runUntil(() => auto.banner.dataset.state === 'saved');
  const bundle = auto.messages.find(message => message.type === 'CAPTURE_BUNDLE_READY');
  assert.equal(bundle.screenshot.stopReason, 'scroll-blocked');
  assert.match(auto.banner.querySelector('.state').textContent, /partial screenshot/);
});

test('A stream ending independently records its actual duration and explains the interruption', async () => {
  const manual = contentControlHarness();
  await manual.send({ type: 'INJECT_BANNER' });
  await manual.send({ type: 'START_RECORDING', streamId: 'stream', mode: 'manual' });
  await manual.advance(40000);
  manual.recorder.stop(); // Simulate Chrome ending the stream without our Stop handler.
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(manual.messages.some(message => message.type === 'CAPTURE_PROCESSING'));
  await manual.runUntil(() => manual.banner.dataset.state === 'saved');
  const bundle = manual.messages.find(message => message.type === 'CAPTURE_BUNDLE_READY');
  assert.equal(bundle.video.durationS, 40);
  assert.equal(bundle.video.stopReason, 'stream-ended');
  assert.match(manual.banner.querySelector('.state').textContent, /recording ended/);
});

test('Auto screenshot failure stops recording and shows failure without rescanning', async () => {
  const auto = contentControlHarness({ screenshotError: 'tab switched' });
  await auto.send({ type: 'INJECT_BANNER' });
  await auto.send({ type: 'START_RECORDING', streamId: 'stream', mode: 'auto' });
  await auto.runUntil(() => auto.banner.dataset.state === 'failed');
  assert.equal(auto.recorder.state, 'inactive');
  assert.deepEqual(auto.scrolls, [0, 0]);
  assert.equal(auto.flashes.length, 0);
  assert.equal(auto.banner.querySelector('.shots').textContent, 'tab switched');
  assert.ok(auto.messages.some(message => message.type === 'CAPTURE_FAILED'));
  assert.equal(auto.messages.some(message => message.type === 'CAPTURE_BUNDLE_READY'), false);
});

test('folder picker is usable while capture status is still loading', async () => {
  let releaseStatus;
  const statusGate = new Promise(resolve => { releaseStatus = resolve; });
  const popup = await popupHarness({ statusGate, waitForReady: false });
  assert.equal(popup.element('pick-dir').disabled, false);
  await popup.element('pick-dir').click();
  assert.equal(popup.pickerOptions[0].startIn, 'downloads');
  releaseStatus();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(popup.element('folder-name').textContent, 'Design references');
});

test('closing a tab during post-stop processing clears the active capture', async () => {
  const app = backgroundHarness();
  assert.equal((await app.send(startMessage)).ok, true);
  assert.equal((await app.send({ type: 'CAPTURE_PROCESSING' }, fromTab)).ok, true);
  app.removeTab(4);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.state.has('capture'), false);
});

test('contact-sheet seeks resolve at the current frame and time out if decoding stalls', async () => {
  const context = vm.createContext({
    document: { getElementById: () => ({ textContent: '' }) },
    BroadcastChannel: class {},
    chrome: { runtime: { onMessage: { addListener() {} } } },
    setTimeout: callback => { queueMicrotask(callback); return 1; },
    clearTimeout() {}, console, URL, Blob, fetch
  });
  vm.runInContext(read('offscreen/media.js'), context);
  const seekTo = vm.runInContext('seekTo', context);
  const video = {
    duration: 10, readyState: 2, currentTime: 1,
    addEventListener() {}, removeEventListener() {}
  };
  await seekTo(video, 1);
  await assert.rejects(seekTo(video, 2), /timed out/);
});

test('rectangle capture rejects a changed viewport, scrolling, zoom or malformed dimensions',()=>{
  const before={width:1000,height:800,x:0,y:100,ratio:2,scale:1,offsetX:0,offsetY:0};
  assert.ok(sameViewport(before,{...before}));
  for(const change of [{width:900},{height:750},{x:20},{y:101},{ratio:1},{scale:1.5},{offsetX:5},{offsetY:3},{width:NaN}])assert.ok(!sameViewport(before,{...before,...change}));
  assert.ok(!sameViewport(before,null));
});
