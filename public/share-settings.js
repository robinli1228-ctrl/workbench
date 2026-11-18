import {copyText} from './role-icons.js';

const TTLS=[['1h','1 hour'],['1d','1 day'],['7d','7 days'],['15d','15 days']];
const MODES=[['ro','Read-only'],['rw','Open to messages']];

/** Time left on a link, in the largest whole unit. */
export function shareTimeLeft(expiresAt,t,now=Date.now()){
  const ms=expiresAt-now;if(!(ms>0))return t('Expired');
  const hours=ms/3600000;
  return hours<1?t('{n} min left',{n:Math.max(1,Math.round(ms/60000))}):hours<24?t('{n} h left',{n:Math.round(hours)}):t('{n} days left',{n:Math.round(hours/24)});
}

/** Query string for one scope, without empty fields. */
export const shareQuery=scope=>new URLSearchParams(Object.entries(scope).filter(([,value])=>typeof value==='string'&&value)).toString();

/**
 * The Share tab of a group chat's or a session's settings: read-only or open to messages, a validity period (at most 15
 * days), a button that makes a link, and the links still valid, each with Copy and Revoke. Revoking ends the link at the
 * gateway and closes pages already open on it. Records live with remote access, which builds the public link.
 */
export function createSharePanel({api,t,scope,heading='',hint=''}){
  const el=(tag,className='',value)=>{const node=document.createElement(tag);if(className)node.className=className;if(value!==undefined)node.textContent=value;return node;};
  const root=el('div','share-panel');let mode='ro',ttl='1d',version=0;
  const chips=(options,current,onPick)=>{
    const group=el('div','share-chips');group.setAttribute('role','radiogroup');
    for(const [value,label] of options){
      const chip=el('button','share-chip',t(label));chip.type='button';chip.dataset.value=value;chip.setAttribute('aria-pressed',String(value===current));
      chip.addEventListener('click',()=>{for(const other of group.children)other.setAttribute('aria-pressed',String(other===chip));onPick(value);});
      group.append(chip);
    }
    return group;
  };
  const row=(label,control)=>{const line=el('div','share-row');line.append(el('span','share-row-label',t(label)),control);return line;};
  const create=el('button','primary',t('Create link'));create.type='button';
  const feedback=el('p','form-feedback share-feedback');feedback.setAttribute('role','status');feedback.hidden=true;
  const list=el('div','share-links');
  const say=(message,error=false)=>{feedback.hidden=!message;feedback.textContent=message||'';feedback.classList.toggle('global-error',error);};
  if(heading)root.append(el('p','share-heading',heading));
  root.append(row('Permission',chips(MODES,mode,value=>{mode=value;})));
  if(hint)root.append(el('p','native-side-hint share-hint',hint));
  root.append(row('Validity',chips(TTLS,ttl,value=>{ttl=value;})));
  const actions=el('div','share-row');actions.append(el('span','share-row-label',''),create);
  const linksTitle=el('p','share-links-title',t('Valid links'));
  root.append(actions,feedback,linksTitle,list);

  function draw(items){
    list.replaceChildren();
    if(!items.length){list.append(el('p','native-side-hint',t('No share links yet')));return;}
    for(const item of items){
      const line=el('div','share-link'),tag=el('span',`share-tag${item.mode==='rw'?' is-open':''}`,t(item.mode==='rw'?'Open to messages':'Read-only'));
      const url=el('code','share-url',item.url);url.translate=false;
      const copy=el('button','secondary',t('Copy'));copy.type='button';copy.addEventListener('click',()=>void copyText(copy,item.url).catch(()=>{}));
      const revoke=el('button','secondary danger',t('Revoke'));revoke.type='button';
      revoke.addEventListener('click',async()=>{revoke.disabled=true;try{await api(`/api/shares/${encodeURIComponent(item.id)}/revoke`,{method:'POST',json:{}});await load();}catch(error){revoke.disabled=false;say(t(error.message),true);}});
      line.append(tag,url,el('span','share-left',shareTimeLeft(item.expiresAt,t)),copy,revoke);list.append(line);
    }
  }
  async function load(){
    const ticket=++version;
    try{const result=await api(`/api/shares?${shareQuery(scope())}`);if(ticket===version){say('');draw(result.items||[]);}}
    catch(error){if(ticket===version){list.replaceChildren();say(t(error.message),true);}}
  }
  create.addEventListener('click',async()=>{
    create.disabled=true;say('');
    try{
      const made=await api('/api/shares',{method:'POST',json:{scope:scope(),mode,ttl}});
      await load();
      try{await copyText(create,made.url);say(t('Link created and copied'));}catch{say(t('Link created'));}
    }catch(error){say(t(error.message),true);}
    finally{create.disabled=false;}
  });
  return {root,load};
}
