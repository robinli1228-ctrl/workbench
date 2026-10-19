import {t} from './i18n.js';
import {setActionIcon} from './role-icons.js';

/**
 * One media card and one in-page viewer for group chat and native sessions. A file stays on the device that produced
 * it: the card only asks Home for metadata, and the viewer streams the byte ranges the browser needs through a short
 * signed ticket, so a file of any size can be watched while it is still arriving. Downloads stream to disk on demand.
 */
const EXT='mp4|m4v|mov|webm|mkv|ogv|mp3|m4a|aac|wav|ogg|oga|opus|flac|png|jpe?g|gif|webp|pdf|zip|tar|tgz|gz|7z';
const STOP='\\s`<>"\'，。；：！？、()\\[\\]';
const PATTERN=new RegExp(`(?:\\/|\\.\\.?\\/)?(?:[^${STOP}\\/]+\\/)*[^${STOP}\\/]+\\.(?:${EXT})(?=$|[\\s，。；：！？、()\\[\\]])`,'gi');
const EXACT=new RegExp(`^[^${STOP}]+\\.(?:${EXT})$`,'i');
const ICON={video:'▶',audio:'♪',image:'▣',pdf:'PDF',file:'⬇'};
const REASONS={source_offline:'Source device offline',worker_upgrade:'Device needs a Worker upgrade',media_missing:'File not found',media_not_file:'Not a file',invalid_media_path:'Path is outside the allowed folders'};

export function mediaKindFromName(name) {
  const ext=String(name).split('.').at(-1).toLowerCase();
  if(/^(?:mp4|m4v|mov|webm|mkv|ogv)$/.test(ext))return 'video';
  if(/^(?:mp3|m4a|aac|wav|ogg|oga|opus|flac)$/.test(ext))return 'audio';
  if(/^(?:png|jpe?g|gif|webp)$/.test(ext))return 'image';
  return ext==='pdf'?'pdf':'file';
}
export function formatBytes(bytes) {
  if(!Number.isFinite(bytes))return '';
  const units=['B','KB','MB','GB','TB'];let value=bytes,unit=0;
  while(value>=1024&&unit<units.length-1){value/=1024;unit++;}
  return `${value>=10||unit===0?Math.round(value):value.toFixed(1)} ${units[unit]}`;
}
const el=(tag,className='',text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
const baseName=path=>String(path).split(/[\\/]/).at(-1)||path;

const cache=new Map(),queue=[];let active=0;
/** Metadata reads share a small queue so long chats never crowd out state and message requests. */
function describeQueued(context,path,{fresh=false}={}) {
  const key=`${context.key}\n${path}`,cached=cache.get(key);
  if(!fresh&&cached&&Date.now()-cached.at<60000)return cached.promise;
  const entry={at:Date.now()};
  entry.promise=new Promise((resolve,reject)=>{
    queue.push({run:()=>context.describe(path),resolve,reject});
    const drain=()=>{while(active<2&&queue.length){const next=queue.shift();active++;Promise.resolve().then(next.run).then(next.resolve,next.reject).finally(()=>{active--;drain();});}};drain();
  }).catch(error=>{cache.delete(key);throw error;});
  cache.set(key,entry);return entry.promise;
}

/** Paths in prose that name media or large binary files; URLs and parts of longer tokens are skipped. */
export function mediaPathMatches(text) {
  const value=String(text||''),found=[];
  for(const match of value.matchAll(PATTERN)){if(match.index>0&&/[\w:/.]/.test(value[match.index-1]))continue;found.push({index:match.index,path:match[0]});}
  return found;
}

/** Replace file paths that name media or large binary files with cards; code blocks, links and buttons are left alone. */
export function linkMedia(root,context) {
  if(!root||!context?.describe)return root;
  root.normalize();
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),nodes=[];let node;
  while((node=walker.nextNode()))if(!node.parentElement.closest('a,pre,button,.media-card'))nodes.push(node);
  let described=0;
  const card=path=>{const item=mediaCard(path,context,{describe:described++<12});return item;};
  for(const text of nodes){
    const value=text.textContent,exact=text.parentElement.tagName==='CODE'&&EXACT.test(value.trim());
    const matches=exact?[{index:value.indexOf(value.trim()),path:value.trim()}]:mediaPathMatches(value);if(!matches.length)continue;
    const fragment=document.createDocumentFragment();let cursor=0;
    for(const match of matches){fragment.append(document.createTextNode(value.slice(cursor,match.index)),card(match.path));cursor=match.index+match.path.length;}
    if(!cursor)continue;
    fragment.append(document.createTextNode(value.slice(cursor)));
    (exact?text.parentElement:text).replaceWith(fragment);
  }
  for(const link of [...root.querySelectorAll('a[href]')]){
    const href=link.getAttribute('href');
    if(!href||/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)||!EXACT.test(href))continue;
    link.replaceWith(card(href));
  }
  return root;
}

