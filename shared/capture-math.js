// Small deterministic helpers shared by capture scripts and the file writer.
globalThis.SiteDossierCapture = Object.freeze({
  sampleIndices(count, limit) {
    if (count <= 0 || limit <= 0) return [];
    const size = Math.min(count, limit);
    if (size === 1) return [0];
    return Array.from({ length: size }, (_, i) => Math.round(i * (count - 1) / (size - 1)));
  },

  frameTimes(duration, count = 9) {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Video duration is unavailable.');
    const last = Math.max(0, duration - Math.min(0.1, duration / 10));
    return Array.from({ length: count }, (_, i) => last * i / Math.max(1, count - 1));
  },

  pixelBounds(rect, viewport, image) {
    const values = [rect?.x, rect?.y, rect?.width, rect?.height, viewport?.width, viewport?.height, image?.width, image?.height];
    if (!values.every(Number.isFinite) || values.slice(2).some(value => value <= 0) || rect.x < 0 || rect.y < 0 ||
        rect.x + rect.width > viewport.width + 0.5 || rect.y + rect.height > viewport.height + 0.5) {
      throw new Error('Selection must fit entirely inside the visible page.');
    }
    // Derive scale from the actual screenshot, including browser zoom / display scaling.
    const scaleX = image.width / viewport.width;
    const scaleY = image.height / viewport.height;
    const x = Math.floor(rect.x * scaleX);
    const y = Math.floor(rect.y * scaleY);
    const right = Math.min(image.width, Math.ceil((rect.x + rect.width) * scaleX));
    const bottom = Math.min(image.height, Math.ceil((rect.y + rect.height) * scaleY));
    return { x, y, width: right - x, height: bottom - y };
  },

  fontWeight(raw) {
    const exact = String(raw || '').trim();
    const value = exact === 'normal' ? '400' : exact === 'bold' ? '700' : exact;
    const numbers = value.split(/\s+/).map(Number);
    if (!value || numbers.some(n => !Number.isFinite(n) || n < 1 || n > 1000) || numbers.length > 2) {
      return { raw: exact, values: [], range: null };
    }
    return { raw: exact, values: numbers.length === 1 ? numbers : [],
      range: numbers.length === 2 && numbers[0] <= numbers[1] ? numbers : null };
  }
});
