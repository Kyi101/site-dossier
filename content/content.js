// Content script — runs in the page's context.
// Injects floating record banner, handles screenshot + HTML + token capture on stop.

(() => {
  if (window.__designCaptureLoaded__) return;
  window.__designCaptureLoaded__ = true;

  let banner = null;
  let bannerHost = null;
  let timerInterval = null;
  let dismissTimer = null;
  let flashTimer = null;
  let shotCount = 0;
  let startedAt = null;
  let stoppedAt = null;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'INJECT_BANNER') {
      try {
        injectBanner(message.css);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    }

    if (message.type === 'REMOVE_BANNER') {
      removeBanner();
      sendResponse({ ok: true });
    }
    return false;
  });

  function injectBanner(css) {
    if (banner) return;
    // A closed custom element keeps page CSS and scanners out of the controls.
    // Neutral names avoid ad-slot heuristics; opaque custom elements protect
    // interaction controls from third-party DOM scanners.
    bannerHost = document.createElement('site-dossier-control');
    bannerHost.id = 'site-dossier-root';
    bannerHost.popover = 'manual';
    bannerHost.style.cssText = 'all:initial!important;position:fixed!important;inset:auto!important;right:0!important;bottom:0!important;width:0!important;height:0!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;z-index:2147483647!important;pointer-events:none!important';
    const shadow = bannerHost.attachShadow({ mode: 'closed' });
    // Construct the packaged stylesheet directly; a page CSP can block a
    // chrome-extension: <link>, leaving the zero-sized host invisible.
    const stylesheet = new CSSStyleSheet();
    stylesheet.replaceSync(css);
    shadow.adoptedStyleSheets = [stylesheet];
    banner = document.createElement('div');
    banner.id = 'site-dossier-control';
    banner.dataset.state = 'starting';
    banner.innerHTML = `
      <span class="camera" aria-hidden="true">
        <svg viewBox="0 0 40 36" fill="none">
          <path class="camera-body" d="M5 10h7l3-5h10l3 5h7v21H5z" />
          <circle class="lens" cx="20" cy="20" r="7" />
          <circle class="lens-glint" cx="18" cy="18" r="2" />
          <path class="flash-bolt" d="m32 0-5 9h5l-2 7 9-11h-6l3-5z" />
        </svg>
      </span>
      <span class="readout">
        <strong class="state" role="status">Starting…</strong>
        <span class="shots">Preparing camera</span>
      </span>
      <span class="timer" hidden>0s</span>
      <button type="button" aria-label="Stop recording" disabled hidden>Stop</button>
    `;
    shadow.append(banner);
    document.documentElement.appendChild(bannerHost);
    bannerHost.showPopover();
    startedAt = Date.now();
    banner.querySelector('button').addEventListener('click', stopCapture);
  }

  const SAFETY_CAP_S = 180;
  function updateTimer() {
    if (!banner || recorder?.state !== 'recording') return;
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    const remaining = SAFETY_CAP_S - elapsedSec;
    if (remaining <= 10 && remaining > 0) {
      banner.querySelector('.timer').textContent = `${remaining}s left`;
      banner.classList.add('warning');
    } else {
      banner.querySelector('.timer').textContent = `${elapsedSec}s`;
    }
  }

  function setBannerState(state, label, detail) {
    if (!banner) return;
    banner.dataset.state = state;
    banner.classList.remove('warning');
    banner.querySelector('.state').textContent = label;
    if (detail !== undefined) banner.querySelector('.shots').textContent = detail;
    const button = banner.querySelector('button');
    button.disabled = state !== 'recording';
    button.hidden = state !== 'recording';
    banner.querySelector('.timer').hidden = state !== 'recording';
  }

  function stopCapture() {
    if (!recorder || recorder.state !== 'recording') return false;
    stoppedAt = Date.now();
    recorder.stop();
    setBannerState('saving', 'Saving capture…');
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    chrome.runtime.sendMessage({ type: 'CAPTURE_PROCESSING' }, () => {
      if (chrome.runtime.lastError) console.warn('[design-capture] status update failed:', chrome.runtime.lastError.message);
    });
    return true;
  }

  function removeBanner() {
    if (dismissTimer) clearTimeout(dismissTimer);
    dismissTimer = null;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = null;
    if (bannerHost) bannerHost.remove();
    bannerHost = null;
    banner = null;
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
  }

  function flashCamera() {
    shotCount++;
    if (!banner) return;
    banner.querySelector('.shots').textContent = `${shotCount} screenshot${shotCount === 1 ? '' : 's'}`;
    banner.classList.add('flash');
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      banner?.classList.remove('flash');
      flashTimer = null;
    }, 480);
  }

  function scheduleBannerRemoval(delay, state) {
    if (dismissTimer) clearTimeout(dismissTimer);
    const currentBanner = banner;
    dismissTimer = setTimeout(() => {
      dismissTimer = null;
      if (banner === currentBanner && banner?.dataset.state === state) removeBanner();
    }, delay);
  }

  let recorder = null;
  let recordedChunks = [];

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'START_RECORDING') {
      startRecording(message.streamId, message.mode)
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    if (message.type === 'STOP_RECORDING') {
      stopRecording()
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    return false;
  });

  async function startRecording(streamId, mode = 'auto') {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    });
    recordedChunks = [];
    shotCount = 0;
    stoppedAt = null;
    let screenshotTask = null;
    recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    recorder.onstop = async () => {
      try {
        console.log('[design-capture] onstop: building blob (chunks:', recordedChunks.length, ')');
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        console.log('[design-capture] onstop: blob size', blob.size, 'bytes; converting to data URL');
        const videoDataUrl = await blobToDataUrl(blob);
        console.log('[design-capture] onstop: data URL length', videoDataUrl.length);

        // Build tokens object — extractors are wrapped in try/catch so partial failure doesn't lose other fields

        const tokens = {
          extracted_at: new Date().toISOString(),
          viewport: { width: window.innerWidth, height: window.innerHeight },
          errors: []
        };
        try { tokens.colors = extractColors(); } catch (e) { tokens.errors.push('colors:' + e.message); }
        try { tokens.typography = extractTypography(); } catch (e) { tokens.errors.push('typography:' + e.message); }
        try { tokens.spacing = extractSpacing(); } catch (e) { tokens.errors.push('spacing:' + e.message); }
        try { tokens.radii_px = extractRadii(); } catch (e) { tokens.errors.push('radii:' + e.message); }
        try { tokens.shadows = extractShadows(); } catch (e) { tokens.errors.push('shadows:' + e.message); }
        try { tokens.libraries = await extractLibraries(); } catch (e) { tokens.errors.push('libraries:' + e.message); }
        try { tokens.stack = extractStack(); } catch (e) { tokens.errors.push('stack:' + e.message); }

        console.log('[design-capture] onstop: tokens built, errors:', tokens.errors);

        // Auto already captured tiles during the video pass. Manual captures
        // the final page after the user stops their interaction.
        console.log('[design-capture] onstop: finishing screenshot stitch');
        const screenshotResult = screenshotTask ? await screenshotTask : null;
        if (screenshotResult?.error) throw screenshotResult.error;
        if (!screenshotResult) {
          setBannerState('saving', 'Taking page screenshots…', 'Scrolling the page automatically');
        }
        const screenshotDataUrl = screenshotResult?.dataUrl || await captureFullPagePng({ chunkPause: 600 });
        setBannerState('saving', 'Saving capture…', 'Preparing files');
        console.log('[design-capture] onstop: screenshot done');

        console.log('[design-capture] onstop: snapshotting HTML');
        const htmlSnapshot = await captureHtmlSnapshot();
        console.log('[design-capture] onstop: HTML length', htmlSnapshot.length);

        const durationS = Math.round(((stoppedAt || Date.now()) - startedAt) / 1000);
        console.log('[design-capture] onstop: sending CAPTURE_BUNDLE_READY (durationS:', durationS, ')');
        const response = await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({
              type: 'CAPTURE_BUNDLE_READY',
              video: { dataUrl: videoDataUrl, size: blob.size, durationS },
              screenshot: { dataUrl: screenshotDataUrl },
              html: htmlSnapshot,
              tokens
            }, (res) => {
              if (chrome.runtime.lastError) {
                resolve({ ok: false, error: chrome.runtime.lastError.message });
              } else if (!res) {
                resolve({ ok: false, error: 'no response from background' });
              } else {
                resolve(res);
              }
            });
          } catch (err) {
            // sendMessage throws synchronously when payload exceeds the ~64MB limit
            resolve({ ok: false, error: 'sendMessage threw: ' + (err.message || err) });
          }
        });
        if (!response.ok) {
          throw new Error(response.error || 'bundle write failed');
        }
        console.log('[design-capture] onstop: bundle written');
        setBannerState('saved', 'Saved', `${response.result.folderName}/${response.result.viewport}`);
        scheduleBannerRemoval(8000, 'saved');
      } catch (err) {
        console.error('[design-capture] onstop FAILED:', err);
        setBannerState('failed', 'Save failed', String(err.message || err));
        chrome.runtime.sendMessage({ type: 'CAPTURE_FAILED', error: err.message || String(err) }, () => {
          if (chrome.runtime.lastError) console.warn('[design-capture] failure update failed:', chrome.runtime.lastError.message);
        });
        scheduleBannerRemoval(12000, 'failed');
      } finally {
        try { stream.getTracks().forEach(t => t.stop()); } catch {}
      }
    };
    if (mode !== 'manual') {
      try { window.scrollTo(0, 0); }
      catch (err) { console.warn('[design-capture] could not reset scroll:', err); }
    }
    if (dismissTimer) clearTimeout(dismissTimer);
    dismissTimer = null;
    recorder.start();
    startedAt = Date.now();
    setBannerState('recording', mode === 'manual' ? 'Manual recording' : 'Auto capture', mode === 'manual' ? '' : '0 screenshots');
    timerInterval = setInterval(updateTimer, 200);
    const activeRecorder = recorder;
    if (mode !== 'manual') {
      screenshotTask = captureFullPagePng({
        chunkPause: 900, timeBudgetMs: 30000, smoothScroll: true, restoreScroll: false,
        shouldStop: () => activeRecorder.state !== 'recording',
        onScrollComplete: () => { if (recorder === activeRecorder) stopCapture(); }
      }).then(dataUrl => ({ dataUrl }), error => ({ error }));
      screenshotTask.then(() => { if (recorder === activeRecorder) stopCapture(); });
    }
    // 180s safety cap — auto-stop if user forgets.
    // Past ~2 minutes the data-URL'd webm risks the chrome.runtime.sendMessage
    // 64MB limit; 180s @ vp9 typically stays under ~50MB.
    // Call stopCapture() (not stopRecording directly) so the banner flips to
    // "Saving…" and the background sees CAPTURE_PROCESSING — otherwise the page-scroll
    // for screenshot stitching feels like an unexplained interruption.
    setTimeout(() => {
      if (recorder === activeRecorder && recorder.state === 'recording') {
        console.log(`[design-capture] safety cap reached at ${SAFETY_CAP_S}s, auto-stopping`);
        stopCapture();
      }
    }, SAFETY_CAP_S * 1000);
  }

  async function stopRecording() {
    if (!stopCapture()) throw new Error('Recording is already stopped.');
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function captureFullPagePng({ chunkPause = 600, timeBudgetMs = 15000,
    smoothScroll = false, restoreScroll = true, shouldStop = () => false, onScrollComplete = () => {} } = {}) {
    const startTime = Date.now();
    const deadline = startTime + timeBudgetMs;
    const originalScrollY = window.scrollY;
    const originalScrollX = window.scrollX;
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const pixelRatio = window.devicePixelRatio || 1;

    function measureFullSize() {
      return {
        width: Math.max(
          document.documentElement.scrollWidth,
          document.body.scrollWidth,
          viewportWidth
        ),
        height: Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight,
          viewportHeight
        )
      };
    }

    const initial = measureFullSize();
    console.log('[design-capture] captureFullPagePng start',
      { viewportWidth, viewportHeight, initial, pixelRatio, timeBudgetMs });

    const slices = [];
    let stoppedReason = null;
    let scrollStuckCount = 0; // detect smooth-scroll libs blocking window.scrollTo

    try {
      let y = 0;
      outer: while (true) {
        if (slices.length && shouldStop()) break;
        if (Date.now() > deadline) {
          stoppedReason = `time budget ${timeBudgetMs}ms exceeded`;
          break;
        }
        const { height: fullHeight } = measureFullSize();
        if (y >= fullHeight) break;

        let x = 0;
        while (true) {
          if (slices.length && shouldStop()) break outer;
          if (Date.now() > deadline) {
            stoppedReason = `time budget ${timeBudgetMs}ms exceeded`;
            break outer;
          }
          const { width: fullWidth } = measureFullSize();
          if (x >= fullWidth) break;

          // The last row/column cannot scroll a full viewport. Use the
          // position Chrome can actually reach when placing each image.
          const currentSize = measureFullSize();
          const targetX = Math.min(x, Math.max(0, currentSize.width - viewportWidth));
          const targetY = Math.min(y, Math.max(0, currentSize.height - viewportHeight));
          if (smoothScroll) window.scrollTo({ left: targetX, top: targetY, behavior: 'smooth' });
          else window.scrollTo(targetX, targetY);
          await sleep(chunkPause); // lazy-load + sticky nav settle

          const actualX = window.scrollX;
          const actualY = window.scrollY;
          if (Math.abs(actualX - targetX) > 50 || Math.abs(actualY - targetY) > 50) {
            console.warn('[design-capture] scrollTo did not stick',
              { requested: { x: targetX, y: targetY }, actual: { x: actualX, y: actualY } });
            scrollStuckCount++;
            if (scrollStuckCount >= 2 && slices.length > 0) {
              stoppedReason = 'scroll did not advance — page likely uses a smooth-scroll library that blocks window.scrollTo';
              break outer;
            }
          } else {
            scrollStuckCount = 0;
          }

          let dataUrl = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              dataUrl = await requestVisibleTabCapture();
              break;
            } catch (err) {
              if (attempt === 3) throw err;
              await sleep(chunkPause * attempt); // 600ms, 1200ms, then throw
            }
          }
          slices.push({ x: actualX, y: actualY, dataUrl });

          x += viewportWidth;
        }

        // Last row of currently-measured content: pause extra so
        // infinite-scroll fetchers have a chance to fire before we re-measure.
        if (y + viewportHeight >= fullHeight) await sleep(1200);

        y += viewportHeight;
      }
    } finally {
      if (restoreScroll) window.scrollTo(originalScrollX, originalScrollY);
    }

    // Fallback for horizontal-strip sites driven by transform (e.g. wheel-events
    // updating a single wide <div>'s translateX). Window.scrollTo is a no-op,
    // body { overflow: hidden }, normal stitch produces 1 slice. If we find a
    // candidate strip wider than 3 viewports, walk its transform directly.
    let usedWideTrack = false;
    if (slices.length <= 1 && Date.now() < deadline && !shouldStop()) {
      const walked = await tryWideTrackFallback({
        slices, deadline, chunkPause, viewportWidth, shouldStop
      });
      if (walked) {
        usedWideTrack = true;
        stoppedReason = (stoppedReason ? stoppedReason + '; ' : '') + 'wide-track fallback ran';
      }
    }

    console.log('[design-capture] captureFullPagePng done',
      { slices: slices.length, elapsedMs: Date.now() - startTime, stoppedReason });

    onScrollComplete();
    if (slices.length === 0) throw new Error('No screenshot slices captured.');

    const capturedX = slices.reduce((m, slice) => Math.max(m, slice.x), 0) + viewportWidth;
    const capturedY = slices.reduce((m, slice) => Math.max(m, slice.y), 0) + viewportHeight;
    const fullSize = measureFullSize();
    const maxX = usedWideTrack ? capturedX : Math.min(fullSize.width, capturedX);
    const maxY = Math.min(fullSize.height, capturedY);

    // Keep very long pages within common canvas limits. A lower resolution
    // image is preferable to Chrome returning the empty "data:," URL.
    const maxDimension = 16384;
    const maxPixels = 64000000;
    const scale = Math.min(
      pixelRatio,
      maxDimension / maxX,
      maxDimension / maxY,
      Math.sqrt(maxPixels / (maxX * maxY))
    );
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(maxX * scale));
    canvas.height = Math.max(1, Math.floor(maxY * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create screenshot canvas.');

    for (const slice of slices) {
      const img = await loadImage(slice.dataUrl);
      ctx.drawImage(
        img,
        Math.round(slice.x * scale),
        Math.round(slice.y * scale),
        Math.ceil(viewportWidth * scale),
        Math.ceil(viewportHeight * scale)
      );
    }

    const jpeg = canvas.toDataURL('image/jpeg', 0.85);
    if (!jpeg.startsWith('data:image/jpeg;')) {
      throw new Error('Screenshot canvas could not be encoded.');
    }
    return jpeg;
  }

  // Find the widest element with a non-identity transform. Used as a heuristic
  // for "horizontal strip driven by JS-translated transform" sites, where
  // window.scrollTo is a no-op and the content is laid out in a single very
  // wide DOM element transformed via translateX. Threshold of 3x viewport
  // avoids false positives on normal sites with mild transforms.
  function findWideTransformTrack(viewportWidth) {
    let best = null;
    let bestWidth = 0;
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width < viewportWidth * 3) continue;
      const cs = getComputedStyle(el);
      if (cs.transform === 'none' || !cs.transform) continue;
      if (r.width > bestWidth) {
        best = el;
        bestWidth = r.width;
      }
    }
    return best ? { el: best, width: bestWidth } : null;
  }

  async function tryWideTrackFallback({ slices, deadline, chunkPause, viewportWidth, shouldStop = () => false }) {
    const found = findWideTransformTrack(viewportWidth);
    if (!found) return false;

    console.log('[design-capture] wide-track fallback engaged',
      { tag: found.el.tagName, cls: String(found.el.className).slice(0, 60), trackWidth: found.width });

    const originalInline = found.el.style.transform;
    const originalPriority = found.el.style.getPropertyPriority('transform');

    // Replace prior slices (the single top-of-page capture) — fallback owns the canvas now
    slices.length = 0;

    try {
      const steps = Math.ceil(found.width / viewportWidth);
      for (let i = 0; i < steps; i++) {
        if (slices.length && shouldStop()) break;
        if (Date.now() > deadline) {
          console.log('[design-capture] wide-track fallback: time budget exceeded at step', i);
          break;
        }
        const tx = i * viewportWidth;
        // !important so the site's own RAF loop doesn't immediately overwrite us
        found.el.style.setProperty('transform', `translateX(-${tx}px)`, 'important');
        await sleep(chunkPause);

        let dataUrl = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            dataUrl = await requestVisibleTabCapture();
            break;
          } catch (err) {
            if (attempt === 3) throw err;
            await sleep(chunkPause * attempt);
          }
        }
        slices.push({ x: i * viewportWidth, y: 0, dataUrl });
      }
      return true;
    } finally {
      if (originalInline) {
        found.el.style.setProperty('transform', originalInline, originalPriority);
      } else {
        found.el.style.removeProperty('transform');
      }
    }
  }

  async function requestVisibleTabCapture() {
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE_TAB' }, (res) => {
        if (chrome.runtime.lastError || !res?.dataUrl) {
          reject(new Error(chrome.runtime.lastError?.message || res?.error || 'visible tab capture failed'));
        } else {
          resolve(res.dataUrl);
        }
      });
    });
    flashCamera();
    return result;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function captureHtmlSnapshot() {
    const doc = document.cloneNode(true);
    doc.querySelector('#site-dossier-root')?.remove();
    doc.querySelector('#design-capture-style')?.remove();
    const deadline = Date.now() + 15000;
    const maxResourceBytes = 1000000;
    const maxTotalInlineBytes = 8000000;
    let inlinedBytes = 0;

    async function fetchResource(url) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error('HTML snapshot time budget reached');
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(3000, remainingMs)) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (Number(res.headers.get('content-length')) > maxResourceBytes) {
        throw new Error('Resource too large to inline');
      }
      const text = await res.text();
      const bytes = new Blob([text]).size;
      if (bytes > maxResourceBytes || inlinedBytes + bytes > maxTotalInlineBytes) {
        throw new Error('HTML inline budget reached');
      }
      inlinedBytes += bytes;
      return text;
    }

    // Inline external <link rel="stylesheet"> — best effort, skip on CORS failure
    const linkEls = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'));
    for (const link of linkEls) {
      if (Date.now() >= deadline) break;
      try {
        const href = new URL(link.href, document.baseURI).toString();
        const css = await fetchResource(href);
        const style = doc.createElement('style');
        style.setAttribute('data-inlined-from', href);
        style.textContent = css;
        link.replaceWith(style);
      } catch (err) {
        link.setAttribute('data-inline-failed', err.message);
      }
    }

    // Inline external <script src="..."> — best effort, leave src on failure
    const scriptEls = Array.from(doc.querySelectorAll('script[src]'));
    for (const script of scriptEls) {
      if (Date.now() >= deadline) break;
      try {
        const src = new URL(script.src, document.baseURI).toString();
        const js = await fetchResource(src);
        const inline = doc.createElement('script');
        // Preserve src as data attribute so library detection from src still works
        inline.setAttribute('data-inlined-from', src);
        if (script.type) inline.setAttribute('type', script.type);
        inline.textContent = js;
        script.replaceWith(inline);
      } catch (err) {
        script.setAttribute('data-inline-failed', err.message);
      }
    }

    // Add a base tag if missing so relative URLs in the inlined HTML resolve
    if (!doc.querySelector('base')) {
      const base = doc.createElement('base');
      base.href = document.baseURI;
      (doc.head || doc.documentElement).insertBefore(base, doc.head?.firstChild || null);
    }

    // Add a banner comment with source URL + timestamp
    const banner = `<!-- captured by Site Dossier from ${document.location.href} at ${new Date().toISOString()} -->\n`;
    return banner + '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  }

  function extractColors() {
    const elements = Array.from(document.querySelectorAll('*')).filter(el => el !== bannerHost).slice(0, 5000);
    const colorAreas = new Map(); // color -> approx surface area in px²

    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area <= 0) continue;
      const cs = getComputedStyle(el);

      addColor(colorAreas, cs.backgroundColor, area);
      addColor(colorAreas, cs.color, area * 0.3); // text is a smaller fraction of element area
      addColor(colorAreas, cs.borderTopColor, area * 0.05);
    }

    // Convert to entries, normalize colors, drop transparent / fully white / fully black duplicates
    const normalized = new Map();
    for (const [raw, area] of colorAreas.entries()) {
      const hex = rgbToHex(raw);
      if (!hex) continue;
      normalized.set(hex, (normalized.get(hex) || 0) + area);
    }

    // Top N by area, de-dupe by perceptual similarity
    const sorted = Array.from(normalized.entries())
      .sort((a, b) => b[1] - a[1]);
    const palette = [];
    for (const [hex] of sorted) {
      if (palette.every(p => deltaE(p, hex) >= 5)) palette.push(hex);
      if (palette.length >= 12) break;
    }

    const background = palette[0] || null;
    const foreground = mostCommonTextColor() || palette[1] || null;
    const totalArea = Array.from(normalized.values()).reduce((a, b) => a + b, 0);
    const accent = palette.filter(hex => (normalized.get(hex) || 0) / totalArea < 0.05);

    return { palette, background, foreground, accent };
  }

  function mostCommonTextColor() {
    const counts = new Map();
    for (const el of document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, span, a, li')) {
      const c = rgbToHex(getComputedStyle(el).color);
      if (!c) continue;
      counts.set(c, (counts.get(c) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }

  function addColor(map, raw, area) {
    if (!raw || raw === 'transparent' || raw.includes('0, 0, 0, 0')) return;
    map.set(raw, (map.get(raw) || 0) + area);
  }

  function rgbToHex(raw) {
    if (!raw) return null;
    const m = raw.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    const [, r, g, b, a] = m;
    if (a !== undefined && parseFloat(a) < 0.1) return null; // skip near-transparent
    return '#' + [r, g, b].map(n => parseInt(n, 10).toString(16).padStart(2, '0')).join('');
  }

  function deltaE(hex1, hex2) {
    // Cheap CIE76-like in RGB (not perceptually perfect, fine for dedup)
    const [r1, g1, b1] = hexToRgb(hex1);
    const [r2, g2, b2] = hexToRgb(hex2);
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2) / 4.41; // normalize to ~0–100
  }

  function hexToRgb(hex) {
    const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
  }

  function extractTypography() {
    // Fonts: from @font-face rules + computed font-family
    const fonts = new Map(); // family -> { weights:Set, sources:Set }

    // Walk all CSS rules for @font-face
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; } // CORS
      if (!rules) continue;
      for (const rule of rules) {
        if (rule instanceof CSSFontFaceRule) {
          const family = rule.style.getPropertyValue('font-family').replace(/['"]/g, '').trim();
          const src = rule.style.getPropertyValue('src');
          const weightRaw = rule.style.getPropertyValue('font-weight') || '400';
          const weight = parseInt(weightRaw, 10) || 400;
          if (!fonts.has(family)) fonts.set(family, { weights: new Set(), sources: new Set() });
          fonts.get(family).weights.add(weight);
          fonts.get(family).sources.add(classifyFontSource(src));
        }
      }
    }

    // Also pick up families that are referenced but not in @font-face (system / web-safe / google CDN linked)
    const usedFamilies = new Set();
    for (const el of document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, body')) {
      const family = getComputedStyle(el).fontFamily.split(',')[0].replace(/['"]/g, '').trim();
      if (family) usedFamilies.add(family);
    }
    for (const family of usedFamilies) {
      if (!fonts.has(family)) {
        fonts.set(family, { weights: new Set([400]), sources: new Set(['system']) });
      }
    }

    const fontsArr = Array.from(fonts.entries()).map(([family, info]) => ({
      family,
      weights: Array.from(info.weights).sort((a, b) => a - b),
      sources: Array.from(info.sources)
    }));

    // Scale: unique font-sizes (px-converted) across body elements
    const sizes = new Set();
    for (const el of document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, span, a, li, button')) {
      const px = parseFloat(getComputedStyle(el).fontSize);
      if (px && px > 0) sizes.add(Math.round(px));
    }
    const scale = Array.from(sizes).sort((a, b) => a - b);

    // Headings: first h1-h3 computed style
    const headings = {};
    for (const tag of ['h1', 'h2', 'h3']) {
      const el = document.querySelector(tag);
      if (el) {
        const cs = getComputedStyle(el);
        const size = Math.round(parseFloat(cs.fontSize));
        const family = cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
        const weight = cs.fontWeight;
        headings[tag] = `${size}px ${family} ${weight}`;
      }
    }

    return { fonts: fontsArr, scale_px: scale, headings };
  }

  function classifyFontSource(src) {
    if (!src) return 'unknown';
    if (src.includes('fonts.googleapis.com') || src.includes('fonts.gstatic.com')) return 'google';
    if (src.includes('typekit') || src.includes('use.typekit.net')) return 'typekit';
    if (src.match(/cdn|jsdelivr|unpkg/i)) return 'cdn';
    if (src.startsWith('url("/') || src.startsWith("url('/") || src.includes(location.host)) return 'self-hosted';
    return 'external';
  }

  function extractSpacing() {
    const values = new Set();
    for (const el of Array.from(document.querySelectorAll('*')).filter(el => el !== bannerHost).slice(0, 5000)) {
      const cs = getComputedStyle(el);
      for (const prop of ['marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'gap']) {
        const px = parseFloat(cs[prop]);
        if (px > 0 && px <= 256) values.add(Math.round(px));
      }
    }
    const scale = Array.from(values).sort((a, b) => a - b);
    const base = gcdOfArray(scale.filter(n => n >= 2 && n <= 32)) || null;
    return { base_px: base, scale_px: scale };
  }

  function gcdOfArray(arr) {
    if (arr.length === 0) return null;
    const gcd2 = (a, b) => b === 0 ? a : gcd2(b, a % b);
    return arr.reduce((a, b) => gcd2(a, b));
  }

  function extractRadii() {
    const values = new Set();
    for (const el of Array.from(document.querySelectorAll('*')).filter(el => el !== bannerHost).slice(0, 5000)) {
      const cs = getComputedStyle(el);
      for (const prop of ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius']) {
        const px = parseFloat(cs[prop]);
        if (px > 0) values.add(Math.round(px));
      }
    }
    return Array.from(values).sort((a, b) => a - b);
  }

  function extractShadows() {
    const values = new Set();
    for (const el of Array.from(document.querySelectorAll('*')).filter(el => el !== bannerHost).slice(0, 5000)) {
      const shadow = getComputedStyle(el).boxShadow;
      if (shadow && shadow !== 'none') values.add(shadow);
      if (values.size >= 20) break;
    }
    return Array.from(values);
  }

  // MAIN-world globals probe — routed through background's chrome.scripting.
  // Previous approach injected an inline <script> via textContent, which
  // strict-CSP sites block. chrome.scripting.executeScript with world:'MAIN'
  // bypasses page CSP because Chrome injects directly, not via the DOM.
  function probeMainWorldGlobals() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'PROBE_LIBS' }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({});
          } else {
            resolve(res?.detected || {});
          }
        });
      } catch {
        resolve({});
      }
    });
  }

  async function extractLibraries() {
    const detected = new Set();

    // MAIN-world globals (via injected <script>; works even though content script is in isolated world)
    try {
      const mainGlobals = await probeMainWorldGlobals();
      for (const key of Object.keys(mainGlobals)) detected.add(key);
    } catch {
      // CSP may block inline scripts; partial result is fine — script src detection below still works
    }

    // Script src + inlined script content
    for (const script of document.querySelectorAll('script[src], script[data-inlined-from]')) {
      const src = script.getAttribute('data-inlined-from') || script.src || '';
      if (/gsap/i.test(src)) detected.add('gsap');
      if (/lenis/i.test(src)) detected.add('lenis');
      if (/locomotive/i.test(src)) detected.add('locomotive-scroll');
      if (/three(\.|@|\/)/i.test(src)) detected.add('three.js');
      if (/framer-motion|motion/i.test(src)) detected.add('motion');
      if (/scrollmagic/i.test(src)) detected.add('scrollmagic');
      if (/barba/i.test(src)) detected.add('barba');
    }

    return Array.from(detected).sort();
  }

  function extractStack() {
    const hints = [];
    // Next.js
    if (document.getElementById('__NEXT_DATA__') || window.__NEXT_DATA__) hints.push('next.js');
    // Nuxt
    if (document.getElementById('__NUXT_DATA__') || window.__NUXT__) hints.push('nuxt');
    // Astro
    if (document.querySelector('[data-astro-cid]')) hints.push('astro');
    // Gatsby
    if (document.getElementById('___gatsby')) hints.push('gatsby');
    // Webflow
    if (document.documentElement.dataset.wfPage || document.querySelector('meta[name="generator"][content*="Webflow" i]')) hints.push('webflow');
    // Framer
    if (document.querySelector('meta[name="generator"][content*="Framer" i]')) hints.push('framer');
    // Generator meta tag (catch-all)
    const generator = document.querySelector('meta[name="generator"]');
    if (generator) hints.push(`generator:${generator.content.toLowerCase()}`);

    // Tailwind detection: presence of utility-class density
    const allClasses = new Set();
    for (const el of Array.from(document.querySelectorAll('[class]')).slice(0, 2000)) {
      for (const c of el.classList) allClasses.add(c);
    }
    const tailwindLike = Array.from(allClasses).filter(c => /^(p|m|w|h|text|bg|border|flex|grid|gap|space|rounded|shadow)-/.test(c));
    const tailwind = tailwindLike.length >= 30; // arbitrary threshold

    return { framework_hints: Array.from(new Set(hints)), tailwind };
  }
})();
