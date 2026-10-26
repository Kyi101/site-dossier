import { addItem } from '../shared/collector-db.mjs';
import { sourceURL } from '../shared/library.mjs';
import { selectRectangle, dismissRectangle, viewport, sameViewport } from './rectangle.mjs';
import '../shared/capture-math.js';
const panelURL = chrome.runtime.getURL('sidepanel/sidepanel.html');
const rectangleKey = 'collectorRectangle';
const exclusive = task => navigator.locks.request('site-dossier-collector-capture',task);
function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id:'collect-image', title:'Collect image in Site Dossier', contexts:['image'] });
    chrome.contextMenus.create({ id:'collect-screen', title:'Collect screenshot in Site Dossier', contexts:['page'] });
  });
}
chrome.runtime.onInstalled.addListener(setupMenus);
chrome.runtime.onStartup.addListener(setupMenus);
async function activePage(tabId, windowId) {
  const [before]=await chrome.tabs.query({ active:true, windowId });
  if (!before || before.id!==tabId) throw new Error('Return to the page you want to capture and try again.');
  const source=sourceURL(before.url);
  if (!source || before.pendingUrl) throw new Error('Open a regular website and wait for it to finish navigating before capturing.');
  return before;
}
async function checkViewport(tabId, documentId, expected) {
  const [result]=await chrome.scripting.executeScript({target:{tabId,documentIds:[documentId]},func:viewport});
  if(!sameViewport(expected,result?.result))throw new Error('The page moved or resized. Draw the rectangle again.');
}
async function screenshot(tabId, windowId, selection=null) {
  const before=await activePage(tabId,windowId), source=sourceURL(before.url);
  if(selection){
    if(before.url!==selection.url)throw new Error('The page changed. Draw the rectangle again.');
    await checkViewport(tabId,selection.documentId,selection.viewport);
  }
  const data=await chrome.tabs.captureVisibleTab(windowId,{format:'png'});
  const [after]=await chrome.tabs.query({active:true,windowId});
  if (!after || after.id!==before.id || after.url!==before.url || after.pendingUrl) throw new Error('The tab changed during capture. Try again.');
  let blob=await (await fetch(data)).blob(), crop;
  if(selection){
    await checkViewport(tabId,selection.documentId,selection.viewport);
    const bitmap=await createImageBitmap(blob);
    try {
      crop=globalThis.SiteDossierCapture.pixelBounds(selection.rect,selection.viewport,bitmap);
      const canvas=new OffscreenCanvas(crop.width,crop.height);
      canvas.getContext('2d').drawImage(bitmap,crop.x,crop.y,crop.width,crop.height,0,0,crop.width,crop.height);
      blob=await canvas.convertToBlob({type:'image/png'});
    } finally { bitmap.close(); }
  }
  return addItem({title:before.title||new URL(source).hostname, source, blob, kind:'screenshot',...(crop?{crop}: {})});
}
async function cancelRectangle() {
  const stored=(await chrome.storage.session.get(rectangleKey))[rectangleKey];
  if(!stored)return;
  await chrome.storage.session.remove(rectangleKey);
  await chrome.scripting.executeScript({target:{tabId:stored.tabId},func:dismissRectangle}).catch(()=>{});
}
async function startRectangle(tabId,windowId) {
  const page=await activePage(tabId,windowId);
  const capture=(await chrome.storage.session.get('capture')).capture;
  if(capture && capture.phase!=='interrupted')throw new Error('Finish the current page capture or selection first.');
  await cancelRectangle();
  const token=crypto.randomUUID();
  await chrome.storage.session.set({[rectangleKey]:{token,tabId,windowId,url:page.url}});
  try {
    const [result]=await chrome.scripting.executeScript({target:{tabId},func:selectRectangle,args:[token]});
    if(result?.error)throw new Error(result.error.message||'Could not open the rectangle tool.');
  } catch(err) {await cancelRectangle();throw err;}
  return {ok:true};
}
async function finishRectangle(message,sender) {
  const stored=(await chrome.storage.session.get(rectangleKey))[rectangleKey];
  if(!stored || sender.id!==chrome.runtime.id || sender.frameId!==0 || sender.tab?.id!==stored.tabId ||
    sender.url!==stored.url || message.token!==stored.token) return {ok:false};
  await chrome.storage.session.remove(rectangleKey);
  if(!message.rect){
    await chrome.storage.local.set({collectorStatus:message.reason||'Rectangle cancelled.'});
    return {ok:true};
  }
  try {
    const item=await screenshot(stored.tabId,stored.windowId,{...stored,rect:message.rect,viewport:message.viewport,documentId:sender.documentId});
    await chrome.storage.local.set({collectorStatus:'Rectangle added to your tray.'});
    return {ok:true,id:item.id};
  } catch(err) {
    await chrome.storage.local.set({collectorError:err.message});throw err;
  }
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message.type==='COLLECT_RECTANGLE_DONE'){
    exclusive(()=>finishRectangle(message,sender)).then(respond).catch(err=>respond({ok:false,error:err.message}));return true;
  }
  if (!['COLLECT_SCREENSHOT','COLLECT_RECTANGLE'].includes(message.type)) return false;
  if (sender.id!==chrome.runtime.id || sender.url!==panelURL) { respond({ok:false,error:'Open the collection panel to capture.'}); return false; }
  exclusive(async()=>{
    if(message.type==='COLLECT_RECTANGLE')return startRectangle(message.tabId,message.windowId);
    await cancelRectangle();const item=await screenshot(message.tabId,message.windowId);return {ok:true,id:item.id};
  }).then(respond).catch(err=>respond({ok:false,error:err.message}));
  return true;
});
chrome.contextMenus.onClicked.addListener((info,tab)=>{
  if (!['collect-image','collect-screen'].includes(info.menuItemId) || !tab?.id) return;
  // Open directly in the user gesture; async writes may outlast its activation.
  chrome.sidePanel.open({windowId:tab.windowId}).catch(()=>{});
  (async()=>{
    if (info.menuItemId==='collect-image') await addItem({source:sourceURL(info.pageUrl), imageSource:sourceURL(info.srcUrl), title:'Image reference', kind:'image'});
    else await exclusive(async()=>{await cancelRectangle();await screenshot(tab.id,tab.windowId);});
  })().catch(async err=>{ await chrome.storage.local.set({collectorError:err.message}); });
});
