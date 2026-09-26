const badgeEl = document.getElementById('state-badge');
const pageHostEl = document.getElementById('page-host');
const folderNameEl = document.getElementById('folder-name');
const folderHintEl = document.getElementById('folder-hint');
const guidanceEl = document.getElementById('guidance');
const messageEl = document.getElementById('message');
const noteEl = document.getElementById('note');
const tagsEl = document.getElementById('tags');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const manualModeEl = document.getElementById('mode-manual');
const autoModeEl = document.getElementById('mode-auto');
const pickDirBtn = document.getElementById('pick-dir');

const helpToggleBtn = document.getElementById('help-toggle');
const helpBackBtn = document.getElementById('help-back');
const helpView = document.getElementById('help-view');
const captureView = document.getElementById('capture-view');
function showHelp(open) {
  helpView.hidden = !open;
  captureView.hidden = open;
  helpToggleBtn.setAttribute('aria-expanded', String(open));
  (open ? document.getElementById('help-heading') : helpToggleBtn).focus();
}
helpToggleBtn.addEventListener('click', () => showHelp(helpView.hidden));
helpBackBtn.addEventListener('click', () => showHelp(false));
helpView.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    showHelp(false);
  }
});


let activeTab = null;
let folderHandle = null;
let folderPermission = 'prompt';
let folderUnavailable = false;
let capture = null;
let statusUnavailable = false;
let loading = true;
let busy = false;
let busyAction = null;
let folderChosen = false;

render();
void initialize();

async function initialize() {
  const [tabResult, folderResult, statusResult] = await Promise.allSettled([
    chrome.tabs.query({ active: true, currentWindow: true }),
    readStoredHandle(),
    chrome.runtime.sendMessage({ type: 'CAPTURE_STATUS' })
  ]);

  if (tabResult.status === 'fulfilled') activeTab = tabResult.value[0] || null;
  if (folderResult.status === 'fulfilled' && !folderChosen) folderHandle = folderResult.value;
  if (statusResult.status === 'fulfilled' && statusResult.value?.ok) {
    capture = statusResult.value.capture;
  } else {
    statusUnavailable = true;
  }
  if (folderHandle && !folderChosen) {
    try { folderPermission = await folderHandle.queryPermission({ mode: 'readwrite' }); }
    catch { folderPermission = 'prompt'; folderUnavailable = true; }
  }

  loading = false;
  if (tabResult.status === 'rejected') showError('Could not read the current tab. Reopen the popup and try again.');
  else if (folderResult.status === 'rejected') showError('Could not read the saved folder. Choose a folder again.');
  else if (statusUnavailable) showError('Could not check whether a capture is already running. Reopen the popup and try again.');
  render();
}

function render() {
  const recordable = activeTab && isRecordableUrl(activeTab.url);
  const captureActive = Boolean(capture);
  const canStart = !loading && !busy && !statusUnavailable && recordable && folderHandle && !folderUnavailable && !captureActive;

  pageHostEl.textContent = loading ? 'Checking…' : activeTab ? safeHost(activeTab.url) : 'No active tab';
  pageHostEl.title = activeTab?.title || '';

  folderNameEl.textContent = folderHandle?.name || 'No folder selected';
  folderHintEl.textContent = folderUnavailable
    ? 'Choose a folder again.'
    : folderHandle
      ? folderPermission === 'denied' ? 'Folder access was denied. Try Start again or choose another folder.' : ''
      : 'Choose or create a folder inside Desktop, Documents, or another location.';
  folderHintEl.hidden = !folderHintEl.textContent;
  pickDirBtn.textContent = busyAction === 'folder' ? 'Choosing…' : folderHandle ? 'Change' : 'Choose';
  pickDirBtn.disabled = busy || captureActive;
  noteEl.disabled = loading || busy || captureActive || !recordable;
  tagsEl.disabled = noteEl.disabled;
  autoModeEl.disabled = loading || busy || captureActive;
  manualModeEl.disabled = autoModeEl.disabled;
  startBtn.disabled = !canStart;
  startBtn.hidden = captureActive;
  startBtn.textContent = busyAction === 'start' ? 'Starting…' :
    manualModeEl.checked ? 'Start manual recording' : 'Start auto capture';
  stopBtn.hidden = !captureActive || capture.phase !== 'recording';
  stopBtn.disabled = busy;

  if (loading || busy) {
    setBadge(busyAction === 'folder' ? 'Choosing folder' :
      busyAction === 'start' ? 'Starting' : busyAction === 'stop' ? 'Stopping' : 'Checking', 'neutral');
    guidanceEl.textContent = busyAction === 'folder' ? 'Choose a local folder to save captures.' :
      busyAction === 'start' ? 'Preparing your capture…' :
      busyAction === 'stop' ? 'Stopping the recording…' : 'Checking page and folder…';
  } else if (captureActive) {
    setBadge(['processing', 'saving'].includes(capture.phase) ? 'Saving' :
      capture.phase === 'stopping' ? 'Stopping' : 'Recording', 'attention');
    guidanceEl.textContent = capture.phase === 'recording'
      ? capture.mode === 'manual'
        ? 'Manual recording is active. Stop from here or the page bar.'
        : 'Auto recording is active. Stop from here or the page bar.'
      : ['processing', 'saving'].includes(capture.phase) ? 'Saving to your selected folder…' : 'Stopping the recording…';
  } else if (statusUnavailable) {
    setBadge('Unavailable', 'blocked');
    guidanceEl.textContent = 'Reopen the popup to check capture status.';
  } else if (!activeTab) {
    setBadge('No tab', 'blocked');
    guidanceEl.textContent = 'Open an HTTPS page and click Site Dossier again.';
  } else if (!recordable) {
    setBadge('Unavailable', 'blocked');
    guidanceEl.textContent = 'Open a regular HTTPS page or localhost to capture.';
  } else if (!folderHandle) {
    setBadge('Select folder', 'attention');
    guidanceEl.textContent = 'Choose a folder to continue. Chrome blocks Desktop itself; choose a folder inside it.';
  } else if (folderUnavailable) {
    setBadge('Folder unavailable', 'blocked');
    guidanceEl.textContent = 'Choose a folder again to continue.';
  } else if (folderPermission === 'denied') {
    setBadge('Access denied', 'blocked');
    guidanceEl.textContent = 'Try Start again, or choose another folder.';
  } else {
    setBadge('', 'neutral');
    guidanceEl.textContent = manualModeEl.checked
      ? 'You control the page and stop when ready.'
      : 'The page scrolls, records, and saves automatically.';
  }
}