export function mediaCard(path,context,{describe=true}={}) {
  const kind=mediaKindFromName(path),card=el('button','media-card');card.type='button';card.dataset.kind=kind;card.title=path;card.setAttribute('translate','no');
  const icon=el('span','media-card-icon',ICON[kind]),text=el('span','media-card-text'),name=el('span','media-card-name',baseName(path)),meta=el('span','media-card-meta',t(kind==='file'?'Click to download or send':'Click to open'));
  text.append(name,meta);card.append(icon,text);
  const show=info=>{
    if(!info.available){card.dataset.state=info.reason;meta.textContent=t(REASONS[info.reason]||'Unavailable');return;}
    card.dataset.state=info.copyOf?'copy':'ready';card.dataset.kind=info.kind;icon.textContent=ICON[info.kind]||ICON.file;
    meta.textContent=[formatBytes(info.size),info.copyOf?t('Local copy'):''].filter(Boolean).join(' · ');
  };
  if(describe)void describeQueued(context,path).then(show).catch(()=>{});
  card.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();void openMediaViewer(path,context).then(show).catch(()=>{});});
  return card;
}

let viewer=null,viewerVersion=0;
/** The viewer streams through the ticket URL: playback starts with the first ranges, seeking fetches only what is needed. */
export async function openMediaViewer(path,context) {
  const version=++viewerVersion;
  if(!viewer){viewer=el('dialog','message-fullscreen media-viewer');viewer.addEventListener('close',()=>{viewerVersion++;viewer.querySelectorAll('video,audio').forEach(media=>{media.pause();media.removeAttribute('src');media.load();});});document.body.append(viewer);}
  const heading=el('div','message-fullscreen-heading'),title=el('strong','',baseName(path)),download=setActionIcon(el('a','chat-icon-btn media-download'),'follow',t('Download'));
  download.hidden=true;download.setAttribute('download','');
  const close=setActionIcon(el('button','chat-icon-btn'),'close',t('Close'));close.type='button';close.addEventListener('click',()=>viewer.close());close.autofocus=true;
  heading.append(title,download,close);
  const body=el('div','media-viewer-body'),stage=el('div','media-stage'),overlay=el('div','media-loading',t('Loading…')),status=el('p','workspace-note media-status',t('Reading file information…'));
  status.setAttribute('role','status');stage.append(overlay);body.append(stage,status);
  viewer.setAttribute('aria-label',baseName(path));viewer.replaceChildren(heading,body);
  if(!viewer.open)viewer.showModal();
  let info;
  try{info=await describeQueued(context,path,{fresh:true});}
  catch(error){if(version===viewerVersion){overlay.hidden=true;status.textContent=t('Unable to open: {message}',{message:error.message});}throw error;}
  if(version!==viewerVersion)return info;
  title.textContent=info.name||baseName(path);
  if(!info.available){overlay.hidden=true;status.textContent=t(REASONS[info.reason]||'Unavailable');stage.append(el('p','media-unavailable',info.reason==='source_offline'?t('The device that holds this file is offline, and there is no complete local copy to play.'):t(REASONS[info.reason]||'Unavailable')));return info;}
  download.href=info.downloadUrl;download.hidden=false;download.title=t('Download to this computer · {size}',{size:formatBytes(info.size)});
  const source=info.copyOf?t('Playing the local copy on {device}; the source device is offline.',{device:info.sourceName}):t('From {device}',{device:info.sourceName});
  const summary=[source,formatBytes(info.size)].join(' · ');status.textContent=summary;
  renderStage(stage,overlay,status,info,summary,path,context,version);
  if(context.transfers)body.append(transferPanel(info,context));
  return info;
}

