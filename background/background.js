import './collector.mjs';

// Service worker: routes capture messages. Capture details live in session
// storage because Chrome can stop this worker while a recording is in progress.

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const CAPTURE_KEY = 'capture';
const PAGE_CHANGED = 'The page changed, so this capture ended without being saved. Start a new capture on the current page.';
const RECORDING_LOST = 'The recording is no longer available. Start a new capture on the current page.';
let creatingOffscreen = null;
let startingCapture = false;
let writingBundle = false;
let manualAttachQueue = Promise.resolve();
let finishingManual = false;

function fromOffscreen(sender) {
  return sender.id === chrome.runtime.id && !sender.tab && sender.url === chrome.runtime.getURL(OFFSCREEN_URL);
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/128.png'),
    title,
    message
  });
}

async function readCapture() {
  const stored = await chrome.storage.session.get(CAPTURE_KEY);
  const capture = stored[CAPTURE_KEY];
  return capture?.phase === 'interrupted' ? null : capture || null;
}

function isCaptureSender(capture, sender) {
  return capture && sender.tab?.id === capture.tabId &&
    (!capture.documentId || sender.documentId === capture.documentId);
}

async function requireCapturePage(capture) {
  if (!capture.documentId || capture.kind === 'selection') {
    if ((await chrome.tabs.get(capture.tabId)).url !== capture.url) throw new Error(PAGE_CHANGED);
    return;
  }
  // History/hash updates can follow scrolling without replacing the document.
  // Check the live main document instead of treating its URL as its identity.
  const frames = await chrome.scripting.executeScript({ target: { tabId: capture.tabId }, func: () => true });
  if (frames[0]?.documentId !== capture.documentId) throw new Error(PAGE_CHANGED);
}

