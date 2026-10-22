import {t,dateLocale} from './i18n.js';
import {setActionIcon} from './role-icons.js';
import {canOpenSide,openSide} from './side-preview.js';

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
/**
 * Metadata reads share a small queue so long chats never crowd out state and message requests. A described file is
 * reused for 10 minutes (its link names one file version and stays valid for days, so the browser's copy is reused);
 * an unavailable answer only for 30 seconds, so a device coming back online shows up quickly.
 */
const DESCRIBED_MS=10*60000,UNAVAILABLE_MS=30000;
function describeQueued(context,path,{fresh=false}={}) {
  const key=`${context.key}\n${path}`,cached=cache.get(key);
  if(!fresh&&cached&&Date.now()-cached.at<(cached.available===false?UNAVAILABLE_MS:DESCRIBED_MS))return cached.promise;
  const entry={at:Date.now(),available:null};
  entry.promise=new Promise((resolve,reject)=>{
    queue.push({run:()=>context.describe(path),resolve,reject});
    const drain=()=>{while(active<2&&queue.length){const next=queue.shift();active++;Promise.resolve().then(next.run).then(next.resolve,next.reject).finally(()=>{active--;drain();});}};drain();
  }).then(info=>{entry.available=Boolean(info?.available);return info;}).catch(error=>{cache.delete(key);throw error;});
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
  // Cards in a message show a preview (image thumbnail, video first frame) once the file is described.
  const card=path=>{const item=mediaCard(path,context,{describe:described++<12,preview:true});return item;};
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

export function mediaCard(path,context,{describe=true,preview=false}={}) {
  const kind=mediaKindFromName(path),card=el('button','media-card');card.type='button';card.dataset.kind=kind;card.title=path;card.setAttribute('translate','no');
  const icon=el('span','media-card-icon',ICON[kind]),text=el('span','media-card-text'),name=el('span','media-card-name',baseName(path)),meta=el('span','media-card-meta',t(kind==='file'?'Click to download or send':'Click to open'));
  text.append(name,meta);card.append(icon,text);
  const show=info=>{
    if(!info.available){card.dataset.state=info.reason;meta.textContent=t(REASONS[info.reason]||'Unavailable');return;}
    card.dataset.state=info.copyOf?'copy':'ready';card.dataset.kind=info.kind;icon.textContent=ICON[info.kind]||ICON.file;
    meta.textContent=[formatBytes(info.size),info.copyOf?t('Local copy'):''].filter(Boolean).join(' · ');
    if(preview&&info.url&&(info.kind==='image'||info.kind==='video'))attachPreview(card,info,()=>describeQueued(context,path,{fresh:true}));
  };
  if(describe)void describeQueued(context,path).then(show).catch(()=>{});
  card.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();void openMediaViewer(path,context,{at:messageTime(card)}).then(show).catch(()=>{});});
  return card;
}

/**
 * Thumbnail above the card's name: the image itself, or a video's first frame (metadata preload + a #t fragment, muted, no autoplay).
 * It streams through the same ticket URL as the viewer and only once the card is near the viewport; a failure falls back to the icon.
 */
function attachPreview(card,info,renew=null) {
  if(card.querySelector('.media-card-preview'))return;
  const box=el('span','media-card-preview');box.dataset.kind=info.kind;box.setAttribute('aria-hidden','true');
  const drop=()=>{box.remove();card.classList.remove('has-preview');};
  // The file may have changed since it was described (its old link then fails): describe it again once, then give up.
  const retry=(node,suffix='')=>{let tried=false;node.addEventListener('error',()=>{if(tried||!renew){drop();return;}tried=true;
    void renew().then(fresh=>{if(fresh?.available&&fresh.url&&fresh.url!==info.url){info.url=fresh.url;node.src=`${fresh.url}${suffix}`;}else drop();}).catch(drop);});};
  const load=()=>{
    if(info.kind==='image'){const image=el('img');image.alt='';image.decoding='async';retry(image);image.src=info.url;box.append(image);return;}
    const video=document.createElement('video');video.muted=true;video.playsInline=true;video.preload='metadata';video.setAttribute('playsinline','');video.disablePictureInPicture=true;
    retry(video,'#t=0.1');video.src=`${info.url}#t=0.1`;box.append(video,el('span','media-card-play','\u25B6'));
  };
  card.classList.add('has-preview');card.prepend(box);
  if('IntersectionObserver' in window){const watch=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){watch.disconnect();load();}},{rootMargin:'240px'});watch.observe(card);}
  else load();
}

