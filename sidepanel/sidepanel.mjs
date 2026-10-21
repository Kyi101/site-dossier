import { items, changeItem, addItem, folderHandle } from '../shared/collector-db.mjs';
import { saveReference, readLibrary, splitList, sourceURL, MAX_IMAGE_BYTES, IMAGE_TYPES } from '../shared/library.mjs';
const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let handle, tray=[], busy=false, urls=[];
const channel = new BroadcastChannel('site-dossier-tray');
const libraryChannel = new BroadcastChannel('site-dossier-library-folder');
const status = text => $('status').textContent=text;
function fail(err) { $('error').textContent=err.message||String(err); $('error').hidden=false; }
function clearError() { $('error').hidden=true; }
function formState() { return {project:$('project').value,tags:$('tags').value,category:$('category').value}; }
function controls() {
  $('category-inbox').hidden=!$('category').value.trim();
  $('folder').textContent=handle?.name||'No folder selected';
  $('choose-folder').textContent=handle?'Change':'Choose';
  $('save').disabled=busy||!tray.length||tray.some(i=>!i.blob);
  $('save').textContent=busy?'Saving…':`Save ${tray.length || ''} reference${tray.length===1?'':'s'}`;
  document.querySelectorAll('#tray input, #tray textarea, #tray button').forEach(el => el.disabled = busy);
  for (const id of ['project','tags','category','choose-folder','screenshot','rectangle','add-url','category-inbox']) $(id).disabled=busy;
}
async function renderTray() {
  tray=await items();
  for(const url of urls) URL.revokeObjectURL(url); urls=[];
  $('count').textContent=tray.length;
  $('tray').innerHTML=tray.length?tray.map(item=>{
    const url=item.blob?URL.createObjectURL(item.blob):''; if(url) urls.push(url);
    return `<article class="item" data-id="${escape(item.id)}"><div class="item-top">${url?`<img class="thumb" src="${url}" alt="Collected reference">`:'<div class="thumb"></div>'}<div class="item-info"><input class="item-title" data-field="title" maxlength="200" aria-label="Reference title" value="${escape(item.title)}"><span class="source" title="${escape(item.source||item.imageSource)}">${escape(item.source||item.imageSource||'Local image')}</span><div class="item-actions">${url?'<button class="text" data-crop>Crop</button>':'<button class="text" data-load>Load image</button>'}<button class="text" data-remove>Remove</button></div></div></div><textarea data-field="note" maxlength="10000" aria-label="Note for this reference" placeholder="What would you borrow or avoid?">${escape(item.note)}</textarea>${item.error?`<p class="hint">${escape(item.error)}</p>`:''}</article>`;
  }).join(''):'<p class="empty">Your next reference starts here.</p>';
  controls();
}
channel.onmessage=()=>{ if(!busy && !document.activeElement?.matches('[data-field]')) renderTray().catch(fail); };
async function checkedImage(blob) {
  if(!IMAGE_TYPES.includes(blob.type)||!blob.size||blob.size>MAX_IMAGE_BYTES) throw new Error('Choose a PNG, JPG, WebP or GIF under 20 MB.');
  const bitmap=await createImageBitmap(blob);
  const tooLarge=bitmap.width>20000||bitmap.height>20000||bitmap.width*bitmap.height>80_000_000;
  bitmap.close(); if(tooLarge) throw new Error('This image is too large. Use an image under 20,000 pixels per edge and 80 megapixels.');
  return blob;
}
async function addFiles(files) {
  if(busy) return; clearError(); let added=0;
  for(const file of files) { try { await addItem({blob:await checkedImage(file),title:file.name?.replace(/\.[^.]+$/,'')||'Pasted image',kind:'image'}); added++; } catch(err) { fail(err); } }
  await renderTray(); if(added) status(`${added} image${added===1?'':'s'} added to your tray.`);
}
async function boundedBlob(response) {
  if(!response.ok) throw new Error(`Image server returned ${response.status}. Try a screenshot instead.`);
  if(Number(response.headers.get('content-length'))>MAX_IMAGE_BYTES) throw new Error('Image exceeds 20 MB.');
  const reader=response.body.getReader(), parts=[]; let size=0;
  try { while(true) { const {done,value}=await reader.read(); if(done) break; size+=value.length; if(size>MAX_IMAGE_BYTES) throw new Error('Image exceeds 20 MB.'); parts.push(value); } }
  finally { await reader.cancel(); }
  return new Blob(parts,{type:(response.headers.get('content-type')||'').split(';')[0]});
}
async function loadRemote(item) {
  try {
    const response=await fetch(item.imageSource,{credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',signal:AbortSignal.timeout(20000)});
    const blob=await checkedImage(await boundedBlob(response));
    await changeItem(item.id,old=>old?{...old,blob,error:''}:null);
    status('Image added. Its source link stays with it.');
  } catch(err) {
    await changeItem(item.id,old=>old?{...old,error:err.message}:null); fail(err);
  }
  await renderTray();
}
function addRemote(raw, source='') {
  if(busy) return;
  try {
    const imageSource=sourceURL(raw); if(!imageSource) throw new Error('Add a direct image link.');
    const context=source ? Promise.resolve(source) : chrome.tabs.query({active:true,currentWindow:true}).then(tabs=>tabs[0]?.url||'').catch(()=>'');
    clearError();
    return context.then(page=>{ let source=''; try { source=sourceURL(page); } catch {} return addItem({imageSource,source,title:'Image reference',kind:'image'}); })
      .then(item=>loadRemote(item)).catch(fail);
  } catch(err) { fail(err); }
}
document.addEventListener('paste',event=>{const files=[...(event.clipboardData?.files||[])];if(files.length){event.preventDefault();addFiles(files).catch(fail);}});
document.addEventListener('dragover',event=>{event.preventDefault();$('drop-zone').classList.add('dragging');});
document.addEventListener('dragleave',()=>$('drop-zone').classList.remove('dragging'));
document.addEventListener('drop',event=>{
  event.preventDefault();$('drop-zone').classList.remove('dragging'); if(busy)return;
  const files=[...event.dataTransfer.files]; if(files.length){addFiles(files).catch(fail);return;}
  const doc=new DOMParser().parseFromString(event.dataTransfer.getData('text/html'),'text/html');
  const image=doc.querySelector('img');
  const uri=event.dataTransfer.getData('text/uri-list').split(/\r?\n/).find(s=>s&&!s.startsWith('#'))||event.dataTransfer.getData('text/plain');
  const url=image?.getAttribute('src')||uri;
  if(url?.startsWith('data:image/')) { fetch(url).then(r=>r.blob()).then(blob=>addFiles([blob])).catch(fail);return; }
  // HTML is parsed only to obtain URLs, never inserted into the panel.
  let source=''; try { source=sourceURL(doc.querySelector('a')?.getAttribute('href')||''); } catch {}
  addRemote(url,source);
});
$('add-url').onclick=()=>addRemote($('image-url').value);
$('image-url').onkeydown=event=>{if(event.key==='Enter')addRemote($('image-url').value);};
$('choose-folder').onclick=async()=>{
  try { handle=await showDirectoryPicker({mode:'readwrite',id:'site-dossier-local'});await folderHandle(handle);controls();await projectSuggestions();clearError();status('Library folder set for all capture modes.'); }
  catch(err){if(err.name!=='AbortError')fail(err);}
};
async function refreshFolder() {
  if(busy)return;
  const next=await folderHandle();
  if(busy)return;
  handle=next;controls();await projectSuggestions();
}
libraryChannel.onmessage=()=>refreshFolder().catch(fail);
window.addEventListener('focus',()=>refreshFolder().catch(fail));
async function projectSuggestions() {
  if(!handle||await handle.queryPermission({mode:'readwrite'})!=='granted')return;
  const saved=await readLibrary(handle);
  $('categories').innerHTML=[...new Set(['Web design','App design','Banner design',...saved.references.map(r=>r.category).filter(Boolean)])].map(c=>`<option value="${escape(c)}"></option>`).join('');
  $('projects').innerHTML=[...new Set(saved.references.flatMap(r=>r.projects||[]))].map(p=>`<option value="${escape(p)}"></option>`).join('');
}
for(const name of ['project','tags','category']) $(name).addEventListener('input',()=>{
  $('category-inbox').hidden=!$('category').value.trim();
  chrome.storage.local.set({collectorBatch:formState()}).catch(fail);
});
$('category-inbox').onclick=()=>{
  $('category').value='';$('category').dispatchEvent(new Event('input',{bubbles:true}));$('category').focus();
  status('These references will go to Inbox.');
};
for(const [button,type] of [['screenshot','COLLECT_SCREENSHOT'],['rectangle','COLLECT_RECTANGLE']]) $(button).onclick=async()=>{
  clearError();$(button).disabled=true;
  try{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab)throw new Error('Open the page you want to capture.');
    const result=await chrome.runtime.sendMessage({type,tabId:tab.id,windowId:tab.windowId});
    if(!result?.ok)throw new Error(result?.error||'Screenshot failed.');
    await renderTray();status(button==='rectangle'?'Drag a rectangle on the page. Press Esc to cancel.':'Screenshot added. Use Crop to keep a specific detail.');
  }catch(err){fail(err);}finally{controls();}
};
$('tray').addEventListener('input',event=>{
  const field=event.target.dataset.field,id=event.target.closest('[data-id]')?.dataset.id;
  if(field&&id&&!busy)changeItem(id,old=>old?{...old,[field]:event.target.value}:null).catch(fail);
});
$('tray').addEventListener('click',event=>{
  if(busy)return;
  const card=event.target.closest('[data-id]'), item=tray.find(i=>i.id===card?.dataset.id);if(!item)return;
  if(event.target.closest('[data-remove]'))changeItem(item.id,()=>null).then(renderTray).catch(fail);
  if(event.target.closest('[data-crop]'))crop(item).catch(fail);
  if(event.target.closest('[data-load]')){
    loadRemote(item).catch(fail);
  }
});
async function crop(item) {
  const bitmap=await createImageBitmap(item.blob), url=URL.createObjectURL(item.blob), dialog=document.createElement('dialog');
  dialog.innerHTML=`<h2>Keep the detail</h2><p class="hint">Drag over the image or enter pixel coordinates.${item.blob.type === 'image/gif' ? ' Cropping a GIF saves its first frame as a PNG.' : ''}</p><div class="crop-wrap"><img class="crop-image" src="${url}" alt="Drag to select a crop"><div class="crop-box"></div></div><div class="crop-fields">${['X','Y','Width','Height'].map((name,i)=>`<label>${name}<input type="number" name="${name}" min="${i>1?1:0}" value="${[0,0,bitmap.width,bitmap.height][i]}"></label>`).join('')}</div><p class="crop-error" role="alert"></p><div class="dialog-actions"><button class="secondary" data-cancel>Cancel</button><button class="start-button" data-apply>Apply crop</button></div>`;
  document.body.append(dialog);dialog.showModal();const img=dialog.querySelector('img'),box=dialog.querySelector('.crop-box');
  const inputs=[...dialog.querySelectorAll('input')];
  const values=()=>inputs.map(i=>Number(i.value));
  const draw=()=>{const [x,y,w,h]=values();Object.assign(box.style,{left:100*x/bitmap.width+'%',top:100*y/bitmap.height+'%',width:100*w/bitmap.width+'%',height:100*h/bitmap.height+'%'});};
  inputs.forEach(i=>i.oninput=draw);img.onload=draw;draw();let start;
  const point=e=>{const r=img.getBoundingClientRect();return [Math.max(0,Math.min(bitmap.width,(e.clientX-r.left)/r.width*bitmap.width)),Math.max(0,Math.min(bitmap.height,(e.clientY-r.top)/r.height*bitmap.height))];};
  img.onpointerdown=e=>{start=point(e);img.setPointerCapture(e.pointerId);};
  img.onpointermove=e=>{if(!start)return;const end=point(e),v=[Math.min(start[0],end[0]),Math.min(start[1],end[1]),Math.abs(start[0]-end[0]),Math.abs(start[1]-end[1])];inputs.forEach((input,i)=>input.value=Math.round(v[i]));draw();};
  img.onpointerup=()=>start=null;
  const close=()=>{dialog.close();dialog.remove();URL.revokeObjectURL(url);bitmap.close();};
  dialog.oncancel=e=>{e.preventDefault();close();};dialog.querySelector('[data-cancel]').onclick=close;
  dialog.querySelector('[data-apply]').onclick=async()=>{
    try{
      const [x,y,w,h]=values();if(![x,y,w,h].every(Number.isInteger)||x<0||y<0||w<1||h<1||x+w>bitmap.width||y+h>bitmap.height)throw new Error('Keep the crop inside the image.');
      const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;canvas.getContext('2d').drawImage(bitmap,x,y,w,h,0,0,w,h);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      await checkedImage(blob);
      await changeItem(item.id,old=>old?{...old,blob,crop:{x,y,width:w,height:h}}:null);close();await renderTray();status('Crop applied to this draft.');
    }catch(err){dialog.querySelector('.crop-error').textContent=err.message;}
  };
}
$('save').onclick=async()=>{
  if(busy)return;clearError();busy=true;controls();
  try{
    handle=await folderHandle();
    if(!handle)throw new Error('Choose a shared library folder first.');
    if(await handle.requestPermission({mode:'readwrite'})!=='granted')throw new Error('Folder access was not granted. Your tray is kept.');
    await navigator.locks.request('site-dossier-save-tray',async()=>{
      const snapshot=await items(),fields=formState();let saved=0,failed=0;
      for(const item of snapshot){
        try{
          if(!item.blob)throw new Error('Load this image before saving.');
          const {blob,error,...record}=item;
          await saveReference(handle,{...record,title:record.title.trim()||'Untitled reference',projects:fields.project.trim()?[fields.project.trim()]:[],tags:splitList(fields.tags),category:fields.category.trim()},blob,{createOnly:true});
          await changeItem(item.id,()=>null);saved++;
        }catch(err){failed++;await changeItem(item.id,old=>old?{...old,error:err.message}:null);fail(err);}
      }
      status(`${saved} reference${saved===1?'':'s'} saved to ${handle.name}.${failed?` ${failed} kept in the tray. Retry when ready.`:' Images and notes are saved together.'}`);
    });
    await projectSuggestions();
  }catch(err){fail(err);}finally{busy=false;await renderTray();await refreshFolder().catch(fail);}
};
try{
  const stored=await chrome.storage.local.get(['collectorBatch','collectorError']);
  for(const name of ['project','tags','category']) $(name).value=stored.collectorBatch?.[name]||'';
  handle=await folderHandle();await renderTray();await projectSuggestions();
  if(stored.collectorError){fail(stored.collectorError);await chrome.storage.local.remove('collectorError');}
}catch(err){fail(err);}
chrome.storage.onChanged.addListener(changes=>{if(changes.collectorStatus?.newValue){status(changes.collectorStatus.newValue);chrome.storage.local.remove('collectorStatus');}if(changes.collectorError?.newValue){fail(changes.collectorError.newValue);chrome.storage.local.remove('collectorError');}});
