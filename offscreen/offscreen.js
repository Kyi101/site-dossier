const statusEl = document.getElementById('status');

const handleChannel = new BroadcastChannel('design-capture-handles');
let cachedDirHandle = null;
let manualRecording = null;
handleChannel.onmessage = (e) => {
  if (e.data?.type === 'HANDLE') {
    cachedDirHandle = e.data.handle;
    handleChannel.postMessage({ type: 'ACK' });
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  if (message.type === 'OFFSCREEN_PING') {
    statusEl.textContent = `Ping at ${new Date().toISOString()}`;
    sendResponse({ ok: true, pong: true });
    return true;
  }

  if (message.type === 'OFFSCREEN_MANUAL_START') {
    startManualRecording(message).then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === 'OFFSCREEN_MANUAL_STOP') {
    try { stopManualRecording(message.captureId, message.reason); sendResponse({ ok: true }); }
    catch (err) { sendResponse({ ok: false, error: err.message }); }
    return false;
  }
  if (message.type === 'OFFSCREEN_MANUAL_PAGE') {
    const recording = manualRecording;
    if (!recording || recording.capture.startedAt !== message.captureId) {
      sendResponse({ ok: false, error: 'Recording details were lost.' });
      return false;
    }
    if (['saving', 'saved', 'failed'].includes(recording.phase)) {
      sendResponse({ ok: false, error: 'Page sampling has finished.' });
      return false;
    }
    const existing = recording.pages.find(saved => saved.documentId === message.page.documentId);
    const page = { ...existing, ...message.page };
    page.errors = [...new Set([...(existing?.errors || []), ...(message.page.errors || [])])];
    if (existing) {
      for (const key of ['entryUrl', 'visitedAt', 'videoOffsetS']) if (existing[key] !== undefined) page[key] = existing[key];
    }
    if (message.visit && recording.visits.length < 200) recording.visits.push({
      documentId: page.documentId, url: message.page.entryUrl, videoOffsetS: message.page.videoOffsetS, visitedAt: message.page.visitedAt });
    if (page.html && new Blob([page.html]).size > 4 * 1024 * 1024) {
      page.html = null;
      page.errors.push('HTML snapshot exceeded the 4 MiB page limit.');
    }
    const priorBytes = existing ? new Blob([JSON.stringify(existing)]).size : 0;
    const nextBytes = new Blob([JSON.stringify(page)]).size;
    const total = (recording.evidenceBytes || 0) - priorBytes + nextBytes;
    if (total > 48 * 1024 * 1024) {
      if (existing) existing.errors.push('Later page evidence exceeded the recording memory limit.');
      else if (!recording.omittedDocuments.has(page.documentId)) { recording.omittedDocuments.add(page.documentId); recording.omittedPages++; }
      sendResponse({ ok: true });
      return false;
    }
    if (existing) {
      Object.assign(existing, page);
    } else if (recording.pages.length < 24) {
      recording.pages.push(page);
    } else {
      if (!recording.omittedDocuments.has(page.documentId)) { recording.omittedDocuments.add(page.documentId); recording.omittedPages++; }
      sendResponse({ ok: true }); return false;
    }
    recording.evidenceBytes = total;
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'OFFSCREEN_MANUAL_SAVE') {
    saveManualRecording(message.captureId).then(result => sendResponse({ ok: true, result }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === 'OFFSCREEN_MANUAL_CANCEL') {
    const recording = manualRecording;
    if (recording?.capture.startedAt === message.captureId) {
      recording.cancelled = true;
      clearTimeout(recording.timer);
      if (recording.recorder.state !== 'inactive') recording.recorder.stop();
      recording.stream.getTracks().forEach(track => track.stop());
      manualRecording = null;
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'OFFSCREEN_WRITE_BUNDLE') {
    statusEl.textContent = 'Writing bundle…';
    writeBundle(message.payload)
      .then(result => sendResponse({ ok: true, result }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});

async function startManualRecording(message) {
  if (manualRecording && !['saved', 'failed'].includes(manualRecording.phase)) throw new Error('A manual recording is already active.');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false,
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } } });
  let recorder;
  try { recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' }); }
  catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
  const recording = { capture: message.capture, recorder, stream, chunks: [], pages: [{
    documentId: message.capture.documentId, url: message.capture.url, entryUrl: message.capture.url,
    title: message.capture.title, visitedAt: message.capture.startedAt, videoOffsetS: 0, errors: [] }], visits: [], omittedPages: 0, omittedDocuments: new Set(),
    phase: 'recording', beganAt: Date.now(), reason: null, cancelled: false, blob: null };
  manualRecording = recording;
  recorder.ondataavailable = event => { if (!recording.cancelled && event.data?.size) recording.chunks.push(event.data); };
  recorder.onstop = async () => {
    clearTimeout(recording.timer);
    if (recording.cancelled) return;
    recording.stream.getTracks().forEach(track => track.stop());
    recording.stoppedAt ||= Date.now();
    recording.reason ||= 'stream-ended';
    recording.blob = new Blob(recording.chunks, { type: 'video/webm' });
    recording.chunks = [];
    recording.phase = 'processing';
    try {
      const response = await chrome.runtime.sendMessage({ type: 'MANUAL_VIDEO_READY', captureId: recording.capture.startedAt,
        reason: recording.reason, durationS: (recording.stoppedAt - recording.beganAt) / 1000 });
      if (!response?.ok) throw new Error(response?.error || 'Could not finish manual recording.');
    } catch (error) {
      recording.phase = 'failed';
      statusEl.textContent = 'Recording could not be saved: ' + error.message;
    }
  };
  for (const track of stream.getTracks()) track.addEventListener('ended', () => {
    if (!recording.cancelled && manualRecording === recording) stopManualRecording(recording.capture.startedAt, 'stream-ended');
  }, { once: true });
  try { recorder.start(1000); }
  catch (error) { recording.cancelled = true; stream.getTracks().forEach(track => track.stop()); manualRecording = null; throw error; }
  recording.timer = setTimeout(() => stopManualRecording(recording.capture.startedAt, 'time-limit'), 180000);
}

function stopManualRecording(captureId, reason = 'user') {
  const recording = manualRecording;
  if (!recording || recording.capture.startedAt !== captureId) throw new Error('No manual recording for this capture.');
  if (recording.recorder.state === 'inactive') return;
  recording.reason = reason;
  recording.stoppedAt = Date.now();
  recording.phase = 'stopping';
  clearTimeout(recording.timer);
  recording.recorder.stop();
}

async function saveManualRecording(captureId) {
  const recording = manualRecording;
  if (!recording || recording.capture.startedAt !== captureId || !recording.blob) throw new Error('Recorded video is unavailable.');
  if (recording.phase === 'saving' || recording.phase === 'saved') throw new Error('Already saving this recording.');
  recording.phase = 'saving';
  try {
    const first = recording.pages[0] || {};
    const result = await writeBundle({ ...recording.capture,
      video: { blob: recording.blob, size: recording.blob.size,
        durationS: (recording.stoppedAt - recording.beganAt) / 1000, stopReason: recording.reason },
      screenshot: first.screenshot || {}, html: first.html || '', tokens: first.tokens || {},
      journeyPages: recording.pages, journeyVisits: recording.visits, omittedPages: recording.omittedPages });
    recording.phase = 'saved';
    recording.blob = null;
    recording.pages = [];
    recording.visits = [];
    return result;
  } catch (error) { recording.phase = 'failed'; throw error; }
}

async function writeBundle(payload) {
  const handle = cachedDirHandle;
  if (!handle) throw new Error('No inspo folder handle cached. Open popup and click Start (which posts the handle).');
  const isSelection = payload.kind === 'selection';
  if (isSelection) validateSelections(payload.selection);

  // New folders keep the first capture's date; later captures reuse that folder.
  const url = new URL(payload.url);
  const host = url.host.replace(/^www\./, '').replace(/\./g, '-');
  const date = payload.startedAt.split('T')[0];
  // Sanitize for Windows: strip < > : " / \ | ? * and any control chars,
  // collapse repeats, trim trailing dots/spaces/dashes.
  const baseFolderName = `${host}-${date}`
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/-+/g, '-')
    .replace(/[. -]+$/, '');
  const viewportName = (isSelection ? 'selection-' : '') + (payload.viewportName === 'mobile' ? 'mobile' : 'desktop');
  const preferences = normalizePreferences(payload.preferences);
  const warnings = [];

  // Search the selected library by exact URL before allocating a dated folder.
  const existingBundle = await findPageBundle(handle, payload.url);
  let bundleDir = existingBundle?.bundleDir;
  let isMerge = Boolean(existingBundle);
  let folderName = existingBundle?.folderName || baseFolderName;
  for (let n = 1; !bundleDir; n++) {
    folderName = n === 1 ? baseFolderName : `${baseFolderName}-${n}`;
    let candidate;
    try {
      candidate = await handle.getDirectoryHandle(folderName, { create: false });
    } catch (err) {
      if (err.name !== 'NotFoundError') throw err;
      bundleDir = await handle.getDirectoryHandle(folderName, { create: true });
      break;
    }
    // Recheck in case a matching folder appeared after the library scan.
    if (await readBundleUrl(candidate) === payload.url) {
      bundleDir = candidate;
      isMerge = true;
    }
  }

  // Viewport subfolder. If THIS viewport already exists inside the bundle
  // (user captured desktop before), suffix -2, -3, etc.
  let viewportDir;
  let viewportDirName = viewportName;
  if (isMerge) {
    let n = 2;
    let tryName = viewportName;
    while (true) {
      try {
        await bundleDir.getDirectoryHandle(tryName, { create: false });
        tryName = `${viewportName}-${n}`;
        n++;
      } catch (err) {
        if (err.name !== 'NotFoundError') throw err;
        viewportDirName = tryName;
        break;
      }
    }
  }
  viewportDir = await bundleDir.getDirectoryHandle(viewportDirName, { create: true });

  if (isSelection) return writeSelectionBundle(payload, { handle, bundleDir, viewportDir, folderName, viewportDirName, isMerge, warnings });
  if (!payload.journeyPages && !payload.screenshot?.dataUrl) throw new Error('Page screenshot unavailable.');

  // Viewport-specific must-succeed files (fast writes, before any long-running step).
  // Chrome's File System Access handles can go stale during long idle waits — get
  // everything important on disk early so a contact-sheet failure doesn't drop the bundle.
  const videoBlob = payload.video.blob || await dataUrlToBlob(payload.video.dataUrl);
  await writeFile(viewportDir, 'scroll.webm', videoBlob);
  if (payload.screenshot.dataUrl) await writeFile(viewportDir, 'page.jpg', await dataUrlToBlob(payload.screenshot.dataUrl));
  await writeFile(viewportDir, 'page.html', new Blob([payload.html], { type: 'text/html' }));
  // Each capture keeps its own context, including repeated and mobile captures.
  await writeFile(viewportDir, 'note.md', new Blob([buildNoteMd(payload)]));
  await writeFile(viewportDir, 'tokens.json', new Blob([JSON.stringify(payload.tokens, null, 2)]));

  // Preserve the original root files for existing bundle consumers.
  // Moved BEFORE the contact-sheet step so they're not at risk of stale-handle errors.
  if (!isMerge) {
    await writeFile(bundleDir, 'url.txt', new Blob([payload.url + '\n']));
    await writeFile(bundleDir, 'note.md', new Blob([buildNoteMd(payload)]));
    await writeFile(bundleDir, 'tokens.json', new Blob([JSON.stringify(payload.tokens, null, 2)]));
  }

  // Save intent and source metadata before waiting for video decoding.
  const meta = {
    schema_version: 2,
    capture_kind: 'page',
    url: payload.url,
    host: url.host,
    title: payload.title || null,
    captured_at: payload.startedAt,
    viewport: viewportDirName,
    viewport_size: payload.viewportSize,
    capture_mode: payload.mode || 'auto',
    note_file: 'note.md',
    tags: payload.tags || [],
    user_preferences: preferences,
    video: {
      duration_s: payload.video.durationS || null,
      recording_elapsed_s: payload.video.durationS || null,
      duration_basis: 'recording-elapsed-estimate',
      stop_reason: payload.video.stopReason || null,
      file: 'scroll.webm',
      contact_sheet: null,
      frames_sampled: 0
    },
    screenshot: { file: payload.screenshot.dataUrl ? 'page.jpg' : null, stop_reason: payload.screenshot.stopReason || null,
      ...(payload.screenshot.scope ? { scope: payload.screenshot.scope } : {}) },
    tool_version: payload.toolVersion
  };
  if (payload.journeyPages) {
    const pagesDir = await viewportDir.getDirectoryHandle('pages', { create: true });
    const pages = [];
    for (const [index, page] of payload.journeyPages.entries()) {
      const folder = String(index + 1).padStart(3, '0');
      const dir = await pagesDir.getDirectoryHandle(folder, { create: true });
      if (page.html) await writeFile(dir, 'page.html', new Blob([page.html], { type: 'text/html' }));
      if (page.tokens) await writeFile(dir, 'tokens.json', new Blob([JSON.stringify(page.tokens, null, 2)]));
      if (page.screenshot?.dataUrl) await writeFile(dir, 'page.jpg', await dataUrlToBlob(page.screenshot.dataUrl));
      const entry = { url: page.url, entry_url: page.entryUrl, title: page.title || null,
        visited_at: page.visitedAt, sampled_at: page.sampledAt || null, video_offset_s: page.videoOffsetS,
        viewport_size: page.viewportSize || null, folder,
        html_file: page.html ? folder + '/page.html' : null, tokens_file: page.tokens ? folder + '/tokens.json' : null,
        screenshot_file: page.screenshot?.dataUrl ? folder + '/page.jpg' : null,
        screenshot_scope: page.screenshot?.scope || null, errors: page.errors || [] };
      await writeFile(dir, 'meta.json', new Blob([JSON.stringify(entry, null, 2)]));
      pages.push(entry);
    }
    const visits = (payload.journeyVisits || []).map(visit => {
      const index = payload.journeyPages.findIndex(page => page.documentId === visit.documentId);
      return { url: visit.url, visited_at: visit.visitedAt, video_offset_s: visit.videoOffsetS,
        page_folder: index < 0 ? null : String(index + 1).padStart(3, '0') };
    });
    await writeFile(pagesDir, 'index.json', new Blob([JSON.stringify({ schema_version: 1, video_file: '../scroll.webm',
      pages, visits, omitted_pages: payload.omittedPages || 0, max_page_snapshots: 24, max_evidence_bytes: 48 * 1024 * 1024 }, null, 2)]));
    meta.recording_pages = { index_file: 'pages/index.json', saved: pages.length, omitted: payload.omittedPages || 0 };
  }
  const evidence = payload.screenshot.evidence;
  if (evidence) {
    const { tiles, ...measurements } = evidence;
    Object.assign(meta.screenshot, measurements);
    const savedTiles = [];
    try {
      const dir = await viewportDir.getDirectoryHandle('page-tiles', { create: true });
      for (const [index, tile] of (tiles || []).slice(0, 24).entries()) {
        const file = `tile-${String(index + 1).padStart(3, '0')}.jpg`;
        await writeFile(dir, file, await dataUrlToBlob(tile.dataUrl));
        const { dataUrl, ...position } = tile;
        savedTiles.push({ file, ...position });
      }
      await writeFile(dir, 'index.json', new Blob([JSON.stringify({ schema_version: 1, ...measurements, tiles: savedTiles }, null, 2)]));
      meta.screenshot.tiles_file = 'page-tiles/index.json';
    } catch (err) {
      warnings.push('Some readable page tiles could not be saved; the page overview is saved.');
      console.warn('[design-capture] page tiles:', err);
    }
    meta.screenshot.tiles_saved = savedTiles.length;
    // Sampling is expected. Its coverage stays in metadata/index; only failed
    // writes above should turn a successful capture into a warning.
  }
  await writeFile(viewportDir, 'meta.json', new Blob([JSON.stringify(meta, null, 2)]));

  // Folder guidance is optional; a conflict or write failure must not lose a capture.
  try {
    await ensureFolderGuidance(handle);
  } catch (err) {
    console.warn('[design-capture] folder guidance write failed:', err.message || err);
    warnings.push('Folder reading guide unavailable. Capture files are saved; check folder access and guide filenames.');
  }

  // Readable frames and contact sheet share one decoder. Abort stops seeking,
  // avoiding late writes after the capture has been reported as complete.
  const frames = [];
  const controller = new AbortController();
  const frameTimer = setTimeout(() => controller.abort(), 60000);
  try {
    const dir = await viewportDir.getDirectoryHandle('video-frames', { create: true });
    const videoEvidence = await generateVideoEvidence(videoBlob, payload.video.durationS, async (blob, sample) => {
      controller.signal.throwIfAborted();
      const file = `frame-${String(frames.length + 1).padStart(3, '0')}.jpg`;
      await writeFile(dir, file, blob);
      frames.push({ file, ...sample });
    }, controller.signal);
    await writeFile(viewportDir, 'scroll-sheet.png', videoEvidence.sheet);
    meta.video.duration_s = videoEvidence.duration_s;
    meta.video.duration_basis = videoEvidence.duration_basis;
    meta.video.contact_sheet = 'scroll-sheet.png';
  } catch (err) {
    console.warn('[design-capture] video evidence:', err.message || err);
    warnings.push('Video stills are incomplete or unavailable; the recording is saved.');
  } finally {
    clearTimeout(frameTimer);
  }
  meta.video.frames_sampled = frames.length;
  if (frames.length) {
    try {
      const dir = await viewportDir.getDirectoryHandle('video-frames');
      await writeFile(dir, 'index.json', new Blob([JSON.stringify({ schema_version: 1, video_file: '../scroll.webm', frames }, null, 2)]));
      meta.video.frames_file = 'video-frames/index.json';
    } catch { warnings.push('Video frame index could not be saved.'); }
  }
  meta.warnings = warnings;
  try {
    await writeFile(viewportDir, 'meta.json', new Blob([JSON.stringify(meta, null, 2)]));
  } catch {
    warnings.push('Additional previews were saved but their metadata could not be updated.');
  }

  statusEl.textContent = `${isMerge ? 'Merged into' : 'Wrote'} ${folderName}/${viewportDirName}/`;
  return { folderName, viewport: viewportDirName, merged: isMerge, warnings };
}

async function readBundleUrl(dir) {
  try {
    const file = await dir.getFileHandle('url.txt', { create: false });
    return (await (await file.getFile()).text()).trim();
  } catch (err) {
    // Missing or non-file URL markers are not capture bundles. Real I/O errors
    // must surface rather than silently creating a second folder for a page.
    if (['NotFoundError', 'TypeMismatchError'].includes(err.name)) return null;
    throw err;
  }
}

async function findPageBundle(root, sourceUrl) {
  const matches = [];
  for await (const [folderName, bundleDir] of root.entries()) {
    if (bundleDir.kind !== 'directory') continue;
    if (await readBundleUrl(bundleDir) === sourceUrl) matches.push({ folderName, bundleDir });
  }
  // Older releases could create one folder per day. Prefer the earliest dated
  // match, then name order, without relying on filesystem enumeration order.
  const key = ({ folderName }) =>
    (folderName.match(/-(\d{4}-\d{2}-\d{2})(?:-\d+)?$/)?.[1] || '\uffff') + '/' + folderName;
  matches.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  return matches[0] || null;
}

function validateSelections(selection) {
  if (!selection || !Array.isArray(selection.items) || selection.items.length < 1 || selection.items.length > 8) {
    throw new Error('Choose between one and eight elements, or one rectangle.');
  }
  for (const item of selection.items) {
    if (!['element', 'rectangle'].includes(item.kind)) throw new Error('Unknown selection type.');
    SiteDossierCapture.pixelBounds(item.bounds, selection.viewport, selection.viewport);
  }
}

async function writeSelectionBundle(payload, { handle, bundleDir, viewportDir, folderName, viewportDirName, isMerge, warnings }) {
  const source = await decodeImage(payload.screenshot.dataUrl);
  const items = [];
  for (const [index, item] of payload.selection.items.entries()) {
    const id = `selection-${String(index + 1).padStart(2, '0')}`;
    const bounds = SiteDossierCapture.pixelBounds(item.bounds, payload.selection.viewport, { width: source.naturalWidth, height: source.naturalHeight });
    if (bounds.width * bounds.height > 16000000 || Math.max(bounds.width, bounds.height) > 8192) throw new Error('Selection image is too large. Zoom out and retry.');
    const canvas = document.createElement('canvas');
    canvas.width = bounds.width;
    canvas.height = bounds.height;
    canvas.getContext('2d').drawImage(source, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
    await writeFile(viewportDir, `${id}.png`, await canvasBlob(canvas, 'image/png'));
    const { structure, ...description } = item;
    const entry = { ...description, id, file: `${id}.png`, pixel_bounds: bounds };
    if (item.kind === 'element' && structure) {
      entry.structure_file = `${id}.json`;
      await writeFile(viewportDir, entry.structure_file, new Blob([JSON.stringify(structure, null, 2)]));
    }
    items.push(entry);
  }
  const context = document.createElement('canvas');
  const scale = Math.min(1, 1280 / Math.max(source.naturalWidth, source.naturalHeight));
  context.width = Math.round(source.naturalWidth * scale);
  context.height = Math.round(source.naturalHeight * scale);
  context.getContext('2d').drawImage(source, 0, 0, context.width, context.height);
  await writeFile(viewportDir, 'context.jpg', await canvasBlob(context, 'image/jpeg', 0.9));
  await writeFile(viewportDir, 'note.md', new Blob([buildNoteMd(payload)]));
  const selection = { schema_version: 1, captured_at: payload.selection.captured_at,
    viewport: payload.selection.viewport, motion: payload.selection.motion || null, context_file: 'context.jpg', context_px: { width: context.width, height: context.height },
    source_image_px: { width: source.naturalWidth, height: source.naturalHeight }, items };
  await writeFile(viewportDir, 'selections.json', new Blob([JSON.stringify(selection, null, 2)]));
  if (!isMerge) {
    await writeFile(bundleDir, 'url.txt', new Blob([payload.url + '\n']));
    await writeFile(bundleDir, 'note.md', new Blob([buildNoteMd(payload)]));
  }
  try { await ensureFolderGuidance(handle); }
  catch { warnings.push('Folder reading guide unavailable. Capture files are saved; check folder access and guide filenames.'); }
  const meta = { schema_version: 2, capture_kind: 'selection', url: payload.url, title: payload.title || null,
    captured_at: payload.selection.captured_at, started_at: payload.startedAt, viewport: viewportDirName,
    viewport_size: payload.selection.viewport, capture_mode: payload.selection.items[0].kind,
    note_file: 'note.md', tags: payload.tags || [], user_preferences: normalizePreferences(payload.preferences),
    selection: { file: 'selections.json', count: items.length }, screenshot: { file: 'context.jpg', stop_reason: 'selection' },
    video: null, tool_version: payload.toolVersion, warnings };
  await writeFile(viewportDir, 'meta.json', new Blob([JSON.stringify(meta, null, 2)]));
  return { folderName, viewport: viewportDirName, merged: isMerge, warnings };
}

async function ensureFolderGuidance(root) {
  // Version the skill format separately from extension releases. Create only:
  // neither a repeat capture nor an extension update replaces user edits.
  const owned = await root.getDirectoryHandle('.site-dossier', { create: true });
  const skills = await owned.getDirectoryHandle('skills', { create: true });
  const reader = await skills.getDirectoryHandle('use-site-dossier-v2', { create: true });
  await copyGuidanceIfMissing(reader, 'SKILL.md', 'reference/use-site-dossier/SKILL.md');
  // Write the entry last, so a newly created entry never points at a missing skill.
  await copyGuidanceIfMissing(root, 'SITE-DOSSIER.md', 'reference/SITE-DOSSIER.md');
  // Upgrade only the exact previously shipped entry, never a user's edited guide.
  const entry = await root.getFileHandle('SITE-DOSSIER.md');
  const text = await (await entry.getFile()).text();
  const previous = await fetch(chrome.runtime.getURL('reference/legacy-entry-v1.md'));
  if (previous.ok && text === await previous.text()) {
    const current = await fetch(chrome.runtime.getURL('reference/SITE-DOSSIER.md'));
    if (!current.ok) throw new Error('Could not update folder guide.');
    await writeFile(root, 'SITE-DOSSIER.md', await current.blob());
  }
}

async function copyGuidanceIfMissing(dir, name, source) {
  try {
    const existing = await dir.getFileHandle(name, { create: false });
    if ((await existing.getFile()).size === 0) throw new Error(`${name} is empty; rename or remove it to regenerate the guide`);
    return;
  } catch (err) {
    if (err.name !== 'NotFoundError') throw err;
  }
  const response = await fetch(chrome.runtime.getURL(source));
  if (!response.ok) throw new Error(`Could not load ${source}`);
  const blob = await response.blob();
  try {
    await writeFile(dir, name, blob);
  } catch (err) {
    // A failed first write can leave a new empty file. Remove only that empty
    // placeholder so the next capture can retry; never remove nonempty content.
    try {
      const created = await dir.getFileHandle(name, { create: false });
      if ((await created.getFile()).size === 0) await dir.removeEntry(name);
    } catch {}
    throw err;
  }
}

async function writeFile(dirHandle, name, blob) {
  const fileHandle = await dirHandle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (err) {
    try { await writable.abort(); } catch {}
    throw err;
  }
}

function normalizePreferences(preferences = {}) {
  const aspects = ['colors', 'typography', 'layout', 'spacing', 'imagery', 'motion', 'interactions', 'details'];
  const selected = Array.isArray(preferences?.liked_aspects) ? preferences.liked_aspects : [];
  return {
    liked_aspects: aspects.filter(aspect => selected.includes(aspect)),
    focus: typeof preferences?.focus === 'string' ? preferences.focus : '',
    avoid: typeof preferences?.avoid === 'string' ? preferences.avoid : '',
    intended_use: typeof preferences?.intended_use === 'string' ? preferences.intended_use : ''
  };
}

function buildNoteMd(payload) {
  const fields = { schema_version: 1, tags: payload.tags || [], ...normalizePreferences(payload.preferences) };
  const frontmatter = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
  const body = payload.note || '';
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
