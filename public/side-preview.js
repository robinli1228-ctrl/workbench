import {copyText} from './role-icons.js';
import {t,dateLocale} from './i18n.js';
import {renderMarkdown,normalizeDocumentAddress} from './markdown.js';
import {simplifiedCliOutput} from './output-language.js';
import {setActionIcon} from './role-icons.js';
import {resolveToolFile} from './native-transcript.js';

/**
 * The shared right-side Preview tab: one message, picture, video, PDF, text or file view pinned beside the chat
 * for side-by-side reading. It stays while another session is opened, so replies from two sessions can be compared.
 * Entries call openSide() from the media viewer, the file sheet, the output details and the message tools; the page
 * registers the panel while it is shown. Desktop only: phones have no room beside the chat.
 */
const MOBILE='(max-width: 1000px)';
const openers=new Map();
const activeOpener=()=>[...openers.values()].find(value=>value.available?.());
export function setSidePreviewOpener(value){openers.set(value.key||'default',value);}
export const canOpenSide=()=>Boolean(activeOpener())&&!matchMedia(MOBILE).matches;
export function openSide(item){if(!item||!canOpenSide())return false;activeOpener().open(item);return true;}

const el=(tag,className='',text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};

/** An icon button that opens `item` (or what `item()` returns) on the right; hidden where the side preview is unavailable. */
export function sideButton(className,label,item,{before=null}={}){
  // Phone widths hide these in the stylesheet, so a window resized later still gets working buttons.
  const b=el('button',className);b.type='button';setActionIcon(b,'sideOpen',label);b.hidden=!activeOpener();
  b.addEventListener('click',event=>{event.stopPropagation();before?.();openSide(typeof item==='function'?item():item);});
  return b;
}

/**
 * The panel. An item is { title, subtitle?, size?, at?, copyText?, download?, downloadName? } plus one body:
 * render() for a ready node (a message, a diff, file text), or kind image|video|audio|pdf with src (a URL or a
 * promise of one; renew() gives a fresh URL once when a signed link has expired), or kind text with text.
 * Object URLs are copied into the panel's own, so a session releasing its attachments does not blank the preview.
 */
export function createSidePreview({t,formatSize=()=>'',stamp=()=>'',copyAction=null,emptyText}){
  const root=el('div','side-preview'),head=el('div','side-preview-head'),titles=el('div','side-preview-titles'),title=el('strong','side-preview-title'),sub=el('div','side-preview-sub'),actions=el('div','side-preview-actions'),body=el('div','side-preview-body');
  title.translate=false;titles.append(title,sub);head.append(titles,actions);root.append(head,body);
  const empty=el('div','side-preview-empty');empty.append(el('span','side-preview-empty-icon'),el('p','',emptyText));setActionIcon(empty.firstChild,'sideOpen','');empty.firstChild.removeAttribute('title');
  let owned=null,version=0,current=null;
  const release=()=>{for(const media of body.querySelectorAll('video,audio')){media.pause();media.removeAttribute('src');media.load();}if(owned){URL.revokeObjectURL(owned);owned=null;}};
  const iconButton=(icon,label,onClick)=>{const b=el('button','chat-icon-btn');b.type='button';setActionIcon(b,icon,label);b.addEventListener('click',onClick);return b;};
  function clear(){version++;release();current=null;head.hidden=true;body.replaceChildren(empty);}
  const note=text=>body.replaceChildren(el('p','workspace-note side-preview-note',text));
  async function own(src){
    // A page-owned object URL may be revoked when its session closes; copy it into one this panel controls.
    if(!String(src).startsWith('blob:'))return src;
    const blob=await (await fetch(src)).blob();const url=URL.createObjectURL(blob);owned=url;return url;
  }
  function media(kind,src,item,ticket){
    const node=kind==='image'?el('img','side-preview-image'):kind==='pdf'?el('iframe','side-preview-pdf'):el(kind,'side-preview-media');
    if(kind==='image'){node.alt=item.title||'';node.decoding='async';}
    else if(kind==='pdf')node.title=item.title||'';
    else{node.controls=true;node.preload='metadata';node.setAttribute('playsinline','');}
    let renewed=false;
    node.addEventListener('error',async()=>{
      if(ticket!==version)return;
      if(item.renew&&!renewed){renewed=true;try{const fresh=await item.renew();if(ticket===version&&fresh){node.src=fresh;return;}}catch{}}
      if(ticket===version)body.append(el('p','workspace-note side-preview-note',t('Unable to open: {message}',{message:item.title||''})));
    });
    node.src=src;return node;
  }
  async function open(item){
    const ticket=++version;release();current=item;head.hidden=false;
    title.textContent=item.title||'';title.title=item.title||'';
    sub.textContent=[item.subtitle,item.size!=null?formatSize(item.size):'',item.at?stamp(item.at):''].filter(Boolean).join(' · ');sub.title=item.subtitle||'';
    actions.replaceChildren();body.replaceChildren(el('p','workspace-note side-preview-note',t('Loading…')));
    const download=setActionIcon(el('a','chat-icon-btn side-preview-download'),'follow',t('Download'));download.hidden=true;download.setAttribute('download',item.downloadName||item.title||'');
    const copy=iconButton('copy',t('Copy'),()=>{});copy.hidden=true;
    actions.append(download,copy,iconButton('close',t('Close preview'),clear));
    const setCopy=options=>{if(copyAction)copyAction(copy,options);else{copy.hidden=false;copy.onclick=()=>void copyText(copy,options.text||'').catch(()=>{});}};
    try{
      let node;
      if(item.render){node=item.render();if(item.copyText!=null)setCopy({text:item.copyText});}
      else if(item.kind==='text'){node=el('pre','side-preview-text',item.text??'');node.translate=false;setCopy({text:item.text??''});if(!item.download){owned=URL.createObjectURL(new Blob([item.text??''],{type:'text/plain;charset=utf-8'}));download.href=owned;download.hidden=false;}}
      else{
        const src=await own(await Promise.resolve(item.src));if(ticket!==version)return;
        node=media(item.kind,src,item,ticket);
        if(item.kind==='image')setCopy({url:src,kind:'image',text:item.title||''});
        if(!item.download){download.href=src;download.hidden=false;}
      }
      if(ticket!==version)return;
      if(item.download){download.href=item.download;download.hidden=false;}
      body.replaceChildren(node);body.scrollTop=0;
    }catch(error){if(ticket===version)note(t('Unable to open: {message}',{message:error.message}));}
  }
  clear();
  return {root,open,clear,current:()=>current};
}