function renderStage(stage,overlay,status,info,summary,path,context,version) {
  const fail=async media=>{
    overlay.hidden=true;
    // Ask the relay what went wrong: an expired ticket is renewed once; otherwise report the actual reason.
    let reason='format';
    try{const response=await fetch(info.url,{headers:{Range:'bytes=0-0'}});reason=response.ok?'format':((await response.json().catch(()=>({}))).code||`HTTP ${response.status}`);}catch{reason='network';}
    if(version!==viewerVersion)return;
    if(reason==='media_ticket_invalid'&&!media.dataset.renewed){
      const fresh=await describeQueued(context,path,{fresh:true}).catch(()=>null);
      if(fresh?.available){media.dataset.renewed='1';info.url=fresh.url;media.src=fresh.url;overlay.hidden=false;return;}
    }
    status.textContent=t({format:'This browser cannot play this format. Download it to open locally.',file_changed:'The file changed since this message; reopen it to see the current version.',source_offline:'Source device offline',media_busy:'The source device is busy; try again shortly.',worker_upgrade:'Device needs a Worker upgrade',network:'Network error while loading.'}[reason]||'Unable to load: {reason}',{reason});
  };
  if(info.kind==='video'||info.kind==='audio'){
    const media=el(info.kind);media.controls=true;media.preload='metadata';media.setAttribute('playsinline','');
    const buffered=()=>{if(!media.duration||!media.buffered.length)return;let end=0;for(let i=0;i<media.buffered.length;i++)end=Math.max(end,media.buffered.end(i));status.textContent=`${summary} · ${t('Buffered {percent}%',{percent:Math.min(100,Math.round(end/media.duration*100))})}`;};
    media.addEventListener('loadstart',()=>{overlay.textContent=t('Loading… streaming from the source device');overlay.hidden=false;});
    media.addEventListener('waiting',()=>{overlay.textContent=t('Buffering…');overlay.hidden=false;});
    for(const ready of ['canplay','playing','seeked'])media.addEventListener(ready,()=>{overlay.hidden=true;});
    media.addEventListener('progress',buffered);media.addEventListener('loadedmetadata',buffered);
    media.addEventListener('error',()=>void fail(media));
    media.src=info.url;stage.prepend(media);return;
  }
  if(info.kind==='image'){
    const image=el('img','media-image');image.alt=info.name;image.decoding='async';
    image.addEventListener('load',()=>{overlay.hidden=true;});image.addEventListener('error',()=>void fail(image));
    image.src=info.url;stage.prepend(image);return;
  }
  if(info.kind==='pdf'){
    const frame=el('iframe','media-pdf');frame.title=info.name;frame.addEventListener('load',()=>{overlay.hidden=true;});frame.src=info.url;stage.prepend(frame);return;
  }
  overlay.hidden=true;
  stage.append(el('p','media-unavailable',t('This file type cannot be previewed in the page. Download streams it to this computer as it arrives ({size}).',{size:formatBytes(info.size)})));
}

/** Send a copy to another device of the project; the target verifies size and SHA-256 before the file appears. */
function transferPanel(info,context) {
  const panel=el('div','media-transfer'),select=el('select'),action=el('button','primary-btn',t('Send to device')),note=el('p','workspace-note'),bar=el('progress','media-progress');
  select.setAttribute('aria-label',t('Target device'));action.type='button';bar.max=1;bar.value=0;bar.hidden=true;note.setAttribute('role','status');
  const targets=context.transfers.targets().filter(target=>target.nodeId!==info.sourceNodeId);
  for(const target of targets){const option=el('option','',`${target.name}${target.ready?'':` · ${t(target.online?'Upgrade required':'Offline')}`}`);option.value=target.nodeId;option.disabled=!target.ready;select.append(option);}
  select.value=targets.find(target=>target.ready)?.nodeId||'';
  // Polling must replace the opening snapshot so another send gets a new ID after completion.
  const transfers=new Map((info.transfers||[]).map(transfer=>[transfer.nodeId,transfer]));
  const show=transfer=>{
    if(transfer){transfers.set(transfer.nodeId,transfer);if(transfer.nodeId!==select.value)return;}
    if(!transfer){note.textContent=select.value?t('Copies the file into the project folder on that device, under .workbench/tmp/media/.'):t('No other project device can receive files right now.');bar.hidden=true;action.disabled=!select.value;return;}
    const done=transfer.status==='completed';bar.hidden=done||transfer.status==='failed';bar.value=transfer.size?transfer.received/transfer.size:0;
    note.textContent=transfer.status==='hashing'?t('Checking the source file…'):transfer.status==='transferring'?t('Transferring {received} of {size}…',{received:formatBytes(transfer.received||0),size:formatBytes(transfer.size)})
      :done?t('Copied and verified: {path}',{path:transfer.path}):t('Transfer failed: {error}',{error:transfer.error||''});
    action.disabled=!select.value||['hashing','transferring'].includes(transfer.status);action.textContent=t(transfer.status==='failed'?'Retry transfer':done?'Send again':'Send to device');
  };
  const ids=new Map();let polling=null;
  const current=()=>transfers.get(select.value)||null;
  const poll=id=>{clearTimeout(polling);polling=setTimeout(async()=>{
    if(!panel.isConnected)return;
    try{const transfer=await context.transfers.read(id);show(transfer);if(['hashing','transferring'].includes(transfer.status))poll(id);}catch{poll(id);}
  },1500);};
  action.addEventListener('click',async()=>{
    const nodeId=select.value;if(!nodeId)return;
    const prior=current();let id=ids.get(nodeId)||(prior&&prior.status==='failed'?prior.id:null);
    if(!id||prior?.status==='completed'&&prior.id===id){id=crypto.randomUUID();}
    ids.set(nodeId,id);action.disabled=true;
    try{const transfer=await context.transfers.start({clientTransferId:id,ticket:info.ticket,nodeId});show(transfer);poll(id);}
    catch(error){note.textContent=t('Transfer failed: {error}',{error:error.message});action.disabled=false;}
  });
  select.addEventListener('change',()=>show(current()));
  panel.append(select,action,bar,note);show(current());
  const running=current();if(running&&['hashing','transferring'].includes(running.status))poll(running.id);
  return panel;
}
