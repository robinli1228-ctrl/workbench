import {t} from './i18n.js';

/** Shared picker action: a request keeps its captured device/parent, and late replies cannot change a newer selection. */
export function createFolderControl({api,onCreated}) {
  const make=(tag,cls,text)=>{const el=document.createElement(tag);el.className=cls;if(text)el.textContent=t(text);return el;};
  const button=make('button','secondary','New folder'),panel=make('div','folder-create-panel');
  const fields=make('div','folder-create-fields'),label=make('label','','Folder name'),input=make('input','');
  const submit=make('button','primary','Create folder'),cancel=make('button','secondary','Cancel'),message=make('p','form-feedback');
  for(const b of [button,submit,cancel])b.type='button';
  input.type='text';input.autocomplete='off';input.maxLength=255;input.setAttribute('aria-label',t('Folder name'));
  label.append(input);fields.append(label,submit,cancel);message.setAttribute('role','status');panel.append(fields,message);
  let context={},version=0,busy=false;
  const visible=()=>panel.isConnected&&Boolean(panel.closest('dialog')?.open);
  const close=()=>{fields.hidden=true;button.setAttribute('aria-expanded','false');input.value='';};
  function update(value={}) {
    context=value;version++;busy=false;close();message.hidden=true;message.textContent='';
    input.disabled=submit.disabled=cancel.disabled=false;
    button.disabled=!value.enabled||!value.path;
    button.title=t(!value.enabled?'Update the Worker on this device to enable creating folders.':!value.path?'Open a parent folder first.':'New folder');
  }
  button.addEventListener('click',()=>{if(button.disabled)return;fields.hidden=false;button.setAttribute('aria-expanded','true');message.hidden=true;input.focus();});
  cancel.addEventListener('click',close);
  async function create() {
    if(busy||button.disabled||!visible())return;
    const name=input.value.trim();if(!name){input.focus();return;}
    const target={...context},ticket=version;busy=true;input.disabled=submit.disabled=cancel.disabled=button.disabled=true;message.hidden=false;message.textContent=t('Creating folder…');
    try {
      const result=await api(`/api/workers/${encodeURIComponent(target.nodeId)}/directories`,{method:'POST',json:{path:target.path,name}});
      if(ticket!==version||!visible())return;
      close();await onCreated(result,target);
      if(visible()&&context.nodeId===target.nodeId&&[result.path,result.parent].includes(context.path)){message.textContent=t('Folder created.');message.hidden=false;}
    } catch(error) {if(ticket===version&&visible()){message.textContent=t(error.message);message.hidden=false;}}
    finally {if(ticket===version){busy=false;input.disabled=submit.disabled=cancel.disabled=false;button.disabled=!context.enabled||!context.path;}}
  }
  submit.addEventListener('click',()=>void create());
  input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();void create();}});
  update();return {button,panel,update};
}
