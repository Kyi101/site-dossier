import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function backgroundHarness(shared = {}) {
  const listeners = [];
  const state = shared.state || new Map();
  const captured = [];
  const sentToTabs = [];
  const offscreenWrites = [];
  let onTabRemoved = null;
  let activeTabId = 4;
  let streamId = 'stream';
  let offscreenResponse = { ok: true, result: { folderName: 'bundle', viewport: 'desktop', merged: false } };
  let tabStopResponse = { ok: true };
  let switchDuringCapture = null;
  const tab = id => ({ id, active: id === activeTabId, windowId: 1, url: 'https://example.com/one' });
  const chrome = {
    runtime: {
      id: 'test-extension',
      onMessage: { addListener(fn) { listeners.push(fn); } },
      getURL(value) { return 'chrome-extension://test/' + value; },
      async getContexts() { return [{}]; },
      async sendMessage(message) {
        offscreenWrites.push(message);
        return offscreenResponse;
      },
      lastError: null
    },
    notifications: { create() {} },
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
  vm.runInNewContext(read('background/background.js'), { chrome, console, Date,
    fetch: async () => ({ ok: true, text: async () => read('content/banner.css') }) });
  const send = (message, sender = {}) => new Promise(resolve => {
    for (const listener of listeners) {
      if (listener(message, sender, resolve) === true) return;
    }
    resolve(undefined);
  });
  return {
    send, state, captured, sentToTabs, offscreenWrites,
    setActiveTab(id) { activeTabId = id; },
    setSwitchDuringCapture(id) { switchDuringCapture = id; },
    setStreamId(id) { streamId = id; },
    setOffscreenResponse(response) { offscreenResponse = response; },
    setTabStopResponse(response) { tabStopResponse = response; },
    removeTab(id) { onTabRemoved(id); }
  };
}

const startMessage = {
  type: 'CAPTURE_START', tabId: 4, url: 'https://example.com/one',
  note: 'layout', tags: ['dark'], viewportSize: { width: 1000, height: 800 },
  viewportName: 'desktop', mode: 'auto'
};
const fromTab = { tab: { id: 4 } };

test('syntax, manifest, and required package files', () => {
  for (const file of ['background/background.js', 'content/content.js', 'popup/popup.js', 'offscreen/offscreen.js']) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, '116');
  assert.ok(!manifest.host_permissions);
  assert.ok(!manifest.permissions.includes('downloads'));
  for (const file of ['manifest.json', 'background/background.js', 'content/content.js', 'content/banner.css',
    'popup/popup.html', 'popup/popup.css', 'popup/popup.js', 'offscreen/offscreen.html',
    'offscreen/offscreen.js', 'icons/16.png', 'icons/48.png', 'icons/128.png', 'LICENSE']) {
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
  assert.equal(secondWorker.offscreenWrites[0].payload.note, 'layout');
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
  constructor() { this.dirs = new Map(); this.files = new Map(); }
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.dirs.has(name)) {
      if (!create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      this.dirs.set(name, new FakeDir());
    }
    return this.dirs.get(name);
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.files.has(name) && !create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
    return {
      getFile: async () => new Blob([this.files.get(name) || '']),
      createWritable: async () => ({
        write: async blob => this.files.set(name, await blob.text()),
        close: async () => {}
      })
    };
  }
}

test('bundles merge only for the same URL and tags remain strings', async () => {
  const rootDir = new FakeDir();
  const context = vm.createContext({
    rootDir, Blob, URL, fetch, setTimeout, clearTimeout,
    document: { getElementById: () => ({ textContent: '' }), createElement: () => { throw new Error('no video decoder in test'); } },
    BroadcastChannel: class { set onmessage(_value) {} },
    chrome: { runtime: { onMessage: { addListener() {} }, getURL: value => value } },
    console: { warn() {}, log() {} }
  });
  vm.runInContext(read('offscreen/offscreen.js'), context);
  vm.runInContext('cachedDirHandle = rootDir', context);
  const writeBundle = vm.runInContext('writeBundle', context);
  const payload = url => ({
    url, startedAt: '2026-09-25T12:00:00Z', viewportName: 'desktop',
    viewportSize: { width: 1000, height: 800 }, note: 'hello',
    tags: ['x: y', '[nested]'], video: { dataUrl: 'data:video/webm;base64,AA==', durationS: 1 },
    screenshot: { dataUrl: 'data:image/jpeg;base64,AA==' }, html: '<html></html>', tokens: {}
  });
  const one = await writeBundle(payload('https://example.com/one'));
  const two = await writeBundle(payload('https://example.com/two'));
  const repeatedPayload = {
    ...payload('https://example.com/one'),
    note: 'mobile navigation', tags: ['navigation'], tokens: { colors: ['#123456'] }
  };
  const repeat = await writeBundle(repeatedPayload);
  assert.equal(one.folderName, 'example-com-2026-09-25');
  assert.equal(two.folderName, 'example-com-2026-09-25-2');
  assert.equal(repeat.folderName, one.folderName);
  assert.equal(repeat.viewport, 'desktop-2');
  assert.equal(rootDir.dirs.get(one.folderName).files.get('url.txt').trim(), 'https://example.com/one');
  assert.match(rootDir.dirs.get(one.folderName).files.get('note.md'), /tags: \["x: y","\[nested\]"\]/);
  const saved = rootDir.dirs.get(one.folderName);
  assert.match(saved.dirs.get('desktop-2').files.get('note.md') || '', /mobile navigation/);
  assert.deepEqual(JSON.parse(saved.dirs.get('desktop-2').files.get('tokens.json') || '{}'), repeatedPayload.tokens);
  assert.match(saved.dirs.get('desktop').files.get('note.md') || '', /hello/);
  assert.match(saved.files.get('note.md'), /hello/);
  for (const file of ['url.txt', 'note.md', 'tokens.json']) assert.ok(saved.files.has(file), file);
  for (const file of ['scroll.webm', 'page.jpg', 'page.html', 'meta.json']) {
    assert.ok(saved.dirs.get('desktop').files.has(file), file);
  }
  assert.equal(JSON.parse(saved.dirs.get('desktop').files.get('meta.json')).capture_mode, 'auto');
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
    createElement: () => canvas
  };
  class FakeImage {
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
    window: win, document: doc, chrome, Image: FakeImage,
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
  startResponse = { ok: true }, stopResponse = { ok: true }, statusGate = null, waitForReady = true } = {}) {
  const elements = new Map();
  const messages = [];
  const pickerOptions = [];
  let closed = false;
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        textContent: '', dataset: {}, attributes: {}, disabled: false, hidden: false, value: '',
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(type, callback) { this[type] = callback; }
      });
    }
    return elements.get(id);
  };
  const config = new Map(savedHandle ? [['inspoDirHandle', savedHandle]] : []);
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
      tabs: { async query() { return [{ id: 4, url: tabUrl, title: 'Example design', width: 1200, height: 800 }]; } },
      runtime: {
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
      async showDirectoryPicker(options) { pickerOptions.push(options); return savedHandle || handle; },
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
  return { element, messages, pickerOptions, document: context.document, get closed() { return closed; } };
}