async function interruptCapture(capture, error) {
  const current = await readCapture();
  if (current?.startedAt !== capture.startedAt || current?.tabId !== capture.tabId || current.phase === 'saving') return;
  await chrome.storage.session.set({ [CAPTURE_KEY]: { ...current, phase: 'interrupted', error } });
  // Release the stream if the old document is still alive during navigation.
  await chrome.tabs.sendMessage(capture.tabId, { type: 'CANCEL_RECORDING', captureId: capture.startedAt },
    capture.documentId ? { documentId: capture.documentId } : { frameId: 0 }).catch(() => {});
  notify('Capture ended', error);
}

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  if (existingContexts.length > 0) return;

  // Two messages may arrive before the first createDocument call finishes.
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS', 'USER_MEDIA'],
      justification: 'Record the selected tab across page loads, decode video, and write the selected local folder.'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'MANUAL_VIDEO_READY') {
    if (!fromOffscreen(sender)) { sendResponse({ ok: false, error: 'Invalid recording sender.' }); return false; }
    finishManualCapture(message).then(result => sendResponse({ ok: true, result }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === 'CAPTURE_START') {
    handleCaptureStart(message)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === 'CAPTURE_STATUS') {
    chrome.storage.session.get(CAPTURE_KEY)
      .then(stored => {
        const capture = stored[CAPTURE_KEY];
        const interrupted = capture?.phase === 'interrupted';
        sendResponse({ ok: true,
          capture: capture && !interrupted ? { tabId: capture.tabId, phase: capture.phase, mode: capture.mode, kind: capture.kind } : null,
          interruption: interrupted ? { tabId: capture.tabId, error: capture.error } : null });
      })
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === 'CAPTURE_STOP') {
    handleCaptureStop(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === 'SELECTION_CANCEL') {
    cancelSelection(sender)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === 'CAPTURE_PROCESSING') {
    updateCapturePhase(sender, 'processing')
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === 'CAPTURE_FAILED') {
    handleCaptureFailure(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === 'CAPTURE_VISIBLE_TAB') {
    captureVisibleTab(sender)
      .then(dataUrl => sendResponse({ dataUrl }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'ENSURE_OFFSCREEN_READY') {
    ensureOffscreenDocument()
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === 'PROBE_LIBS') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ detected: {} });
      return false;
    }
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const d = {};
        if (window.gsap) d.gsap = true;
        if (window.ScrollTrigger || (window.gsap && window.gsap.plugins && window.gsap.plugins.ScrollTrigger)) d.scrolltrigger = true;
        if (window.Lenis) d.lenis = true;
        if (window.LocomotiveScroll) d['locomotive-scroll'] = true;
        if (window.THREE) d['three.js'] = true;
        if (window.Motion || window.motion) d.motion = true;
        if (window.Splitting) d.splitting = true;
        if (window.Swiper) d.swiper = true;
        if (window.AOS) d.aos = true;
        return d;
      }
    }).then(results => {
      sendResponse({ detected: results?.[0]?.result || {} });
    }).catch(err => {
      console.warn('[design-capture] PROBE_LIBS failed:', err);
      sendResponse({ detected: {}, error: err.message });
    });
    return true;
  }
  if (message.type === 'CAPTURE_BUNDLE_READY' || message.type === 'SELECTION_BUNDLE_READY') {
    handleBundleReady(message, sender)
      .then(result => sendResponse({ ok: true, result }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});

async function handleCaptureStart(message) {
  if (startingCapture) throw new Error('A capture is already starting.');
  startingCapture = true;
  try {
    const existing = await readCapture();
    if (existing) {
      const ageMs = Date.now() - Date.parse(existing.startedAt);
      let tabExists = true;
      try { await chrome.tabs.get(existing.tabId); } catch { tabExists = false; }
      if (tabExists && ((existing.kind === 'selection' && existing.phase !== 'starting') || ageMs < (existing.phase === 'starting' ? 30000 : 600000))) {
        throw new Error('Another capture is still running or saving.');
      }
      await chrome.storage.session.remove(CAPTURE_KEY);
    }

    const tab = await chrome.tabs.get(message.tabId);
    if (!tab.active || !tab.url || tab.url !== message.url) {
      throw new Error('The selected tab changed. Open the popup on the page again.');
    }

    const capture = {
      tabId: tab.id,
      url: message.url,
      title: message.title,
      note: message.note,
      tags: message.tags,
      preferences: message.preferences,
      kind: message.kind === 'selection' ? 'selection' : 'page',
      viewportSize: message.viewportSize,
      viewportName: message.viewportName || 'desktop',
      mode: message.mode === 'manual' ? 'manual' : 'auto',
      startedAt: new Date().toISOString(),
      phase: 'starting'
    };
    capture.continuous = capture.kind === 'page' && capture.mode === 'manual';
    capture.toolVersion = chrome.runtime.getManifest().version;
    await chrome.storage.session.set({ [CAPTURE_KEY]: capture });

    try {
      // Dismiss a completed capture's controls before beginning a different kind.
      await chrome.tabs.sendMessage(tab.id, { type: 'CLOSE_SELECTION' }).catch(() => {});
      if (capture.kind === 'selection') {
        await chrome.tabs.sendMessage(tab.id, { type: 'REMOVE_BANNER' }).catch(() => {});
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['shared/capture-math.js', 'content/selection.js'] });
        const styles = await fetch(chrome.runtime.getURL('content/selection.css'));
        if (!styles.ok) throw new Error('Could not load selection controls.');
        await chrome.storage.session.set({ [CAPTURE_KEY]: { ...capture, phase: 'selecting' } });
        const selected = await chrome.tabs.sendMessage(tab.id, { type: 'START_SELECTION', css: await styles.text(),
          tool: message.selectionTool === 'rectangle' ? 'rectangle' : 'element' });
        if (!selected?.ok) throw new Error(selected?.error || 'Could not start selection.');
        return;
      }
      const streamId = await new Promise((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id, ...(capture.continuous ? {} : { consumerTabId: tab.id }) }, id => {
          if (chrome.runtime.lastError || !id) {
            reject(new Error(chrome.runtime.lastError?.message || 'No stream ID'));
          } else {
            resolve(id);
          }
        });
      });

      const frames = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['shared/capture-math.js', 'content/content.js'] });
      capture.documentId = frames[0]?.documentId;
      const pending = await readCapture();
      if (pending?.startedAt !== capture.startedAt || pending?.tabId !== capture.tabId) throw new Error(PAGE_CHANGED);
      await chrome.storage.session.set({ [CAPTURE_KEY]: capture });

      if (capture.continuous) {
        const started = await sendToOffscreen({ type: 'OFFSCREEN_MANUAL_START', capture, streamId });
        if (!started?.ok) throw new Error(started?.error || 'Could not start manual recording.');
        await chrome.storage.session.set({ [CAPTURE_KEY]: { ...capture, phase: 'recording' } });
        try { await attachManualPage(); }
        catch (error) { console.warn('[design-capture] initial manual controls:', error.message); }
        return;
      }

      const bannerCssResponse = await fetch(chrome.runtime.getURL('content/banner.css'));
      if (!bannerCssResponse.ok) throw new Error('Could not load capture control styles.');
      const target = { documentId: capture.documentId };
      const injected = await chrome.tabs.sendMessage(tab.id, { type: 'INJECT_BANNER', css: await bannerCssResponse.text() }, target);
      if (!injected?.ok) throw new Error(injected?.error || 'Could not show capture control.');
      const started = await chrome.tabs.sendMessage(tab.id, { type: 'START_RECORDING', streamId, mode: capture.mode, captureId: capture.startedAt }, target);
      if (!started?.ok) throw new Error(started?.error || 'Recording failed to start.');
      const current = await readCapture();
      if (current?.startedAt !== capture.startedAt || current?.tabId !== capture.tabId) throw new Error(PAGE_CHANGED);
      await chrome.storage.session.set({ [CAPTURE_KEY]: { ...capture, phase: 'recording' } });
    } catch (err) {
      const current = await readCapture();
      if (current?.startedAt === capture.startedAt && current?.tabId === capture.tabId) {
        await chrome.storage.session.remove(CAPTURE_KEY);
      }
      await chrome.tabs.sendMessage(tab.id, { type: 'CANCEL_RECORDING', captureId: capture.startedAt }).catch(() => {});
      if (capture.continuous) await sendToOffscreen({ type: 'OFFSCREEN_MANUAL_CANCEL', captureId: capture.startedAt }).catch(() => {});
      await chrome.tabs.sendMessage(tab.id, { type: 'REMOVE_BANNER' }).catch(() => {});
      if (capture.kind === 'selection') await chrome.tabs.sendMessage(tab.id, { type: 'CLOSE_SELECTION' }).catch(() => {});
      throw err;
    }
  } catch (err) {
    notify('Capture failed to start', err.message || String(err));
    throw err;
  } finally {
    startingCapture = false;
  }
}

