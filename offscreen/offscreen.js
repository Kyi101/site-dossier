const statusEl = document.getElementById('status');

async function generateContactSheet(videoBlob, durationS, { frames = 9, columns = 3, frameWidth = 160 } = {}) {
  const videoUrl = URL.createObjectURL(videoBlob);
  try {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.style.position = 'absolute';
    video.style.left = '-99999px';

    try {
      // Install listeners before src: a short recording can load immediately.
      const ready = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { cleanup(); reject(new Error('video load timeout')); }, 10000);
        const onReady = () => { cleanup(); resolve(); };
        const onErr = () => { cleanup(); reject(new Error('video load failed')); };
        function cleanup() {
          clearTimeout(timeout);
          video.removeEventListener('loadeddata', onReady);
          video.removeEventListener('error', onErr);
        }
        video.addEventListener('loadeddata', onReady, { once: true });
        video.addEventListener('error', onErr, { once: true });
      });
      video.src = videoUrl;
      // Some Chrome versions are finicky about decoding detached <video>.
      document.body.appendChild(video);
      await ready;

      // MediaRecorder-produced webms often lack proper duration metadata
      // (Chrome bug, video.duration can be Infinity). Fall back to the caller-supplied durationS.
      const probedDuration = isFinite(video.duration) && video.duration > 0 ? video.duration : durationS;

      const aspect = video.videoWidth > 0 ? (video.videoHeight / video.videoWidth) : 0.5;
      const frameHeight = Math.max(1, Math.round(frameWidth * aspect));
      const rows = Math.ceil(frames / columns);
      const canvas = document.createElement('canvas');
      canvas.width = frameWidth * columns;
      canvas.height = frameHeight * rows;
      const ctx = canvas.getContext('2d');

      // Seek to N evenly-spaced timestamps (centered in each slice, skipping 0).
      // Sample at (i+0.5)/N so a 9-frame sample of a 90s video hits ~5s, 15s, ..., 85s.
      for (let i = 0; i < frames; i++) {
        const t = ((i + 0.5) / frames) * probedDuration;
        await seekTo(video, t);
        const col = i % columns;
        const row = Math.floor(i / columns);
        ctx.drawImage(video, col * frameWidth, row * frameHeight, frameWidth, frameHeight);
      }

      // Return as PNG Blob
      return await new Promise((resolve, reject) => {
        canvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error('canvas.toBlob produced null')),
          'image/png'
        );
      });
    } finally {
      video.remove();
    }
  } finally {
    URL.revokeObjectURL(videoUrl);
  }
}

function seekTo(video, t) {
  const target = Math.max(0, Math.min(t, (video.duration && isFinite(video.duration)) ? video.duration - 0.1 : t));
  if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.02) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`seek to ${t} timed out`)); }, 5000);
    const onSeeked = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error(`seek to ${t} failed`)); };
    function cleanup() {
      clearTimeout(timeout);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onErr);
    }
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onErr, { once: true });
    try { video.currentTime = target; }
    catch (err) { cleanup(); reject(err); }
  });
}

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
  const viewportName = payload.viewportName || 'desktop';

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

  // Viewport-specific must-succeed files (fast writes, before any long-running step).
  // Chrome's File System Access handles can go stale during long idle waits — get
  // everything important on disk early so a contact-sheet failure doesn't drop the bundle.
  const videoBlob = await dataUrlToBlob(payload.video.dataUrl);
  await writeFile(viewportDir, 'scroll.webm', videoBlob);
  await writeFile(viewportDir, 'page.jpg', await dataUrlToBlob(payload.screenshot.dataUrl));
  await writeFile(viewportDir, 'page.html', new Blob([payload.html], { type: 'text/html' }));

  // Shared bundle-root files — write ONLY on first capture (not on merge).
  // Moved BEFORE the contact-sheet step so they're not at risk of stale-handle errors.
  if (!isMerge) {
    await writeFile(bundleDir, 'url.txt', new Blob([payload.url + '\n']));
    await writeFile(bundleDir, 'note.md', new Blob([buildNoteMd(payload)]));
    await writeFile(bundleDir, 'tokens.json', new Blob([JSON.stringify(payload.tokens, null, 2)]));
  }

  // Contact sheet — best-effort with 60s timeout to cover up-to-180s recordings.
  // Shared root files were already written above, so a timeout here only loses
  // scroll-sheet.png — the rest of the bundle is intact.
  let contactSheetWritten = false;
  try {
    const durationS = payload.video.durationS || 30;
    const sheetBlob = await withTimeout(
      generateContactSheet(videoBlob, durationS, { frames: 9, columns: 3 }),
      60000,
      'contact sheet generation timeout (60s)'
    );
    await writeFile(viewportDir, 'scroll-sheet.png', sheetBlob);
    contactSheetWritten = true;
  } catch (err) {
    console.warn('[design-capture] contact sheet generation failed:', err.message || err);
  }

  // meta.json per viewport — written LAST so contact_sheet field reflects reality.
  // Wrapped in try/catch because the handle may be stale after the contact-sheet wait;
  // partial bundle is fine without meta.json (other files are sufficient).
  const meta = {
    url: payload.url,
    host: url.host,
    title: payload.title || null,
    captured_at: payload.startedAt,
    viewport: viewportDirName,
    viewport_size: payload.viewportSize,
    capture_mode: payload.mode || 'auto',
    video: {
      duration_s: payload.video.durationS || null,
      file: 'scroll.webm',
      contact_sheet: contactSheetWritten ? 'scroll-sheet.png' : null,
      frames_sampled: contactSheetWritten ? 9 : 0
    },
    tool_version: '0.1.0'
  };
  try {
    await writeFile(viewportDir, 'meta.json', new Blob([JSON.stringify(meta, null, 2)]));
  } catch (err) {
    console.warn('[design-capture] meta.json write failed (handle likely went stale):', err.message || err);
  }

  statusEl.textContent = `${isMerge ? 'Merged into' : 'Wrote'} ${folderName}/${viewportDirName}/`;
  return { folderName, viewport: viewportDirName, merged: isMerge };
}

async function writeFile(dirHandle, name, blob) {
  const fileHandle = await dirHandle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

function buildNoteMd(payload) {
  const tagsLine = `tags: ${JSON.stringify(payload.tags || [])}\n`;
  const body = payload.note || '';
  return `---\n${tagsLine}---\n\n${body}\n`;
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