/** The time of the message a card sits in: a Sessions row carries data-at, a group-chat row its <time datetime>. */
function messageTime(node){return node.closest('[data-at]')?.dataset.at||node.closest('.chat-row')?.querySelector('time[datetime]')?.getAttribute('datetime')||null;}
const stamp=value=>{const date=new Date(value||'');return Number.isNaN(date.getTime())?'':date.toLocaleString(dateLocale(),{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});};
/** Copy puts the picture itself on the clipboard (as PNG); anything else, or a browser without image clipboard, copies the text. */
async function toPng(blob){if(blob.type==='image/png')return blob;const bitmap=await createImageBitmap(blob),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);return new Promise((resolve,reject)=>canvas.toBlob(png=>png?resolve(png):reject(Error('PNG')),'image/png'));}
export function copyAction(button,{url,kind,text}){
  button.hidden=false;
  const done=()=>{setActionIcon(button,'check',t('Copied'));setTimeout(()=>setActionIcon(button,'copy',t('Copy')),1500);};
  button.onclick=async()=>{
    try{if(kind==='image'&&url&&window.ClipboardItem&&navigator.clipboard?.write){await navigator.clipboard.write([new ClipboardItem({'image/png':fetch(url).then(r=>r.blob()).then(toPng)})]);done();return;}}catch{}
    try{await navigator.clipboard.writeText(text);done();}catch{}
  };
}

let viewer=null,viewerVersion=0;
/**
 * One viewer for every image and video in the chats (media named in replies and attachments people send): download, copy and
 * close at the top right; the picture on a plain stage; its name and size bottom left, the message time bottom right.
 */
function lightbox({name,size=null,at=null}){
  const version=++viewerVersion;
  if(!viewer){viewer=el('dialog','media-viewer media-lightbox');viewer.addEventListener('close',()=>{viewerVersion++;viewer.querySelectorAll('video,audio').forEach(media=>{media.pause();media.removeAttribute('src');media.load();});});document.body.append(viewer);}
  const actions=el('div','media-lightbox-actions'),download=setActionIcon(el('a','chat-icon-btn media-download'),'follow',t('Download'));download.hidden=true;download.setAttribute('download','');
  // Open on the right (Sessions page, desktop): pins this file beside the chat and closes the viewer.
  const side=setActionIcon(el('button','chat-icon-btn media-side'),'sideOpen',t('Open on the right'));side.type='button';side.hidden=true;
  const copy=setActionIcon(el('button','chat-icon-btn media-copy'),'copy',t('Copy'));copy.type='button';copy.hidden=true;
  const close=setActionIcon(el('button','chat-icon-btn'),'close',t('Close'));close.type='button';close.addEventListener('click',()=>viewer.close());close.autofocus=true;
  actions.append(download,side,copy,close);
  const stage=el('div','media-stage'),overlay=el('div','media-loading',t('Loading…')),status=el('p','workspace-note media-status');status.setAttribute('role','status');status.hidden=true;stage.append(overlay);
  const foot=el('div','media-lightbox-foot'),label=el('div','media-lightbox-label'),title=el('strong','media-lightbox-name',name),bytes=el('span','media-lightbox-size',size==null?'':formatBytes(size)),when=el('time','media-lightbox-time');
  const setTime=value=>{when.textContent=stamp(value);if(when.textContent)when.dateTime=value;};setTime(at);
  label.append(title,bytes);foot.append(label,when);
  viewer.setAttribute('aria-label',name);viewer.replaceChildren(actions,stage,status,foot);
  if(!viewer.open)viewer.showModal();
  return {version,download,side,copy,stage,overlay,status,title,bytes,when,setTime};
}
/** Show "Open on the right" once the file is ready, when the Sessions page can take it. */
function offerSide(v,item){if(v.version!==viewerVersion||!canOpenSide())return;v.side.hidden=false;v.side.onclick=()=>{viewer.close();openSide(item);};}

/** A picture people sent (an attachment): the same viewer as media in replies. `url` may be a promise of an object URL. */
export function openImageLightbox({name,size=null,at=null,url}){
  const v=lightbox({name,size,at});
  void Promise.resolve(url).then(src=>{
    if(v.version!==viewerVersion)return;
    const image=el('img','media-image');image.alt=name;image.decoding='async';
    image.addEventListener('load',()=>{v.overlay.hidden=true;});image.addEventListener('error',()=>{v.overlay.hidden=true;v.status.hidden=false;v.status.textContent=t('Unable to open: {message}',{message:name});});
    image.src=src;v.stage.prepend(image);v.download.href=src;v.download.setAttribute('download',name);v.download.hidden=false;copyAction(v.copy,{url:src,kind:'image',text:name});
    offerSide(v,{kind:'image',title:name,size,at,src});
  }).catch(error=>{if(v.version!==viewerVersion)return;v.overlay.hidden=true;v.status.hidden=false;v.status.textContent=t('Unable to open: {message}',{message:error.message});});
}