async function handleCaptureStop(message, sender) {
  const capture = await readCapture();
  if (!capture) {
    const stored = (await chrome.storage.session.get(CAPTURE_KEY))[CAPTURE_KEY];
    if (stored?.phase === 'interrupted' && (isCaptureSender(stored, sender) ||
      (sender.id === chrome.runtime.id && !sender.tab && message.tabId === stored.tabId))) {
      throw new Error(stored.error);
    }
  }
  const fromTab = isCaptureSender(capture, sender);
  const fromPopup = sender.id === chrome.runtime.id && !sender.tab &&
    message.tabId === capture?.tabId;
  if (!capture || (!fromTab && !fromPopup)) throw new Error('No recording for this tab.');
  if (capture.kind === 'selection' && capture.phase === 'selecting') {
    await chrome.tabs.sendMessage(capture.tabId, { type: 'CLOSE_SELECTION' }).catch(() => {});
    await chrome.storage.session.remove(CAPTURE_KEY);
    return;
  }
  if (capture.phase !== 'recording') throw new Error('The capture is already stopping or saving.');
  if (message.captureId && message.captureId !== capture.startedAt) throw new Error('This recording has been replaced.');
  if (capture.continuous) {
    await chrome.storage.session.set({ [CAPTURE_KEY]: { ...capture, phase: 'stopping' } });
    try {
      const response = await sendToOffscreen({ type: 'OFFSCREEN_MANUAL_STOP', captureId: capture.startedAt, reason: 'user' });
      if (!response?.ok) throw new Error(response?.error || RECORDING_LOST);
    } catch (error) {
      if (/No manual recording|Recording details were lost|Receiving end does not exist/.test(error.message)) {
        await interruptCapture(capture, RECORDING_LOST);
        throw new Error(RECORDING_LOST);
      }
      const current = await readCapture();
      if (current?.startedAt === capture.startedAt && current.phase === 'stopping') {
        await chrome.storage.session.set({ [CAPTURE_KEY]: { ...current, phase: 'recording' } });
      }
      throw error;
    }
    return;
  }
  try {
    await requireCapturePage(capture);
  } catch {
    await interruptCapture(capture, PAGE_CHANGED);
    throw new Error(PAGE_CHANGED);
  }
  await chrome.storage.session.set({ [CAPTURE_KEY]: { ...capture, phase: 'stopping' } });
  try {
    const response = await chrome.tabs.sendMessage(capture.tabId, { type: 'STOP_RECORDING' },
      capture.documentId ? { documentId: capture.documentId } : { frameId: 0 });
    if (!response?.ok) throw new Error(response?.error || 'Could not stop recording.');
  } catch (err) {
    const current = await readCapture();
    if (/Receiving end does not exist|Could not establish connection|No tab with id|message (?:port|channel) closed/i.test(err.message)) {
      await interruptCapture(capture, RECORDING_LOST);
      throw new Error(RECORDING_LOST);
    }
    if (current?.startedAt === capture.startedAt && current.tabId === capture.tabId && current.phase === 'stopping') {
      await chrome.storage.session.set({ [CAPTURE_KEY]: { ...current, phase: 'recording' } });
    }
    throw err;
  }
}

