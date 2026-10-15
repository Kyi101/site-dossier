// Decode once, keep a small overview sheet and readable timestamped frames.
async function generateVideoEvidence(videoBlob, elapsedS, writeFrame, signal) {
  const videoUrl = URL.createObjectURL(videoBlob);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.style.cssText = 'position:absolute;left:-99999px';
  try {
    const ready = mediaEvent(video, 'loadeddata', 10000, signal);
    video.src = videoUrl;
    document.body.appendChild(video);
    await ready;
    let duration = video.duration;
    // MediaRecorder WebM often has no duration header. Seeking past the end
    // lets Chrome discover the media timeline; the elapsed clock is a fallback.
    if (!Number.isFinite(duration) || duration <= 0) {
      try { await seekTo(video, 1e6, signal); } catch (err) { if (signal.aborted) throw err; }
      duration = video.duration;
    }
    const durationBasis = Number.isFinite(duration) && duration > 0 ? 'media-timeline' : 'recording-elapsed-estimate';
    if (durationBasis !== 'media-timeline') duration = elapsedS;
    const times = SiteDossierCapture.frameTimes(duration);
    if (!video.videoWidth || !video.videoHeight) throw new Error('Video dimensions unavailable.');
    const frameScale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    const frame = document.createElement('canvas');
    frame.width = Math.max(1, Math.round(video.videoWidth * frameScale));
    frame.height = Math.max(1, Math.round(video.videoHeight * frameScale));
    const sheet = document.createElement('canvas');
    const cellWidth = 320;
    const cellHeight = Math.round(cellWidth * video.videoHeight / video.videoWidth);
    const labelHeight = 24;
    sheet.width = cellWidth * 3;
    sheet.height = (cellHeight + labelHeight) * 3;
    const ctx = sheet.getContext('2d');
    ctx.fillStyle = '#111718';
    ctx.fillRect(0, 0, sheet.width, sheet.height);
    let bytes = 0;
    for (const [index, time] of times.entries()) {
      signal.throwIfAborted();
      await seekTo(video, time, signal);
      frame.getContext('2d').drawImage(video, 0, 0, frame.width, frame.height);
      const blob = await canvasBlob(frame, 'image/jpeg', 0.9);
      bytes += blob.size;
      if (bytes > 8 * 1024 * 1024) throw new Error('Video stills reached the 8 MiB limit.');
      const timestamp = Math.round(video.currentTime * 1000) / 1000;
      await writeFrame(blob, { timestamp_s: timestamp, requested_timestamp_s: Math.round(time * 1000) / 1000,
        time_basis: durationBasis, width: frame.width, height: frame.height });
      const x = (index % 3) * cellWidth;
      const y = Math.floor(index / 3) * (cellHeight + labelHeight);
      ctx.drawImage(frame, x, y, cellWidth, cellHeight);
      ctx.fillStyle = '#f2f5f2';
      ctx.font = '12px sans-serif';
      ctx.fillText(`${index + 1} · ${timestamp.toFixed(2)}s`, x + 8, y + cellHeight + 17);
    }
    return { sheet: await canvasBlob(sheet, 'image/png'), duration_s: duration, duration_basis: durationBasis };
  } finally {
    video.remove();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(videoUrl);
  }
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Image encoding failed.')), type, quality));
}

function mediaEvent(video, event, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`${event} timed out`)), timeoutMs);
    const success = () => finish();
    const error = () => finish(new Error('Video decoding failed.'));
    const aborted = () => finish(new Error('Video stills timed out.'));
    function finish(err) {
      clearTimeout(timer);
      video.removeEventListener(event, success);
      video.removeEventListener('error', error);
      signal?.removeEventListener('abort', aborted);
      err ? reject(err) : resolve();
    }
    video.addEventListener(event, success, { once: true });
    video.addEventListener('error', error, { once: true });
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

async function seekTo(video, time, signal) {
  const target = Math.max(0, Math.min(time, Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.01) : time));
  if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.01) return;
  const pending = mediaEvent(video, 'seeked', 5000, signal);
  try { video.currentTime = target; }
  catch (err) { video.dispatchEvent(new Event('error')); await pending.catch(() => {}); throw err; }
  await pending;
}

function decodeImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Screenshot could not be decoded.'));
    image.src = dataUrl;
  });
}
