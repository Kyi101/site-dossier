import test from 'node:test';
import assert from 'node:assert/strict';
import { saveReference, readLibrary, saveGuidance, sourceURL, LIBRARY_DIR } from '../shared/library.mjs';
class Dir {
  kind='directory'; dirs=new Map(); files=new Map(); fail=null;
  constructor(name='root',root=null){this.name=name;this.root=root||this;}
  async getDirectoryHandle(name,{create=false}={}){if(!this.dirs.has(name)){if(!create)throw new DOMException('Missing','NotFoundError');this.dirs.set(name,new Dir(name,this.root));}return this.dirs.get(name);}
  async getFileHandle(name,{create=false}={}){
    if(!this.files.has(name)){if(!create)throw new DOMException('Missing','NotFoundError');this.files.set(name,new Blob());}
    const dir=this;
    return {kind:'file',name,async getFile(){return dir.files.get(name);},async createWritable(){let pending;return {async write(data){if(dir.root.fail?.(dir.name,name))throw new Error('Disk write failed');pending=data instanceof Blob?data:new Blob([data]);},async close(){dir.files.set(name,pending);},async abort(){}};}};
  }
  async *entries(){for(const e of this.dirs)yield e;for(const [name]of this.files)yield[name,await this.getFileHandle(name)];}
}
const ref=(id='test-reference')=>({id,title:'Type study',note:'Borrow spacing; avoid the buttons.',category:'Web design',source:'https://example.test/a',tags:['type'],aspects:['Spacing'],projects:['Client A'],created:new Date().toISOString(),history:[]});
const image=new Blob(['fixture-pixels'],{type:'image/png'});
test('save and retry has one stable record, with readable context and project',async()=>{
  const root=new Dir();const saved=await saveReference(root,ref(),image,{createOnly:true});
  const retry=await saveReference(root,{...ref(),note:'Must not overwrite a saved record'},image,{createOnly:true});
  assert.equal(retry.revision,saved.revision);const disk=await readLibrary(root);assert.equal(disk.references.length,1);assert.equal(disk.references[0].note,ref().note);assert.deepEqual(disk.references[0].projects,['Client A']);assert.equal(await disk.references[0].blob.text(),'fixture-pixels');
  const versions=root.dirs.get(LIBRARY_DIR).dirs.get('references').dirs.get(ref().id).dirs.get('revisions');
  assert.match(await versions.files.get(saved.revision+'.md').text(),/avoid the buttons/);
});
test('failed initial write stays invisible and retry repairs it without a second item',async()=>{
  const root=new Dir();root.fail=(_,name)=>name.endsWith('.md')&&name!=='START-HERE.md';
  await assert.rejects(saveReference(root,ref(),image),/Disk write failed/);
  assert.equal((await readLibrary(root)).references.length,0);root.fail=null;
  await saveReference(root,ref(),image,{createOnly:true});assert.equal((await readLibrary(root)).references.length,1);
});
test('failed edit preserves the old committed note; stale edits cannot overwrite newer ones',async()=>{
  const root=new Dir(),first=await saveReference(root,ref(),image);
  root.fail=(_,name)=>name==='current.json';
  await assert.rejects(saveReference(root,{...ref(),note:'Changed'},null,{expectedRevision:first.revision}),/Disk write failed/);
  assert.equal((await readLibrary(root)).references[0].note,ref().note);root.fail=null;
  const second=await saveReference(root,{...ref(),note:'Changed'},null,{expectedRevision:first.revision});
  await assert.rejects(saveReference(root,ref(),null,{expectedRevision:first.revision}),/changed elsewhere/);
  assert.equal((await readLibrary(root)).references[0].revision,second.revision);
});
test('committed malformed paths are isolated and cannot traverse outside the library',async()=>{
  const root=new Dir(),saved=await saveReference(root,ref(),image),dir=root.dirs.get(LIBRARY_DIR).dirs.get('references').dirs.get(ref().id);
  dir.dirs.get('revisions').files.set(saved.revision+'.json',new Blob([JSON.stringify({...saved,media:'../../secret'})]));
  const disk=await readLibrary(root);assert.equal(disk.references.length,0);assert.equal(disk.issues.length,1);
  await assert.rejects(saveReference(root,ref('../escape'),image),/Invalid/);
  for(const url of ['file:///tmp/x','javascript:alert(1)','https://user:pass@example.test/'])assert.throws(()=>sourceURL(url));
});
test('guidance persists draft, confirmed, and retired revisions with scope',async()=>{
  const root=new Dir(),rule={id:'guidance-test',title:'Space',text:'Use room around headings.',scope:'Client A',references:[ref().id],status:'draft',history:[]};
  const first=await saveGuidance(root,rule);assert.equal((await readLibrary(root)).guidance[0].status,'draft');
  const second=await saveGuidance(root,{...rule,status:'confirmed'},first.revision);
  await assert.rejects(saveGuidance(root,rule,first.revision),/changed elsewhere/);
  await saveGuidance(root,{...rule,status:'retired'},second.revision);assert.equal((await readLibrary(root)).guidance[0].status,'retired');
});

test('custom categories survive folder writes and edits with their readable notes',async()=>{
  const root=new Dir();const saved=await saveReference(root,{...ref(),category:'Packaging & print'},image);
  assert.equal((await readLibrary(root)).references[0].category,'Packaging & print');
  const updated=await saveReference(root,{...saved,note:'Borrow the label hierarchy.'},null,{expectedRevision:saved.revision});
  const versions=root.dirs.get(LIBRARY_DIR).dirs.get('references').dirs.get(ref().id).dirs.get('revisions');
  assert.match(await versions.files.get(updated.revision+'.md').text(),/Category: Packaging & print/);
});

test('category scope prefixes fit a full-length category name',async()=>{
  const root=new Dir(),scope='Category: '+'x'.repeat(200);
  await saveGuidance(root,{id:'long-category',title:'Scoped taste',text:'Only in this category.',scope,references:[],status:'confirmed',history:[]});
  assert.equal((await readLibrary(root)).guidance[0].scope,scope);
});