function setBadge(label, tone) {
  badgeEl.hidden = !label;
  badgeEl.textContent = label;
  badgeEl.dataset.tone = tone;
}

function showError(message) {
  messageEl.textContent = message;
  messageEl.hidden = false;
}

function clearError() {
  messageEl.textContent = '';
  messageEl.hidden = true;
}

pickDirBtn.addEventListener('click', async () => {
  busy = true;
  busyAction = 'folder';
  clearError();
  render();
  try {
    const handle = await window.showDirectoryPicker({
      mode: 'readwrite', id: 'site-dossier-local', startIn: 'downloads'
    });
    await storeDirHandle(handle);
    folderChosen = true;
    folderHandle = handle;
    folderUnavailable = false;
    try { folderPermission = await handle.queryPermission({ mode: 'readwrite' }); }
    catch { folderPermission = 'prompt'; folderUnavailable = true; }
  } catch (err) {
    if (err?.name !== 'AbortError') showError(`Could not choose a folder: ${err.message || err}`);
  } finally {
    busy = false;
    busyAction = null;
    render();
  }
});

startBtn.addEventListener('click', async () => {
  if (startBtn.disabled) return;
  busy = true;
  busyAction = 'start';
  clearError();
  render();

  try {
    // The offscreen document cannot request folder permission itself.
    folderPermission = await folderHandle.queryPermission({ mode: 'readwrite' });
    if (folderPermission !== 'granted') {
      folderPermission = await folderHandle.requestPermission({ mode: 'readwrite' });
    }
    if (folderPermission !== 'granted') throw new Error('Folder access was not granted.');

    await deliverHandleToOffscreen(folderHandle);
    const viewportName = (activeTab.width && activeTab.width < 768) ? 'mobile' : 'desktop';
    const response = await chrome.runtime.sendMessage({
      type: 'CAPTURE_START',
      tabId: activeTab.id,
      url: activeTab.url,
      note: noteEl.value.trim(),
      tags: tagsEl.value.split(',').map(t => t.trim()).filter(Boolean),
      viewportSize: { width: activeTab.width || 0, height: activeTab.height || 0 },
      viewportName,
      mode: manualModeEl.checked ? 'manual' : 'auto'
    });
    if (!response?.ok) throw new Error(response?.error || 'Recording failed to start.');
    window.close();
  } catch (err) {
    showError(`Could not start: ${err.message || err}`);
    busy = false;
    busyAction = null;
    render();
  }
});

manualModeEl.addEventListener('change', render);
autoModeEl.addEventListener('change', render);

stopBtn.addEventListener('click', async () => {
  if (stopBtn.disabled || !capture || capture.phase !== 'recording') return;
  busy = true;
  busyAction = 'stop';
  clearError();
  render();
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_STOP', tabId: capture.tabId });
    if (!response?.ok) throw new Error(response?.error || 'Could not stop recording.');
    capture = { ...capture, phase: 'saving' };
  } catch (err) {
    showError(`Could not stop: ${err.message || err}`);
  } finally {
    busy = false;
    busyAction = null;
    render();
  }
});

async function deliverHandleToOffscreen(handle) {
  // Ensure offscreen document exists and has subscribed to the channel.
  const ensureRes = await chrome.runtime.sendMessage({ type: 'ENSURE_OFFSCREEN_READY' });
  if (!ensureRes?.ok) throw new Error('Could not prepare saving: ' + (ensureRes?.error || 'unknown error'));

  // BroadcastChannel preserves the handle's methods; runtime messages do not.
  const channel = new BroadcastChannel('design-capture-handles');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      channel.close();
      reject(new Error('Could not connect to the saving process. Try again.'));
    }, 2000);
    channel.onmessage = (e) => {
      if (e.data?.type === 'ACK') {
        clearTimeout(timeout);
        channel.close();
        resolve();
      }
    };
    channel.postMessage({ type: 'HANDLE', handle });
  });
}

function capturePhase(phase) {
  return ({ starting: 'starting', recording: 'recording', stopping: 'stopping', processing: 'processing', saving: 'saving' })[phase] || 'in progress';
}

function isRecordableUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ||
      (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname));
  } catch {
    return false;
  }
}

function safeHost(url) {
  if (!url) return 'Restricted page';
  try { return new URL(url).host || 'Local page'; } catch { return 'Restricted page'; }
}

// IndexedDB helpers — shared schema with offscreen.js.
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('design-capture', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('config');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readStoredHandle() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('config', 'readonly');
    const req = tx.objectStore('config').get('inspoDirHandle');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function storeDirHandle(handle) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('config', 'readwrite');
    tx.objectStore('config').put(handle, 'inspoDirHandle');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