const nameOf=path=>path.split(/[\\/]/).at(-1)||path;
const privatePath=path=>/(?:^|\/)\.workbench\/(?!docs(?:\/|$))/.test(path);
/** A document's own relative links use its directory; initial chat references retain the existing API's workspace rules. */
function relativeTo(path,base){
  if(!base||path.startsWith('/'))return path;
  const absolute=base.startsWith('/'),url=new URL(path,new URL(base,'https://document.invalid/'));
  return decodeURIComponent(absolute?url.pathname:url.pathname.slice(1));
}

/** Shared presentation and click-time reads; adapters preserve each chat's existing authorization identity. */
export function createDocumentPreview({api}){
  const cache=new Map(),pending=new Map(),states=new Map();let cacheBytes=0,dialog=null,version=0;
  function reference(path,source={}){
    path=normalizeDocumentAddress(path);if(!path)return null;path=relativeTo(path,source.basePath);
    const resolved=source.basePath?{path}:resolveToolFile(path,source.filePaths?.()||[]);path=resolved.path;
    const ref={...source,path};delete ref.basePath;
    ref.key=JSON.stringify([ref.kind,ref.runId,ref.projectId,ref.scopeId,ref.nodeId,ref.runtime,ref.sessionId,ref.entryId,ref.readMode,ref.sha256,ref.sourceCommit,ref.blockedReason,path]);
    ref.blocked=ref.blockedReason||(resolved.reason?t('Multiple files in this turn have this name.'):null)||(privatePath(path)?t('Private Workbench file; publish it under shared documents before linking.'):
      ref.kind==='run'&&ref.runId||ref.kind==='project'&&ref.projectId&&ref.scopeId||ref.kind==='native'&&ref.nodeId&&ref.runtime&&(ref.sessionId||ref.entryId)?null:t('Document source is unavailable.'));
    return ref;
  }
  function paint(link,ref){const failure=ref.blocked||states.get(ref.key);link.classList.toggle('is-unavailable',Boolean(failure));link.dataset.documentState=failure?'unavailable':'reference';link.title=ref.path+(failure?'\n'+failure:'');link.setAttribute('aria-label',nameOf(ref.path)+(failure?' · '+failure:''));}
  function failure(ref,error){states.delete(ref.key);if(error)states.set(ref.key,error);while(states.size>200)states.delete(states.keys().next().value);for(const link of document.querySelectorAll('[data-document-key]'))if(link.dataset.documentKey===ref.key)paint(link,ref);}
  function address(ref){
    if(ref.kind==='project')return `/api/projects/${encodeURIComponent(ref.projectId)}/local-file?${new URLSearchParams({scopeId:ref.scopeId,path:ref.path})}`;
    if(ref.kind==='native')return `/api/native-sessions/${encodeURIComponent(ref.nodeId)}/file?${new URLSearchParams({runtime:ref.runtime,sessionId:ref.sessionId||'',...(ref.entryId?{entryId:ref.entryId}:{}),path:ref.path})}`;
    return `/api/runs/${encodeURIComponent(ref.runId)}/document?${new URLSearchParams({path:ref.path,...(ref.readMode==='recorded'?{source:'recorded',sha256:ref.sha256,...(ref.sourceCommit?{commit:ref.sourceCommit}:{})}:{})})}`;
  }
  async function read(ref){
    if(ref.blocked)throw Error(ref.blocked);const old=cache.get(ref.key);
    if(old&&Date.now()-old.at<30000){cache.delete(ref.key);cache.set(ref.key,old);return old.result;}
    if(old){cache.delete(ref.key);cacheBytes-=old.bytes;}
    if(pending.has(ref.key))return pending.get(ref.key);
    const request=Promise.resolve().then(()=>api(address(ref))).then(result=>{
      if(typeof result.content!=='string')throw Error(t(result.preview==='too_large'?'File is larger than 600 KB; open it on the device.':result.preview==='binary'?'Binary file; no text preview.':result.syncState==='pending'?'Waiting for local synchronization':'Local file not found.'));
      const bytes=result.content.length*2;if(bytes<=2*1024*1024){cache.set(ref.key,{at:Date.now(),bytes,result});cacheBytes+=bytes;while(cache.size>32||cacheBytes>2*1024*1024){const key=cache.keys().next().value;cacheBytes-=cache.get(key).bytes;cache.delete(key);}}
      failure(ref,null);return result;
    }).catch(error=>{failure(ref,error.message);throw error;}).finally(()=>pending.delete(ref.key));pending.set(ref.key,request);return request;
  }
  function attach(link,path,source){
    const ref=reference(path,source);if(!ref)return;link.classList.add('document-reference');link.dataset.documentKey=ref.key;link.dataset.documentPath=ref.path;link.textContent=nameOf(ref.path);link.translate=false;
    link.setAttribute('href','#');link.removeAttribute('target');link.removeAttribute('rel');paint(link,ref);
    link.addEventListener('click',event=>{if(event.button!==0)return;event.preventDefault();event.stopPropagation();void (async()=>{
      try{if(!source?.basePath&&!/[\\/]/.test(path))await source?.loadFilePaths?.();const fresh=reference(path,source);if(!fresh)return;
        link.dataset.documentKey=fresh.key;link.dataset.documentPath=fresh.path;paint(link,fresh);await open(fresh.path,fresh);
      }catch{failure(ref,t('Could not load this turn\'s file locations.'));}
    })();});
  }
  function decorate(root,source){
    root.normalize();
    for(const link of root.querySelectorAll('a[href]')){
      if(link.dataset.documentKey)continue;let path=link.getAttribute('href');
      let identity=source;
      if(path.startsWith('/document.html?')){const q=new URL(path,location.href).searchParams;path=q.get('path')||'';identity=q.has('projectId')?{kind:'project',projectId:q.get('projectId'),scopeId:q.get('scopeId')}:{kind:'run',runId:q.get('runId'),readMode:q.get('source')==='recorded'?'recorded':undefined,sha256:q.get('sha256'),sourceCommit:q.get('commit')};}
      attach(link,path,identity);
    }
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),nodes=[];let node;
    while((node=walker.nextNode()))if(!node.parentElement.closest('a,pre,summary,.chat-reference-metadata'))nodes.push(node);
    const pattern=/(?:file:\/\/\/(?:[^\s`<>"',;!?，。；：！？、()[\]]+)|\/(?:Users|srv|workspace|home|opt|tmp|var|mnt|Volumes)\/[^`\n<>"',;!?，。；：！？、()[\]]+?|(?:\.\.?\/|\.workbench\/docs\/|docs\/|references\/)[^`\n<>"',;!?，。；：！？、()[\]]+?|[^\s`<>"',;!?，。；：！？、()[\]\\/]+)\.(?:md|markdown|txt)(?=$|[\s,.;:!?，。；：！？、()[\]<>])/gi;
    for(const text of nodes){
      const exact=text.parentElement.tagName==='CODE'&&normalizeDocumentAddress(text.textContent);
      // Every match ends in a document extension; text without one (a long base64 part) is skipped without scanning.
      const hits=exact?[{index:0,0:text.textContent}]:/\.(?:md|markdown|txt)/i.test(text.textContent)?[...text.textContent.matchAll(pattern)]:[];if(!hits.length)continue;
      const fragment=document.createDocumentFragment();let cursor=0;
      for(const hit of hits){if(hit.index>0&&/[\w:/]/.test(text.textContent[hit.index-1]))continue;fragment.append(document.createTextNode(text.textContent.slice(cursor,hit.index)));const link=el('a');attach(link,hit[0],source);fragment.append(link);cursor=hit.index+hit[0].length;}
      if(cursor){fragment.append(document.createTextNode(text.textContent.slice(cursor)));(exact?text.parentElement:text).replaceWith(fragment);}
    }
    return root;
  }
  async function open(path,source){
    const ref=reference(path,source);if(!ref)return;const ticket=++version;
    if(!dialog){dialog=el('dialog','message-fullscreen document-preview-dialog');dialog.id='document-preview-dialog';dialog.addEventListener('close',()=>version++);document.body.append(dialog);}
    const heading=el('div','message-fullscreen-heading'),title=el('strong','',nameOf(ref.path));title.title=ref.path;title.translate=false;
    const copy=setActionIcon(el('button','chat-icon-btn'),'copy',t('Copy')),close=setActionIcon(el('button','chat-icon-btn'),'close',t('Close'));copy.type=close.type='button';copy.disabled=true;close.autofocus=true;close.onclick=()=>dialog.close();
    let sideItem=null;const side=sideButton('chat-icon-btn document-preview-side',t('Open on the right'),()=>sideItem,{before:()=>dialog.close()});side.hidden=true;heading.append(title,copy,side,close);
    const body=el('div','message-fullscreen-body'),content=el('div','message-fullscreen-content'),status=el('p','workspace-note',t('Reading file…'));content.append(status);body.append(content);dialog.replaceChildren(heading,body);dialog.setAttribute('aria-label',nameOf(ref.path));if(!dialog.open)dialog.showModal();
    try{const result=await read(ref);if(ticket!==version||!dialog.open)return;
      const context=result.shared&&result.projectId&&result.scopeId?{kind:'project',projectId:result.projectId,scopeId:result.scopeId,basePath:result.relativePath||ref.path}:{...ref,basePath:result.path||ref.path,...(ref.readMode==='recorded'?{blockedReason:t('The linked file has no recorded version in this preview.')}:{})};
      const render=()=>/\.(?:md|markdown)$/i.test(ref.path)?decorate(renderMarkdown(simplifiedCliOutput(result.content)),context):el('pre','artifact-code',result.content);
      content.append(render());if(ref.readMode==='recorded')content.prepend(el('p','workspace-note',[t('Read-only source file'),t(ref.versionEvidence==='recorded_commit'?'Recorded commit':'Source workspace snapshot; execution-time version not recorded'),ref.sourceCommit?.slice(0,12),ref.sha256?`SHA256 ${ref.sha256.slice(0,12)}`:''].filter(Boolean).join(' · ')));if(result.syncState==='conflict'||result.syncState==='pending')content.prepend(el('p','workspace-note',t(result.syncState==='conflict'?'Conflict detected; showing actual local file.':'Showing local changes; synchronization pending.')));status.textContent=t('Full text loaded · {v} characters',{v:result.content.length.toLocaleString(dateLocale())});
      sideItem={title:nameOf(ref.path),subtitle:result.path||ref.path,copyText:result.content,render};side.hidden=!canOpenSide();copy.disabled=false;copy.onclick=()=>void copyText(copy,result.content).catch(()=>{});
    }catch(error){if(ticket===version&&dialog.open)status.textContent=t('Unable to open document: {message}',{message:error.message});}
  }
  return {decorate,open,close:()=>dialog?.close()};
}