/** A text attachment (pasted text, Markdown, plain text) in the same viewer: the text as written, download, copy the text, close. */
export function openTextLightbox({name,size=null,at=null,url}){
  const v=lightbox({name,size,at});v.stage.classList.add('is-text');
  void Promise.resolve(url).then(async src=>{
    const response=await fetch(src);if(!response.ok)throw Error(`HTTP ${response.status}`);
    const text=await response.text();if(v.version!==viewerVersion)return;
    v.overlay.hidden=true;const body=el('pre','media-text',text);body.translate=false;v.stage.prepend(body);
    v.download.href=src;v.download.setAttribute('download',name);v.download.hidden=false;copyAction(v.copy,{text});
    offerSide(v,{kind:'text',title:name,size,at,text});
  }).catch(error=>{if(v.version!==viewerVersion)return;v.overlay.hidden=true;v.status.hidden=false;v.status.textContent=t('Unable to open: {message}',{message:error.message});});
}

/** The viewer streams through the ticket URL: playback starts with the first ranges, seeking fetches only what is needed. */
export async function openMediaViewer(path,context,{at=null}={}) {
  const v=lightbox({name:baseName(path),at}),{version,download,stage,overlay,status,title,bytes}=v;
  let info;
  // The card's description is reused: its link is the one the thumbnail loaded, so the browser already has the bytes.
  try{info=await describeQueued(context,path);}
  catch(error){if(version===viewerVersion){overlay.hidden=true;status.hidden=false;status.textContent=t('Unable to open: {message}',{message:error.message});}throw error;}
  if(version!==viewerVersion)return info;
  title.textContent=info.name||baseName(path);
  if(!info.available){overlay.hidden=true;status.hidden=false;status.textContent=t(REASONS[info.reason]||'Unavailable');stage.append(el('p','media-unavailable',info.reason==='source_offline'?t('The device that holds this file is offline, and there is no complete local copy to play.'):t(REASONS[info.reason]||'Unavailable')));return info;}
  bytes.textContent=formatBytes(info.size);if(!at)v.setTime(info.modifiedAt);
  download.href=info.downloadUrl;download.hidden=false;download.title=t('Download to this computer · {size}',{size:formatBytes(info.size)});
  copyAction(v.copy,{url:info.url,kind:info.kind,text:info.copyOf?info.name:path});
  if(info.kind!=='file')offerSide(v,{kind:info.kind,title:info.name||baseName(path),subtitle:path,size:info.size,at:at||info.modifiedAt||null,src:info.url,download:info.downloadUrl,renew:()=>describeQueued(context,path,{fresh:true}).then(fresh=>fresh.available?fresh.url:null)});
  const summary=[info.copyOf?t('Playing the local copy on {device}; the source device is offline.',{device:info.sourceName}):t('From {device}',{device:info.sourceName}),formatBytes(info.size)].join(' · ');
  renderStage(stage,overlay,status,info,summary,path,context,version);
  return info;
}

function renderStage(stage,overlay,status,info,summary,path,context,version) {
  const fail=async media=>{
    overlay.hidden=true;
    // Ask the relay what went wrong: an expired ticket is renewed once; otherwise report the actual reason.
    let reason='format';
    try{const response=await fetch(info.url,{headers:{Range:'bytes=0-0'}});reason=response.ok?'format':((await response.json().catch(()=>({}))).code||`HTTP ${response.status}`);}catch{reason='network';}
    if(version!==viewerVersion)return;
    if(['media_ticket_invalid','file_changed'].includes(reason)&&!media.dataset.renewed){
      const fresh=await describeQueued(context,path,{fresh:true}).catch(()=>null);
      if(fresh?.available){media.dataset.renewed='1';info.url=fresh.url;media.src=fresh.url;overlay.hidden=false;return;}
    }
    status.hidden=false;status.textContent=t({format:'This browser cannot play this format. Download it to open locally.',file_changed:'The file changed since this message; reopen it to see the current version.',source_offline:'Source device offline',media_busy:'The source device is busy; try again shortly.',worker_upgrade:'Device needs a Worker upgrade',network:'Network error while loading.'}[reason]||'Unable to load: {reason}',{reason});
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
