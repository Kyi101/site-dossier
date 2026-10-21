let opening;
function db() {
  return opening ||= new Promise((resolve,reject) => {
    const r = indexedDB.open('site-dossier-collector',1);
    r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath:'id' });
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
export async function items() {
  const d = await db();
  return new Promise((resolve,reject) => { const r=d.transaction('items').objectStore('items').getAll(); r.onsuccess=()=>resolve(r.result.sort((a,b)=>a.created.localeCompare(b.created))); r.onerror=()=>reject(r.error); });
}
export async function changeItem(id, change) {
  const d = await db();
  return new Promise((resolve,reject) => {
    const tx=d.transaction('items','readwrite'), store=tx.objectStore('items'); let result;
    const r=store.get(id);
    r.onsuccess=()=>{ try { result=change(r.result); if (result) store.put(result); else store.delete(id); } catch(err) { tx.abort(); reject(err); } };
    tx.oncomplete=()=>{ const channel=new BroadcastChannel('site-dossier-tray'); channel.postMessage('changed'); channel.close(); resolve(result); };
    tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error || new Error('Tray update interrupted.'));
  });
}
export async function addItem(fields) {
  const all = await items();
  if (all.length >= 100 || all.reduce((n,i)=>n+(i.blob?.size||0),0)+(fields.blob?.size||0)>250*1024*1024) throw new Error('Save this tray before adding more (100 images or 250 MB).');
  const item = { id:crypto.randomUUID(), title:'Untitled reference', source:'', imageSource:'', note:'', tags:[], aspects:[], projects:[], category:'', history:[], created:new Date().toISOString(), ...fields };
  await changeItem(item.id,()=>item); return item;
}
export async function folderHandle(next) {
  const d=await new Promise((resolve,reject)=>{ const r=indexedDB.open('design-capture',1); r.onupgradeneeded=()=>r.result.createObjectStore('config'); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); });
  try {
    const result=await new Promise((resolve,reject)=>{ const tx=d.transaction('config', next ? 'readwrite':'readonly'), s=tx.objectStore('config'); const r=next?s.put(next,'inspoDirHandle'):s.get('inspoDirHandle'); let value; r.onsuccess=()=>value=r.result; tx.oncomplete=()=>resolve(next||value||null); tx.onerror=()=>reject(tx.error); });
    if(next){const channel=new BroadcastChannel('site-dossier-library-folder');channel.postMessage('changed');channel.close();}
    return result;
  } finally { d.close(); }
}