test('popup guides folder setup and sends the chosen page context', async () => {
  const popup = await popupHarness();
  assert.equal(popup.element('start').disabled, true);
  assert.equal(popup.element('state-badge').textContent, 'Select folder');
  await popup.element('pick-dir').click();
  assert.equal(popup.pickerOptions[0].startIn, 'downloads');
  assert.equal(popup.pickerOptions[0].id, 'site-dossier-local');
  assert.equal(popup.pickerOptions[0].mode, 'readwrite');
  assert.equal(popup.element('folder-name').textContent, 'Design references');
  assert.equal(popup.element('start').disabled, false);
  assert.equal(popup.element('state-badge').hidden, true);
  assert.equal(popup.element('folder-hint').hidden, true);
  popup.element('note').value = '  strong type  ';
  popup.element('tags').value = 'type, motion';
  await popup.element('start').click();
  assert.equal(popup.closed, true);
  const start = popup.messages.find(message => message.type === 'CAPTURE_START');
  assert.equal(start.note, 'strong type');
  assert.deepEqual(Array.from(start.tags), ['type', 'motion']);
  assert.equal(start.viewportName, 'desktop');
  assert.equal(start.mode, 'auto');
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
  assert.equal(popup.element('folder-hint').hidden, true);
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

function contentControlHarness({ screenshotError = null } = {}) {
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
      this.scrollY = Math.max(0, Math.min(top, 1200));
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
      scrollWidth: 1000, scrollHeight: 2200, dataset: {},
      appendChild(element) { bannerHost = element; return element; }
    },
    body: { scrollWidth: 1000, scrollHeight: 2200 },
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
      if (tag === 'canvas') return canvas;
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
  class FakeImage { set src(_value) { queueMicrotask(() => this.onload()); } }
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
            assert.equal(bannerHost.popoverOpen, true, 'control must stay in the top layer during screenshots');
            assert.equal(banner.style.getPropertyValue('opacity'), '');
            assert.equal(banner.style.getPropertyValue('visibility'), '');
            assert.equal(controlRemovals.length, 0, 'control must remain mounted through saving');
            callback(screenshotError ? { error: screenshotError } : { dataUrl: 'data:image/png;base64,AA==' });
          });
        }
        else if (message.type === 'CAPTURE_BUNDLE_READY') callback({ ok: true, result: { folderName: 'bundle', viewport: 'desktop' } });
        else callback?.({ ok: true });
      },
      lastError: null
    }
  };
  vm.runInNewContext(read('content/content.js'), {
    window, document, chrome, MediaRecorder: FakeRecorder, Image: FakeImage,
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
    for (let i = 0; i < 60 && !predicate(); i++) assert.equal(await runNext(), true);
    assert.ok(predicate(), 'capture did not reach expected state');
  };
  return { send, runNext, runUntil, messages, scrolls, flashes, controlRemovals, window,
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
  vm.runInContext(read('offscreen/offscreen.js'), context);
  const seekTo = vm.runInContext('seekTo', context);
  const video = {
    duration: 10, readyState: 2, currentTime: 1,
    addEventListener() {}, removeEventListener() {}
  };
  await seekTo(video, 1);
  await assert.rejects(seekTo(video, 2), /timed out/);
});
