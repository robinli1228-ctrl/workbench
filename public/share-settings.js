import {copyText} from './role-icons.js';

const TTLS=[['1h','1 hour'],['1d','1 day'],['7d','7 days'],['15d','15 days']];
const MODES=[['ro','Read-only'],['rw','Open to messages']];
let panels=0;

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
 * Built from the settings page's own parts (list cards with a header, label/control rows, the segmented control, chips
 * and the empty line) so it lines up with the other tabs; `variant: 'dialog'` gives the cards the session dialog's
 * section look instead.
 */
export function createSharePanel({api,t,scope,title=()=>'',hint='',variant='page'}){
  const el=(tag,className='',value)=>{const node=document.createElement(tag);if(className)node.className=className;if(value!==undefined)node.textContent=value;return node;};
  const id=++panels;let mode='ro',ttl='1d',version=0;
  const card=(heading,note)=>{
    const section=el('section',variant==='dialog'?'settings-list native-settings-section':'settings-list'),header=el('header','settings-list-head'),text=el('div'),h3=el('h3','',heading);
    text.append(h3);if(note)text.append(el('p','',note));header.append(text);section.append(header);return {section,h3};
  };
  const segmented=(name,options,current,onPick)=>{
    const group=el('span','settings-segmented');group.setAttribute('role','radiogroup');group.setAttribute('aria-label',t(name));
    for(const [value,label] of options){
      const option=el('label'),input=el('input');input.type='radio';input.name=`share-${name.toLowerCase()}-${id}`;input.value=value;input.checked=value===current;
      input.addEventListener('change',()=>{if(input.checked)onPick(value);});
      option.append(input,el('span','',t(label)));group.append(option);
    }
    return group;
  };
  const row=(label,note,control)=>{
    const line=el('div','settings-row'),name=el('span','settings-row-label',t(label)),value=el('span','settings-row-value');
    if(note)name.append(el('small','',t(note)));value.append(control);line.append(name,value);return line;
  };

  // New link: permission, validity, then the button (the link is copied when it is made).
  const making=card('',hint);
  const create=el('button','primary',t('Create link'));create.type='button';
  const createRow=el('div','settings-row share-create-row');createRow.append(el('span','settings-row-value muted',t('The link is copied when it is made')),create);
  const feedback=el('p','settings-list-note');feedback.setAttribute('role','status');feedback.hidden=true;
  const say=(message,error=false)=>{feedback.hidden=!message;feedback.textContent=message||'';feedback.classList.toggle('global-error',error);};
  making.section.append(row('Permission','',segmented('Permission',MODES,mode,value=>{mode=value;})),
    row('Validity','At most 15 days',segmented('Validity',TTLS,ttl,value=>{ttl=value;})),createRow,feedback);

  // Links still valid.
  const valid=card(t('Valid links'),t('Revoking a link also closes pages already open on it.'));
  const list=el('div','share-links');valid.section.append(list);
  const root=el('div','settings-list-stack share-panel');root.append(making.section,valid.section);
  const name=()=>{const value=title();making.h3.textContent=value?t('Sharing: {title}',{title:value}):t('New share link');};
  name();

  function draw(items){
    list.replaceChildren();
    if(!items.length){list.append(el('div','settings-list-empty',t('No share links yet')));return;}
    for(const item of items){
      const line=el('div','settings-row share-link'),main=el('span','settings-row-main');
      const url=el('small','share-url',item.url);url.translate=false;url.title=item.url;
      main.append(el('strong','',shareTimeLeft(item.expiresAt,t)),url);
      const tag=el('span',`settings-chip${item.mode==='rw'?' warn':''}`,t(item.mode==='rw'?'Open to messages':'Read-only'));
      const actions=el('span','settings-row-actions');
      const copy=el('button','secondary',t('Copy'));copy.type='button';copy.addEventListener('click',()=>void copyText(copy,item.url).catch(()=>{}));
      const revoke=el('button','secondary share-revoke',t('Revoke'));revoke.type='button';
      revoke.addEventListener('click',async()=>{revoke.disabled=true;try{await api(`/api/shares/${encodeURIComponent(item.id)}/revoke`,{method:'POST',json:{}});await load();}catch(error){revoke.disabled=false;say(t(error.message),true);}});
      actions.append(copy,revoke);line.append(main,tag,actions);list.append(line);
    }
  }
  async function load(){
    name();const ticket=++version;
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
