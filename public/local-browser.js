import {t,dateLocale} from './i18n.js';
import {setActionIcon,copyText,UI_ICON} from './role-icons.js';
import {fileGlyph,formatBytes,openMediaViewer,mediaKindFromName} from './media.js';

const el=(tag,className='',text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
const baseName=path=>String(path||'').replace(/\/+$/,'').split('/').pop()||path;
const parentOf=path=>String(path||'').replace(/\/+$/,'').replace(/\/[^/]*$/,'')||'/';
const byteLength=text=>new TextEncoder().encode(String(text||'')).length;
const when=value=>value?new Date(value).toLocaleString(dateLocale(),{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'';

/**
 * A folder or file named by a link in a reply, opened in the page on whichever device the run used: a folder lists one
 * level (into subfolders and back up, never above the link's folder), a text file shows its first 64 KB, pictures, videos
 * and other files go to the media viewer (which plays, shows or downloads them). Home keeps it inside the run's project.
 */
export function createLocalBrowser({api}) {
  let dialog=null,version=0;
  function shell(title,subtitle){
    if(!dialog){dialog=el('dialog','message-fullscreen local-browser-dialog');dialog.addEventListener('close',()=>version++);document.body.append(dialog);}
    const heading=el('div','message-fullscreen-heading'),name=el('strong','',title);name.title=subtitle;name.translate=false;
    const actions=el('span','local-browser-actions'),close=setActionIcon(el('button','chat-icon-btn'),'close',t('Close'));close.type='button';close.onclick=()=>dialog.close();
    heading.append(name,actions,close);
    const path=el('p','local-browser-path',subtitle);path.translate=false;
    const body=el('div','message-fullscreen-body'),content=el('div','message-fullscreen-content local-browser-content'),status=el('p','workspace-note',t('Reading file…'));
    content.append(path,status);body.append(content);dialog.replaceChildren(heading,body);dialog.setAttribute('aria-label',title);
    if(!dialog.open)dialog.showModal();
    return {actions,content,status,path};
  }
  async function open(runId,path,context,{top=null}={}) {
    const ticket=++version,view=shell(baseName(path),path);
    let result;
    try{result=await api(`/api/runs/${encodeURIComponent(runId)}/local?${new URLSearchParams({path})}`);}
    catch(error){
      if(ticket!==version)return;
      // Pictures, videos and binary files are the media viewer's: it shows them or offers the download.
      if(/binary_file/.test(error.message)){dialog.close();void openMediaViewer(path,context).catch(()=>{});return;}
      view.status.textContent=t('Unable to open: {message}',{message:error.message});return;
    }
    if(ticket!==version)return;
    const root=top||(result.kind==='folder'?result.path:parentOf(result.path));
    const up=folder=>{const button=setActionIcon(el('button','chat-icon-btn'),'back',t('Back'));button.type='button';button.onclick=()=>void open(runId,folder,context,{top:root});return button;};
    if(result.kind==='folder'){
      if(result.path!==root)view.actions.append(up(parentOf(result.path)));
      const list=el('div','local-browser-list');
      for(const item of result.items||[]){
        const row=el('button','local-browser-row');row.type='button';
        const target=`${result.path.replace(/\/+$/,'')}/${item.name}`,folder=item.kind==='folder';
        const icon=folder?el('span','local-browser-icon local-browser-folder'):fileGlyph(item.name,'local-browser-icon');if(folder)icon.innerHTML=UI_ICON.folder;
        const name=el('span','local-browser-name',item.name);name.translate=false;
        row.append(icon,name,el('small','',[folder?'':formatBytes(item.size),when(item.modifiedAt)].filter(Boolean).join(' · ')));
        row.onclick=()=>{
          if(folder)return void open(runId,target,context,{top:root});
          if(mediaKindFromName(item.name)!=='file'){dialog.close();return void openMediaViewer(target,context).catch(()=>{});}
          void open(runId,target,context,{top:root});
        };
        list.append(row);
      }
      if(!list.childElementCount)list.append(el('p','workspace-note',t('This folder is empty.')));
      if(result.partial)list.append(el('p','workspace-note',t('Only the first {count} entries are shown.',{count:(result.items||[]).length})));
      view.content.replaceChildren(view.path,list);return;
    }
    if(result.path!==path||top)view.actions.append(up(parentOf(result.path)));
    const copy=setActionIcon(el('button','chat-icon-btn'),'copy',t('Copy'));copy.type='button';copy.onclick=()=>void copyText(copy,result.content||'').catch(()=>{});view.actions.prepend(copy);
    const text=el('pre','artifact-code local-browser-text',result.content||'');text.translate=false;
    const more=result.size>byteLength(result.content)?el('p','workspace-note',t('Showing the first 64 KB of {size}.',{size:formatBytes(result.size)})):null;
    view.content.replaceChildren(...[view.path,more,text].filter(Boolean));
  }
  return {open};
}
