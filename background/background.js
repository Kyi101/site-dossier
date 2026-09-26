// Service worker: routes capture messages. Capture details live in session
// storage because Chrome can stop this worker while a recording is in progress.

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const CAPTURE_KEY = 'capture';
let creatingOffscreen = null;
let startingCapture = false;

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
  return stored[CAPTURE_KEY] || null;
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
      reasons: ['BLOBS'],
      justification: 'Decode the recorded video and write the selected local folder.'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CAPTURE_START') {
    handleCaptureStart(message)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === 'CAPTURE_STATUS') {
    readCapture()
      .then(capture => sendResponse({ ok: true, capture: capture ? { tabId: capture.tabId, phase: capture.phase, mode: capture.mode } : null }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === 'CAPTURE_STOP') {
    handleCaptureStop(message, sender)
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
  if (message.type === 'CAPTURE_BUNDLE_READY') {
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
      if (tabExists && ageMs < (existing.phase === 'starting' ? 30000 : 600000)) {
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
      note: message.note,
      tags: message.tags,
      viewportSize: message.viewportSize,
      viewportName: message.viewportName || 'desktop',
      mode: message.mode === 'manual' ? 'manual' : 'auto',
      startedAt: new Date().toISOString(),
      phase: 'starting'
    };
    await chrome.storage.session.set({ [CAPTURE_KEY]: capture });

    try {
      const streamId = await new Promise((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id, consumerTabId: tab.id }, id => {
          if (chrome.runtime.lastError || !id) {
            reject(new Error(chrome.runtime.lastError?.message || 'No stream ID'));
          } else {
            resolve(id);
          }
        });
      });

      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });

      const bannerCssResponse = await fetch(chrome.runtime.getURL('content/banner.css'));
      if (!bannerCssResponse.ok) throw new Error('Could not load capture control styles.');
      const injected = await chrome.tabs.sendMessage(tab.id, { type: 'INJECT_BANNER', css: await bannerCssResponse.text() });
      if (!injected?.ok) throw new Error(injected?.error || 'Could not show capture control.');
      const started = await chrome.tabs.sendMessage(tab.id, { type: 'START_RECORDING', streamId, mode: capture.mode });
      if (!started?.ok) throw new Error(started?.error || 'Recording failed to start.');
      await chrome.storage.session.set({ [CAPTURE_KEY]: { ...capture, phase: 'recording' } });
    } catch (err) {
      await chrome.storage.session.remove(CAPTURE_KEY);
      await chrome.tabs.sendMessage(tab.id, { type: 'REMOVE_BANNER' }).catch(() => {});
      throw err;
    }
  } catch (err) {
    notify('Recording failed to start', err.message || String(err));
    throw err;
  } finally {
    startingCapture = false;
  }
}

async function handleCaptureStop(message, sender) {
  const capture = await readCapture();
  const fromTab = sender.tab?.id === capture?.tabId;
  const fromPopup = sender.id === chrome.runtime.id && !sender.tab &&
    message.tabId === capture?.tabId;
  if (!capture || (!fromTab && !fromPopup)) throw new Error('No recording for this tab.');
  if (capture.phase !== 'recording') throw new Error('The capture is already stopping or saving.');
  await chrome.storage.session.set({ [CAPTURE_KEY]: { ...capture, phase: 'stopping' } });
  try {
    const response = await chrome.tabs.sendMessage(capture.tabId, { type: 'STOP_RECORDING' });
    if (!response?.ok) throw new Error(response?.error || 'Could not stop recording.');
  } catch (err) {
    const current = await readCapture();
    if (current?.phase === 'stopping') {
      await chrome.storage.session.set({ [CAPTURE_KEY]: { ...current, phase: 'recording' } });
    }
    throw err;
  }
}

async function updateCapturePhase(sender, phase) {
  const capture = await readCapture();
  if (!capture || sender.tab?.id !== capture.tabId) throw new Error('No capture for this tab.');
  if (capture.phase !== phase) await chrome.storage.session.set({ [CAPTURE_KEY]: { ...capture, phase } });
}

async function handleCaptureFailure(message, sender) {
  const capture = await readCapture();
  if (!capture || sender.tab?.id !== capture.tabId) return;
  await chrome.storage.session.remove(CAPTURE_KEY);
  notify('Capture failed', message.error || 'Could not save the capture.');
}

async function captureVisibleTab(sender) {
  const capture = await readCapture();
  if (!capture || sender.tab?.id !== capture.tabId) throw new Error('No capture for this tab.');
  const tab = await chrome.tabs.get(capture.tabId);
  const activeBefore = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
  if (activeBefore?.id !== capture.tabId) throw new Error('Capture tab is no longer active. Return to it and retry.');
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const activeAfter = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
  if (activeAfter?.id !== capture.tabId) throw new Error('Tab changed during screenshot capture.');
  return dataUrl;
}

async function handleBundleReady(message, sender) {
  const capture = await readCapture();
  if (!capture || sender.tab?.id !== capture.tabId) throw new Error('Capture details were lost.');
  await chrome.storage.session.set({ [CAPTURE_KEY]: { ...capture, phase: 'saving' } });
  try {
    const response = await sendToOffscreen({
      type: 'OFFSCREEN_WRITE_BUNDLE',
      payload: {
        url: capture.url,
        note: capture.note,
        tags: capture.tags,
        viewportSize: capture.viewportSize,
        viewportName: capture.viewportName,
        mode: capture.mode,
        startedAt: capture.startedAt,
        video: message.video,
        screenshot: message.screenshot,
        html: message.html,
        tokens: message.tokens
      }
    });
    if (!response?.ok) throw new Error(response?.error || 'Bundle write failed.');
    notify('Captured', `${response.result.merged ? 'Merged into' : 'Wrote'} ${response.result.folderName}/${response.result.viewport}`);
    return response.result;
  } catch (err) {
    notify('Capture failed', err.message || String(err));
    throw err;
  } finally {
    await chrome.storage.session.remove(CAPTURE_KEY);
  }
}

chrome.tabs.onRemoved.addListener(tabId => {
  readCapture().then(capture => {
    if (capture?.tabId === tabId && capture.phase !== 'saving') {
      return chrome.storage.session.remove(CAPTURE_KEY);
    }
  }).catch(err => console.warn('[design-capture] capture cleanup failed:', err));
});
