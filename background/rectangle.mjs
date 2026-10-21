// These functions run in the page's isolated extension world.
export function viewport() {
  return { width:innerWidth, height:innerHeight, x:scrollX, y:scrollY, ratio:devicePixelRatio,
    scale:visualViewport?.scale ?? 1, offsetX:visualViewport?.offsetLeft ?? 0, offsetY:visualViewport?.offsetTop ?? 0 };
}

export function sameViewport(a, b) {
  return a && b && ['width','height','x','y','ratio','scale','offsetX','offsetY'].every(key =>
    Number.isFinite(a[key]) && a[key] === b[key]) && a.width > 0 && a.height > 0 && a.scale === 1;
}

export async function dismissRectangle() {
  globalThis.siteDossierCollectorCancel?.();
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

export function selectRectangle(token) {
  globalThis.siteDossierCollectorCancel?.();
  const initial = { width:innerWidth, height:innerHeight, x:scrollX, y:scrollY, ratio:devicePixelRatio,
    scale:visualViewport?.scale ?? 1, offsetX:visualViewport?.offsetLeft ?? 0, offsetY:visualViewport?.offsetTop ?? 0 };
  if (initial.scale !== 1) throw new Error('Reset pinch zoom before selecting a rectangle.');
  const previousFocus = document.activeElement;
  const host = document.createElement('div');
  host.id = 'site-dossier-collector-rectangle';
  host.style.setProperty('all','initial','important');
  const shadow = host.attachShadow({mode:'closed'}), dialog = document.createElement('dialog');
  const style = document.createElement('style');
  style.textContent = `dialog { position:fixed; inset:0; margin:0; padding:0; border:0; max-width:none; max-height:none; width:100vw; height:100vh; background:transparent; color:#fff; cursor:crosshair; touch-action:none; user-select:none; overflow:hidden; }
    dialog::backdrop { background:transparent; }
    .help { position:absolute; top:16px; left:50%; transform:translateX(-50%); display:flex; align-items:center; gap:16px; white-space:nowrap; padding:10px 14px; border-radius:8px; background:#202722; font:13px system-ui; box-shadow:0 2px 15px #0003; }
    button { font:inherit; color:#fff; background:transparent; border:1px solid #ffffff60; border-radius:5px; padding:4px 8px; cursor:pointer; }
    .box { position:absolute; box-sizing:border-box; border:2px solid #85dab0; box-shadow:0 0 0 100vmax #0004; pointer-events:none; }`;
  const help = document.createElement('div'); help.className='help';
  const instruction = document.createElement('span'); instruction.textContent='Drag to capture a rectangle · Esc to cancel';
  const cancel = document.createElement('button'); cancel.textContent='Cancel';
  const box = document.createElement('div'); box.className='box'; box.hidden=true;
  help.append(instruction,cancel); dialog.append(box,help); shadow.append(style,dialog); document.documentElement.append(host);
  dialog.setAttribute('aria-label','Select a screenshot rectangle');
  const events = new AbortController(); let start, done=false;
  function cleanup() {
    events.abort(); dialog.close(); host.remove();
    if (globalThis.siteDossierCollectorCancel === silentCancel) delete globalThis.siteDossierCollectorCancel;
    if (previousFocus?.isConnected) previousFocus.focus({preventScroll:true});
  }
  async function finish(rect, reason='') {
    if (done) return; done=true; cleanup();
    if (rect) await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    chrome.runtime.sendMessage({type:'COLLECT_RECTANGLE_DONE',token,rect,viewport:initial,reason}).catch(()=>{});
  }
  function silentCancel() { if (!done) { done=true; cleanup(); } }
  globalThis.siteDossierCollectorCancel=silentCancel;
  const listen=(target,name,fn,options={})=>target.addEventListener(name,fn,{...options,signal:events.signal});
  cancel.onclick=()=>finish(null);
  listen(dialog,'cancel',event=>{event.preventDefault();finish(null);});
  listen(document,'visibilitychange',()=>{if(document.hidden)finish(null);});
  listen(window,'pagehide',()=>finish(null));
  const moved=()=>finish(null,'The page moved or resized. Draw the rectangle again.');
  listen(window,'resize',moved); listen(window,'scroll',moved,{capture:true});
  if (visualViewport) { listen(visualViewport,'resize',moved); listen(visualViewport,'scroll',moved); }
  listen(dialog,'wheel',event=>event.preventDefault(),{passive:false});
  listen(dialog,'keydown',event=>{if(['ArrowDown','ArrowUp','PageDown','PageUp','Home','End',' '].includes(event.key))event.preventDefault();});
  const point=event=>({x:Math.max(0,Math.min(innerWidth,event.clientX)),y:Math.max(0,Math.min(innerHeight,event.clientY))});
  const bounds=event=>{const end=point(event);return {x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),width:Math.abs(end.x-start.x),height:Math.abs(end.y-start.y)};};
  listen(dialog,'pointerdown',event=>{
    if(event.button!==0||help.contains(event.target)||start)return;
    event.preventDefault();start=point(event);dialog.setPointerCapture(event.pointerId);box.hidden=false;
    Object.assign(box.style,{left:start.x+'px',top:start.y+'px',width:'0',height:'0'});
  });
  listen(dialog,'pointermove',event=>{if(!start)return;const r=bounds(event);Object.assign(box.style,{left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px'});});
  listen(dialog,'pointerup',event=>{
    if(!start)return;const r=bounds(event);start=null;
    if(dialog.hasPointerCapture(event.pointerId))dialog.releasePointerCapture(event.pointerId);
    if(r.width<4||r.height<4){box.hidden=true;instruction.textContent='Drag a larger rectangle · Esc to cancel';return;}
    finish(r);
  });
  listen(dialog,'pointercancel',()=>finish(null));
  dialog.showModal(); cancel.focus({preventScroll:true});
}