async function manualState(capture, state, label, detail) {
  await chrome.tabs.sendMessage(capture.tabId, { type: 'MANUAL_CAPTURE_STATE', captureId: capture.startedAt,
    state, label, detail }, { documentId: capture.documentId }).catch(() => {});
}

async function attachManualPage() {
  const capture = await readCapture();
  if (!capture?.continuous || capture.phase !== 'recording') return;
  const tab = await chrome.tabs.get(capture.tabId);
  if (!/^https?:\/\//.test(tab.url || '')) {
    await sendToOffscreen({ type: 'OFFSCREEN_MANUAL_STOP', captureId: capture.startedAt, reason: 'unsupported-page' });
    return;
  }
  const frames = await chrome.scripting.executeScript({ target: { tabId: capture.tabId }, files: ['shared/capture-math.js', 'content/content.js'] });
  const documentId = frames[0]?.documentId;
  const current = await readCapture();
  if (!documentId || !current?.continuous || current.startedAt !== capture.startedAt || current.phase !== 'recording') return;
  if (current.documentId === documentId && current.manualAttached) return;
  const updated = { ...current, documentId, manualAttached: false };
  await chrome.storage.session.set({ [CAPTURE_KEY]: updated });
  const target = { documentId };
  const styles = await fetch(chrome.runtime.getURL('content/banner.css'));
  const injected = await chrome.tabs.sendMessage(capture.tabId, { type: 'INJECT_BANNER', css: await styles.text() }, target);
  if (!injected?.ok) throw new Error(injected?.error || 'Could not show recording controls.');
  const attached = await chrome.tabs.sendMessage(capture.tabId, { type: 'ATTACH_MANUAL_CONTROL', captureId: capture.startedAt, startedAt: capture.startedAt }, target);
  if (!attached?.ok) throw new Error(attached?.error || 'Could not restore recording controls.');
  const latest = await readCapture();
  if (latest?.startedAt !== capture.startedAt || latest.documentId !== documentId || latest.phase !== 'recording') return;
  await chrome.storage.session.set({ [CAPTURE_KEY]: { ...latest, manualAttached: true } });
  const visitedAt = new Date().toISOString();
  const page = { documentId, entryUrl: tab.url, url: tab.url, title: tab.title, visitedAt,
    videoOffsetS: Math.max(0, (Date.parse(visitedAt) - Date.parse(capture.startedAt)) / 1000), errors: [] };
  await sendToOffscreen({ type: 'OFFSCREEN_MANUAL_PAGE', captureId: capture.startedAt, page, visit: true });
  try {
    const snapshot = await chrome.tabs.sendMessage(capture.tabId, { type: 'MANUAL_PAGE_SNAPSHOT', captureId: capture.startedAt }, target);
    if (!snapshot?.ok) throw new Error(snapshot?.error || 'Page snapshot unavailable.');
    Object.assign(page, snapshot.page);
    if ((await readCapture())?.phase !== 'recording') return;
    const dataUrl = await captureVisibleTab({ tab: { id: capture.tabId }, documentId });
    page.screenshot = { dataUrl, scope: 'viewport' };
  } catch (error) { page.errors.push(error.message); }
  const active = await readCapture();
  if (active?.startedAt !== capture.startedAt || active.phase !== 'recording') return;
  await sendToOffscreen({ type: 'OFFSCREEN_MANUAL_PAGE', captureId: capture.startedAt, page });
}

