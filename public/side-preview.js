import {setActionIcon} from './role-icons.js';

/**
 * The Sessions page's right-side Preview tab: one message, picture, video, PDF, text or file view pinned beside the chat
 * for side-by-side reading. It stays while another session is opened, so replies from two sessions can be compared.
 * Entries call openSide() from the media viewer, the file sheet, the output details and the message tools; the page
 * registers the panel while it is shown. Desktop only: phones have no room beside the chat.
 */
const MOBILE='(max-width: 1000px)';
let opener=null;
export function setSidePreviewOpener(value){opener=value;}
export const canOpenSide=()=>Boolean(opener?.available?.())&&!matchMedia(MOBILE).matches;
export function openSide(item){if(!item||!canOpenSide())return false;opener.open(item);return true;}

const el=(tag,className='',text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};

/** An icon button that opens `item` (or what `item()` returns) on the right; hidden where the side preview is unavailable. */
export function sideButton(className,label,item,{before=null}={}){
  // Phone widths hide these in the stylesheet, so a window resized later still gets working buttons.
  const b=el('button',className);b.type='button';setActionIcon(b,'sideOpen',label);b.hidden=!opener?.available?.();
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
    const setCopy=options=>{if(copyAction)copyAction(copy,options);else{copy.hidden=false;copy.onclick=()=>void navigator.clipboard?.writeText(options.text||'').catch(()=>{});}};
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
