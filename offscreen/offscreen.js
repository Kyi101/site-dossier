const statusEl = document.getElementById('status');

const handleChannel = new BroadcastChannel('design-capture-handles');
let cachedDirHandle = null;
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

  if (message.type === 'OFFSCREEN_WRITE_BUNDLE') {
    statusEl.textContent = 'Writing bundle…';
    writeBundle(message.payload)
      .then(result => sendResponse({ ok: true, result }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});

async function writeBundle(payload) {
  const handle = cachedDirHandle;
  if (!handle) throw new Error('No inspo folder handle cached. Open popup and click Start (which posts the handle).');
  const isSelection = payload.kind === 'selection';
  if (isSelection) validateSelections(payload.selection);

  // Folder name: {host-slug}-{YYYY-MM-DD}
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

  // A host can have several captured pages on one day. Merge only when
  // url.txt matches the exact source URL; otherwise allocate a new suffix.
  let bundleDir;
  let isMerge = false;
  let folderName = baseFolderName;
  for (let n = 1; ; n++) {
    folderName = n === 1 ? baseFolderName : `${baseFolderName}-${n}`;
    try {
      bundleDir = await handle.getDirectoryHandle(folderName, { create: false });
    } catch (err) {
      if (err.name !== 'NotFoundError') throw err;
      bundleDir = await handle.getDirectoryHandle(folderName, { create: true });
      break;
    }

    let existingUrl = null;
    try {
      const file = await bundleDir.getFileHandle('url.txt', { create: false });
      existingUrl = (await (await file.getFile()).text()).trim();
    } catch (err) {
      if (err.name !== 'NotFoundError') throw err;
    }
    if (existingUrl === payload.url) {
      isMerge = true;
      break;
    }
  }

  // Viewport subfolder. If THIS viewport already exists inside the bundle
  // (user captured desktop twice on same day), suffix -2, -3, etc.
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

  // Viewport-specific must-succeed files (fast writes, before any long-running step).
  // Chrome's File System Access handles can go stale during long idle waits — get
  // everything important on disk early so a contact-sheet failure doesn't drop the bundle.
  const videoBlob = await dataUrlToBlob(payload.video.dataUrl);
  await writeFile(viewportDir, 'scroll.webm', videoBlob);
  await writeFile(viewportDir, 'page.jpg', await dataUrlToBlob(payload.screenshot.dataUrl));
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
    screenshot: { file: 'page.jpg', stop_reason: payload.screenshot.stopReason || null },
    tool_version: payload.toolVersion
  };
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