async function finishManualCapture(message) {
  const capture = await readCapture();
  if (!capture?.continuous || capture.startedAt !== message.captureId) throw new Error('Recording session was replaced.');
  if (finishingManual || capture.phase === 'saving') throw new Error('Already saving this recording.');
  finishingManual = true;
  try {
    await chrome.storage.session.set({ [CAPTURE_KEY]: { ...capture, phase: 'processing' } });
    await manualState(capture, 'saving', message.reason === 'time-limit' ? '3-minute limit — saving…' : 'Saving capture…', 'Taking the final page screenshots');
    try {
      await requireCapturePage(capture);
      const response = await chrome.tabs.sendMessage(capture.tabId, { type: 'MANUAL_PAGE_SNAPSHOT', captureId: capture.startedAt, final: true }, { documentId: capture.documentId });
      if (!response?.ok) throw new Error(response?.error || 'Final page snapshot unavailable.');
      await requireCapturePage(capture);
      const finalPage = { ...response.page, documentId: capture.documentId };
      await sendToOffscreen({ type: 'OFFSCREEN_MANUAL_PAGE', captureId: capture.startedAt, page: finalPage });
    } catch (error) {
      console.warn('[design-capture] final page snapshot:', error.message);
      await sendToOffscreen({ type: 'OFFSCREEN_MANUAL_PAGE', captureId: capture.startedAt,
        page: { documentId: capture.documentId, errors: ['Final page snapshot unavailable: ' + error.message] } });
    }
    await chrome.storage.session.set({ [CAPTURE_KEY]: { ...capture, phase: 'saving' } });
    const response = await sendToOffscreen({ type: 'OFFSCREEN_MANUAL_SAVE', captureId: capture.startedAt });
    if (!response?.ok) throw new Error(response?.error || 'Could not save manual recording.');
    notify('Captured', `${response.result.merged ? 'Merged into' : 'Wrote'} ${response.result.folderName}/${response.result.viewport}`);
    await manualState(capture, 'saved', message.reason === 'time-limit' ? 'Saved — 3-minute limit' : 'Saved', `${response.result.folderName}/${response.result.viewport}`);
    return response.result;
  } catch (error) {
    await manualState(capture, 'failed', 'Save failed', error.message);
    notify('Capture failed', error.message);
    throw error;
  } finally {
    const current = await readCapture();
    if (current?.startedAt === capture.startedAt) await chrome.storage.session.remove(CAPTURE_KEY);
    finishingManual = false;
  }
}

async function cancelSelection(sender) {
  const capture = await readCapture();
  if (!capture || sender.tab?.id !== capture.tabId || capture.kind !== 'selection') return;
  if (capture.phase === 'saving') throw new Error('Already saving the selection.');
  await chrome.storage.session.remove(CAPTURE_KEY);
}

async function updateCapturePhase(sender, phase) {
  const capture = await readCapture();
  if (!isCaptureSender(capture, sender)) throw new Error('No capture for this tab.');
  if (capture.phase !== phase) await chrome.storage.session.set({ [CAPTURE_KEY]: { ...capture, phase } });
}

async function handleCaptureFailure(message, sender) {
  const capture = await readCapture();
  if (!isCaptureSender(capture, sender)) return;
  await chrome.storage.session.remove(CAPTURE_KEY);
  notify('Capture failed', message.error || 'Could not save the capture.');
}

async function captureVisibleTab(sender) {
  const capture = await readCapture();
  if (!isCaptureSender(capture, sender)) throw new Error('No capture for this tab.');
  const tab = await chrome.tabs.get(capture.tabId);
  await requireCapturePage(capture);
  const activeBefore = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
  if (activeBefore?.id !== capture.tabId) throw new Error('Capture tab is no longer active. Return to it and retry.');
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const activeAfter = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
  if (activeAfter?.id !== capture.tabId) throw new Error('Tab changed during screenshot capture.');
  await requireCapturePage(capture);
  return dataUrl;
}

