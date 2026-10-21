(() => {
  if (window.__siteDossierSelectionLoaded) return;
  window.__siteDossierSelectionLoaded = true;
  let host = null, root, plane, boxes, toolbar, controls, frameId;
  let tool = 'element', selected = [], active = -1, hover = null, drag = null;
  let saving = false, status = '', previousFocus = null;
  let view = null, panelDrag = null;
  const heldAnimations = new Set();
  const properties = ['display', 'position', 'width', 'height', 'color', 'background-color', 'background-image',
    'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-transform',
    'text-align', 'padding', 'margin', 'gap', 'grid-template-columns', 'grid-template-rows', 'flex-direction',
    'align-items', 'justify-content', 'border', 'border-radius', 'box-shadow', 'opacity', 'transform',
    'transition', 'animation', 'fill', 'stroke', 'stroke-width', 'object-fit', 'overflow'];

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.type === 'START_SELECTION') {
      try { open(message); reply({ ok: true }); } catch (err) { close(); reply({ ok: false, error: err.message }); }
      return false;
    }
    if (message.type === 'CLOSE_SELECTION') { close(); reply({ ok: true }); }
    return false;
  });

  function node(tag, text, className) {
    const result = document.createElement(tag);
    if (text) result.textContent = text;
    if (className) result.className = className;
    return result;
  }
  function button(label, action, className) {
    const result = node('button', label, className);
    result.type = 'button';
    result.addEventListener('click', event => { event.stopPropagation(); action(); });
    return result;
  }
  function viewport() {
    return { width: innerWidth, height: innerHeight, scroll_x: scrollX, scroll_y: scrollY,
      device_pixel_ratio: devicePixelRatio, visual_scale: window.visualViewport?.scale || 1 };
  }
  function rectOf(item) {
    if (item.kind === 'rectangle') return item.bounds;
    if (!item.element.isConnected) return null;
    const rect = item.element.getBoundingClientRect();
    let padX = 0, padY = 0;
    // SVG geometry can have no width/height even when its stroke is visible.
    if ((rect.width < 1 || rect.height < 1) && item.element.getScreenCTM) {
      const style = getComputedStyle(item.element);
      const stroke = parseFloat(style.strokeWidth);
      if (style.stroke !== 'none' && Number(style.strokeOpacity) > 0 && stroke > 0) {
        const matrix = item.element.getScreenCTM();
        const scaled = matrix && style.vectorEffect !== 'non-scaling-stroke';
        const scaleX = scaled ? Math.hypot(matrix.a, matrix.c) : 1;
        const scaleY = scaled ? Math.hypot(matrix.b, matrix.d) : 1;
        if (rect.width < 1) padX = Math.max(1, stroke * scaleX) / 2;
        if (rect.height < 1) padY = Math.max(1, stroke * scaleY) / 2;
      }
    }
    return { x: rect.x - padX, y: rect.y - padY, width: rect.width + 2 * padX, height: rect.height + 2 * padY };
  }
  function fits(rect) {
    if (!rect || rect.width < 1 || rect.height < 1) return false;
    try { SiteDossierCapture.pixelBounds(rect, viewport(), viewport()); return true; } catch { return false; }
  }
  function syncAnimations(elements = selected.filter(item => item.kind === 'element').map(item => item.element)) {
    const relevant = animation => {
      const target = animation.effect?.target?.element || animation.effect?.target;
      return target && elements.some(element => element === target || element.contains?.(target) || target.contains?.(element));
    };
    for (const animation of heldAnimations) {
      if (!relevant(animation)) {
        heldAnimations.delete(animation);
        try { if (animation.playState === 'paused' && animation.currentTime !== null) animation.play(); } catch {}
      }
    }
    if (!elements.length) return;
    for (const animation of document.getAnimations()) {
      if (heldAnimations.has(animation) || animation.playState !== 'running' || !relevant(animation)) continue;
      try {
        const time = animation.currentTime;
        animation.pause();
        if (time !== null) animation.currentTime = time;
        heldAnimations.add(animation);
      } catch {}
    }
  }

  function label(item) {
    return item.kind === 'rectangle' ? 'Rectangle' : item.element.localName + (item.element.id ? `#${item.element.id.slice(0, 80)}` : '');
  }

  function open(message) {
    close();
    previousFocus = document.activeElement;
    selected = []; active = -1; hover = null; drag = null; panelDrag = null; saving = false; status = '';
    tool = message.tool === 'rectangle' ? 'rectangle' : 'element';
    view = viewport();
    host = node('site-dossier-selection');
    host.id = 'site-dossier-selection';
    host.popover = 'manual';
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;pointer-events:none!important';
    root = host.attachShadow({ mode: 'closed' });
    const style = new CSSStyleSheet();
    style.replaceSync(message.css);
    root.adoptedStyleSheets = [style];
    plane = node('div', '', 'plane');
    plane.tabIndex = 0;
    plane.setAttribute('aria-label', 'Selection surface. Click elements or drag a rectangle. Escape cancels.');
    boxes = node('div', '', 'boxes');
    toolbar = node('div', '', 'toolbar');
    toolbar.setAttribute('role', 'region');
    toolbar.setAttribute('aria-label', 'Site Dossier selection controls');
    const first = node('div', '', 'row heading');
    controls = {
      save: button('Save', save, 'save'),
      cancel: button('Close', cancel, 'cancel'),
      active: node('select'),
      note: node('input'),
      hint: node('p', '', 'hint'),
      handle: node('div', '', 'drag-handle')
    };
    controls.handle.tabIndex = 0;
    controls.handle.title = 'Drag to move · Arrow keys when focused';
    controls.handle.setAttribute('aria-label', 'Move selection panel. Drag or use arrow keys.');
    controls.handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || saving) return;
      event.preventDefault(); event.stopPropagation();
      const bounds = toolbar.getBoundingClientRect();
      panelDrag = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      controls.handle.setPointerCapture(event.pointerId);
      controls.handle.focus({ preventScroll: true });
      hover = null;
    });
    controls.handle.addEventListener('pointermove', event => {
      if (panelDrag) positionPanel(event.clientX - panelDrag.x, event.clientY - panelDrag.y);
    });
    const stopPanelDrag = () => { panelDrag = null; };
    controls.handle.addEventListener('pointerup', stopPanelDrag);
    controls.handle.addEventListener('pointercancel', stopPanelDrag);
    controls.handle.addEventListener('lostpointercapture', stopPanelDrag);
    first.append(controls.handle, controls.save, controls.cancel);
    controls.active.className = 'items';
    controls.active.setAttribute('aria-label', 'Item to annotate');
    controls.active.addEventListener('change', () => { active = Number(controls.active.value); update(); });
    controls.note.type = 'text';
    controls.note.id = 'selection-note';
    controls.note.setAttribute('aria-label', 'Item note (optional)');
    controls.note.placeholder = 'Add any relevant context…';
    controls.note.addEventListener('input', () => { if (selected[active]) selected[active].note = controls.note.value; });
    controls.hint.setAttribute('role', 'status');
    toolbar.append(first, controls.active, controls.note, controls.hint);
    toolbar.addEventListener('click', event => event.stopPropagation());
    toolbar.addEventListener('pointerenter', () => { hover = null; });
    root.append(plane, boxes, toolbar);
    document.documentElement.append(host);
    host.showPopover();
    plane.addEventListener('pointermove', pointerMove);
    plane.addEventListener('pointerdown', pointerDown);
    plane.addEventListener('pointerup', pointerUp);
    plane.addEventListener('pointercancel', () => { drag = null; syncAnimations(); update(); });
    plane.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
    window.addEventListener('keydown', keyboard, true);
    window.addEventListener('resize', changedView);
    window.addEventListener('scroll', changedView, true);
    window.addEventListener('pagehide', cancel);
    update();
    controls.cancel.focus({ preventScroll: true });
    paint();
  }

  function close() {
    syncAnimations([]);
    if (frameId) cancelAnimationFrame(frameId);
    frameId = null;
    window.removeEventListener('keydown', keyboard, true);
    window.removeEventListener('resize', changedView);
    window.removeEventListener('scroll', changedView, true);
    window.removeEventListener('pagehide', cancel);
    host?.remove(); host = null;
    if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
    previousFocus = null;
  }
  async function cancel() {
    if (saving) return;
    close();
    try { await chrome.runtime.sendMessage({ type: 'SELECTION_CANCEL' }); } catch {}
  }
  function positionPanel(x, y) {
    const bounds = toolbar.getBoundingClientRect();
    const margin = 12;
    toolbar.style.left = Math.max(margin, Math.min(x, innerWidth - bounds.width - margin)) + 'px';
    toolbar.style.top = Math.max(margin, Math.min(y, innerHeight - bounds.height - margin)) + 'px';
    toolbar.style.bottom = 'auto';
    toolbar.style.transform = 'none';
  }
  function changedView() {
    if (!host || saving) return;
    const next = viewport();
    if (toolbar.style.top) {
      const bounds = toolbar.getBoundingClientRect();
      positionPanel(bounds.left, bounds.top);
    }
    if (tool === 'rectangle' && (view.width !== next.width || view.height !== next.height || view.scroll_x !== next.scroll_x || view.scroll_y !== next.scroll_y)) {
      if (selected.length || drag) status = 'The view changed. Draw the rectangle again.';
      selected = []; active = -1; drag = null;
    }
    hover = null;
    view = next;
    update();
  }
  function elementAt(x, y) {
    // Disable only our input plane for hit testing. The host's protected
    // shadow styles intentionally override page/inline style changes.
    plane.style.setProperty('pointer-events', 'none', 'important');
    let element = document.elementFromPoint(x, y);
    while (element?.shadowRoot?.elementFromPoint) {
      const child = element.shadowRoot.elementFromPoint(x, y);
      if (!child || child === element) break;
      element = child;
    }
    plane.style.removeProperty('pointer-events');
    return element && !['html', 'body', 'site-dossier-control', 'site-dossier-selection'].includes(element.localName) ? element : null;
  }
  function pointerMove(event) {
    if (saving) return;
    if (drag) {
      drag.end = { x: Math.max(0, Math.min(innerWidth, event.clientX)), y: Math.max(0, Math.min(innerHeight, event.clientY)) };
    } else if (tool === 'element') hover = elementAt(event.clientX, event.clientY);
  }
  function pointerDown(event) {
    if (saving || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    plane.setPointerCapture(event.pointerId);
    if (tool === 'element') {
      const candidate = elementAt(event.clientX, event.clientY);
      if (candidate) syncAnimations([...selected.map(item => item.element), candidate].filter(Boolean));
    }
    if (tool === 'rectangle') {
      plane.setPointerCapture(event.pointerId);
      drag = { start: { x: event.clientX, y: event.clientY }, end: { x: event.clientX, y: event.clientY } };
    }
  }
  function dragBounds() {
    return { x: Math.min(drag.start.x, drag.end.x), y: Math.min(drag.start.y, drag.end.y),
      width: Math.abs(drag.end.x - drag.start.x), height: Math.abs(drag.end.y - drag.start.y) };
  }
  function pointerUp(event) {
    if (saving || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); status = '';
    if (plane.hasPointerCapture(event.pointerId)) plane.releasePointerCapture(event.pointerId);
    if (tool === 'rectangle' && drag) {
      const bounds = dragBounds(); drag = null;
      if (plane.hasPointerCapture(event.pointerId)) plane.releasePointerCapture(event.pointerId);
      if (bounds.width < 4 || bounds.height < 4) status = 'Draw an area at least 4 × 4 pixels.';
      else { selected = [{ kind: 'rectangle', bounds, note: '' }]; active = 0; }
    } else if (tool === 'element') {
      const element = elementAt(event.clientX, event.clientY);
      if (!element) { selected = []; active = -1; update(); return; }
      const existing = selected.findIndex(item => item.element === element);
      if (!event.ctrlKey && !event.metaKey) {
        // A plain click selects just one item; preserve its note if reselected.
        selected = [existing >= 0 ? selected[existing] : { kind: 'element', element, note: '' }];
        active = 0;
      } else if (existing >= 0) { selected.splice(existing, 1); active = selected.length - 1; }
      else if (selected.length >= 8) status = 'Up to eight elements per capture. Save these first.';
      else { selected.push({ kind: 'element', element, note: '' }); active = selected.length - 1; }
    }
    update();
  }
  function keyboard(event) {
    if (!host || saving) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); void cancel(); }
    if (root.activeElement === controls.handle) {
      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (direction) {
        event.preventDefault(); event.stopImmediatePropagation();
        const bounds = toolbar.getBoundingClientRect();
        const step = event.shiftKey ? 40 : 10;
        positionPanel(bounds.left + direction[0] * step, bounds.top + direction[1] * step);
      }
    }
    if (root.activeElement === controls.note || root.activeElement === controls.active) return;
    if (event.key === 'Enter' && root.activeElement === plane) { event.preventDefault(); if (!controls.save.disabled) void save(); }
  }
  function update() {
    if (!host) return;
    syncAnimations();
    const item = selected[active];
    controls.active.replaceChildren(...selected.map((entry, index) => {
      const option = node('option', `${index + 1}. ${label(entry)}`);
      option.value = String(index); return option;
    }));
    controls.active.value = String(active);
    controls.note.value = item?.note || '';
    for (const control of Object.values(controls)) if ('disabled' in control) control.disabled = saving;
    controls.cancel.disabled = saving;
    controls.cancel.textContent = 'Close';
    controls.active.disabled ||= !item;
    controls.note.disabled ||= !item;
    controls.active.hidden = selected.length < 2;
    controls.note.hidden = !item;
    controls.handle.textContent = tool === 'rectangle' ? 'Rectangle' : 'Elements';
    controls.save.textContent = saving ? 'Saving…' : 'Save';
    // Keep a dragged panel within reach when adding the note/item menu changes its height.
    if (toolbar.style.top) {
      const bounds = toolbar.getBoundingClientRect();
      positionPanel(bounds.left, bounds.top);
    }
    updateStatus();
  }
  function updateStatus() {
    const valid = selected.length > 0 && selected.every(item => fits(rectOf(item)));
    const pinched = (window.visualViewport?.scale || 1) !== 1;
    controls.save.disabled = saving || !valid || pinched;
    const error = pinched ? 'Reset pinch zoom before selecting. Browser zoom is supported.' : selected.length && !valid ? 'Selection extends outside the view or is no longer visible. Scroll, zoom out, or use Page capture.' : '';
    controls.hint.textContent = status || error || (heldAnimations.size ? 'Animation held while selected. Save or close to resume.' : tool === 'element'
      ? 'Click to select. Ctrl/Cmd-click adds or removes. Esc cancels.'
      : 'Drag to select an area. Drag the panel heading to move it. Esc cancels.');
    controls.hint.classList.toggle('error', Boolean(error) && !status);
  }
  function paintBox(bounds, text, extra = '') {
    if (!bounds) return;
    const box = node('div', '', 'box ' + extra);
    box.style.cssText = `left:${bounds.x}px;top:${bounds.y}px;width:${bounds.width}px;height:${bounds.height}px`;
    box.append(node('span', text)); boxes.append(box);
  }
  function paint() {
    if (!host) return;
    boxes.replaceChildren();
    selected.forEach((item, index) => { const bounds = rectOf(item); paintBox(bounds, String(index + 1), fits(bounds) ? '' : 'invalid'); });
    if (hover && !drag && tool === 'element') paintBox(rectOf({ element: hover }), hover.localName, 'hover');
    if (drag) paintBox(dragBounds(), 'Area');
    updateStatus();
    frameId = requestAnimationFrame(paint);
  }

  function observedStructure(element) {
    const nodes = [];
    let truncated = false;
    let characters = 0;
    const clipped = (value, limit) => {
      if (value.length > limit) truncated = true;
      return value.slice(0, limit);
    };
    function visit(current, parent, depth) {
      if (nodes.length >= 100 || depth > 6) { truncated = true; return; }
      const index = nodes.length;
      const style = getComputedStyle(current);
      const styles = Object.fromEntries(properties.map(key => [key, clipped(style.getPropertyValue(key), 2048)]));
      const attributes = {};
      for (const name of ['id', 'class', 'role', 'aria-label', 'href', 'src', 'alt', 'viewBox', 'preserveAspectRatio',
        'd', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height']) {
        if (current.hasAttribute(name)) attributes[name] = clipped(current.getAttribute(name), 1600);
      }
      const text = clipped(Array.from(current.childNodes).filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join('').trim(), 500);
      const pseudo = {};
      for (const which of ['::before', '::after']) {
        const computed = getComputedStyle(current, which);
        if (computed.content && !['none', 'normal'].includes(computed.content)) pseudo[which] = { content: clipped(computed.content, 500), color: computed.color, font: clipped(computed.font, 500) };
      }
      const record = { index, parent, tag: current.localName, attributes, text, styles, pseudo };
      characters += JSON.stringify(record).length;
      if (characters > 256000) { truncated = true; return; }
      nodes.push(record);
      for (const child of [...current.children, ...(current.shadowRoot?.children || [])]) {
        if (nodes.length >= 100 || characters >= 256000) { truncated = true; break; }
        visit(child, index, depth + 1);
      }
    }
    visit(element, null, 0);
    return { schema_version: 1, observations_only: true, source: 'computed styles and bounded DOM structure',
      node_limit: 100, depth_limit: 6, character_limit: 256000, truncated, nodes };
  }
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
  async function save() {
    if (controls.save.disabled) return;
    saving = true; status = 'Taking the selection screenshot…'; update();
    let submitted = false;
    try {
      const before = viewport();
      const items = selected.map(item => {
        const bounds = rectOf(item);
        if (!fits(bounds)) throw new Error('Selection moved outside the view. Select it again.');
        return { kind: item.kind, bounds, document_bounds: { ...bounds, x: bounds.x + scrollX, y: bounds.y + scrollY },
          note: item.note, ...(item.kind === 'element' ? { element: { tag: item.element.localName, id: item.element.id?.slice(0, 200) || null,
            selector_hint: label(item), opaque_frame: item.element.localName === 'iframe' }, structure: observedStructure(item.element) } : {}) };
      });
      for (const layer of [plane, boxes, toolbar]) layer.style.setProperty('visibility', 'hidden', 'important');
      await nextFrame(); await nextFrame();
      const screenshot = await chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE_TAB' });
      if (!screenshot?.dataUrl) throw new Error(screenshot?.error || 'Could not capture the visible page.');
      if (JSON.stringify(before) !== JSON.stringify(viewport()) || selected.some((item, index) => {
        const after = rectOf(item);
        return !after || ['x', 'y', 'width', 'height'].some(key => Math.abs(after[key] - items[index].bounds[key]) > 1);
      })) throw new Error('The view or selection moved during capture. Try a rectangle for a visual snapshot, or pause the animation on the page.');
      // The screenshot is complete; keep the controls visible during disk writes.
      for (const layer of [plane, boxes, toolbar]) layer.style.removeProperty('visibility');
      submitted = true;
      const response = await chrome.runtime.sendMessage({ type: 'SELECTION_BUNDLE_READY', screenshot,
        selection: { viewport: before, captured_at: new Date().toISOString(),
          motion: { paused_browser_animations: heldAnimations.size, resumed_after_save: true }, items } });
      if (!response?.ok) throw new Error(response?.error || 'Could not save the selection.');
      status = `Saved ${response.result.folderName}/${response.result.viewport}`;
      selected = []; active = -1; hover = null; drag = null;
      view = viewport();
    } catch (err) {
      status = (submitted ? 'Save failed. Some files may already exist. ' : 'Try again: ') + (err.message || err);
    } finally {
      saving = false;
      if (host) for (const layer of [plane, boxes, toolbar]) layer.style.removeProperty('visibility');
      update();
    }
  }
})();