async function handleBundleReady(message, sender) {
  const capture = await readCapture();
  if (!isCaptureSender(capture, sender)) throw new Error('Capture details were lost.');
  if (capture.continuous) throw new Error('Manual recording is saved by the extension recorder.');
  if ((capture.kind === 'selection') !== (message.type === 'SELECTION_BUNDLE_READY')) throw new Error('Capture type does not match.');
  if (writingBundle || capture.phase === 'saving') throw new Error('Already saving this capture.');
  writingBundle = true;
  try {
    await chrome.storage.session.set({ [CAPTURE_KEY]: { ...capture, phase: 'saving' } });
    const response = await sendToOffscreen({
      type: 'OFFSCREEN_WRITE_BUNDLE',
      payload: {
        toolVersion: chrome.runtime.getManifest().version,
        kind: capture.kind,
        url: capture.url,
        title: capture.title,
        note: capture.note,
        tags: capture.tags,
        preferences: capture.preferences,
        viewportSize: capture.viewportSize,
        viewportName: capture.viewportName,
        mode: capture.mode,
        startedAt: capture.startedAt,
        video: message.video,
        screenshot: message.screenshot,
        selection: message.selection,
        html: message.html,
        tokens: message.tokens
      }
    });
    if (!response?.ok) throw new Error(response?.error || 'Bundle write failed.');
    notify('Captured',
      `${response.result.merged ? 'Merged into' : 'Wrote'} ${response.result.folderName}/${response.result.viewport}`);
    return response.result;
  } catch (err) {
    notify('Capture failed', err.message || String(err));
    throw err;
  } finally {
    try {
      const current = await readCapture();
      // Each Save writes a separate bundle while the picker session stays open.
      // Never revive a session that was replaced, closed, or navigated away.
      if (current?.startedAt === capture.startedAt && current.tabId === capture.tabId) {
        let samePage = false;
        try { samePage = (await chrome.tabs.get(capture.tabId)).url === capture.url; } catch {}
        if (capture.kind === 'selection' && samePage) {
          await chrome.storage.session.set({ [CAPTURE_KEY]: { ...capture, phase: 'selecting' } });
        } else await chrome.storage.session.remove(CAPTURE_KEY);
      }
    } finally { writingBundle = false; }
  }
}

chrome.tabs.onRemoved.addListener(tabId => {
  readCapture().then(capture => {
    if (capture?.tabId === tabId && capture.continuous) {
      if (['recording', 'stopping'].includes(capture.phase)) {
        return sendToOffscreen({ type: 'OFFSCREEN_MANUAL_STOP', captureId: capture.startedAt, reason: 'tab-closed' });
      }
      return;
    }
    if (capture?.tabId === tabId && (capture.kind === 'selection' || capture.phase !== 'saving')) {
      return chrome.storage.session.remove(CAPTURE_KEY);
    }
  }).catch(err => console.warn('[design-capture] capture cleanup failed:', err));
});

chrome.tabs.onUpdated?.addListener((tabId, change) => {
  if (!change.url && !['loading', 'complete'].includes(change.status)) return;
  readCapture().then(async capture => {
    if (capture?.tabId === tabId && capture.continuous) {
      if (capture.phase === 'recording') {
        manualAttachQueue = manualAttachQueue.catch(() => {}).then(() => attachManualPage());
        await manualAttachQueue;
      }
      return;
    }
    if (capture?.tabId === tabId && capture.kind === 'selection' && (change.url || change.status === 'loading')) {
      await chrome.storage.session.remove(CAPTURE_KEY);
      await chrome.tabs.sendMessage(tabId, { type: 'CLOSE_SELECTION' }).catch(() => {});
    } else if (capture?.tabId === tabId && capture.kind !== 'selection' && capture.phase !== 'saving') {
      // Once the bundle reaches offscreen, its write no longer needs the page.
      // Chrome can also report "loading" for a history update. The document ID
      // distinguishes those updates from an actual navigation or reload.
      try { await requireCapturePage(capture); }
      catch { await interruptCapture(capture, PAGE_CHANGED); }
    }
  }).catch(err => console.warn('[design-capture] capture navigation cleanup:', err));
});
