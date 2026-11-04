import {t} from './i18n.js';
import {setActionIcon} from './role-icons.js';

const el=(tag,cls='',text)=>{const node=document.createElement(tag);node.className=cls;if(text!==undefined)node.textContent=text;return node;};

/** Device settings edit loopback backup listeners; probes run only after a click or an actual transport stall. */
export function deviceTransportUI({api}) {
  let dialog=null,generation=0;
  async function open(id,name) {
    const version=++generation;if(dialog?.open)dialog.close();
    const host=el('dialog','device-transport-dialog');dialog=host;let timer=null;host.id='device-transport-dialog';
    const heading=el('div','dialog-heading'),title=el('h2','',t('Transport routes'));
    const close=setActionIcon(el('button','icon-button'),'close',t('Close'));close.type='button';close.onclick=()=>host.close();heading.append(title,close);
    const form=el('form','device-transport-form'),device=el('p','workspace-note',name);device.translate=false;
    const enabled=el('input');enabled.type='checkbox';enabled.name='enabled';const toggle=el('label','checkbox-label');toggle.append(enabled,el('span','',t('Test backups and reconnect when a transfer stalls')));
    const current=el('p','workspace-note'),rows=el('div','transport-route-list'),results=el('div','transport-test-results'),error=el('p','form-feedback');error.setAttribute('role','status');
    const add=el('button','secondary',t('Add backup'));add.type='button';
    const save=el('button','primary',t('Save'));save.type='submit';const test=el('button','secondary',t('Test speeds'));test.type='button';
    const direct=el('button','secondary',t('Return to direct'));direct.type='button';const actions=el('div','dialog-actions');actions.append(direct,test,save);
    form.append(device,el('p','',t('Default route: direct')),toggle,el('p','workspace-note',t('Each backup uses its own local SOCKS port. Existing transfers reconnect only when the device is idle.')),current,rows,add,results,error,actions);host.append(heading,form);document.body.append(host);
    let state=null,dirty=false,busy=false;
    const url=`/api/devices/${encodeURIComponent(id)}/transport`;
    const mark=()=>{dirty=true;test.disabled=true;};enabled.onchange=mark;
    function row(value={}) {
      const item=el('div','transport-route-row'),nameLabel=el('label'),portLabel=el('label'),nodeName=el('input'),port=el('input');
      nodeName.type='text';nodeName.required=true;nodeName.maxLength=80;nodeName.value=value.name||'';nodeName.setAttribute('aria-label',t('Backup name'));nodeName.translate=false;
      port.type='number';port.required=true;port.min='1';port.max='65535';port.step='1';port.value=value.port??'';port.setAttribute('aria-label',t('Local SOCKS port'));
      nameLabel.append(el('span','',t('Backup name')),nodeName);portLabel.append(el('span','',t('Local SOCKS port')),port);
      const remove=setActionIcon(el('button','icon-button'),'trash',t('Remove backup'));remove.type='button';remove.onclick=()=>{item.remove();mark();add.disabled=rows.children.length>=7;};
      item.append(nameLabel,portLabel,remove);item.read=()=>({name:nodeName.value,port:Number(port.value)});nodeName.oninput=port.oninput=mark;rows.append(item);add.disabled=rows.children.length>=7;
    }
    const speed=value=>Number.isFinite(value)?`${(value/1000000).toFixed(2)} MB/s`:'—';
    function status(next) {
      state=next;const route=next.current==='DIRECT'?t('Direct'):next.current;
      current.textContent=t('Current route: {name}',{name:route})+(next.pending?' · '+t('Waiting for idle: {name}',{name:next.pending}):'');
      results.replaceChildren();
      for(const result of next.test?.results||[]){const line=el('p','transport-test-result');line.translate=false;line.textContent=(result.name==='DIRECT'?t('Direct'):result.name)+' · '+(result.complete?t('Upload {up} · Download {down}',{up:speed(result.uploadBps),down:speed(result.downloadBps)}):t('Test failed or timed out'));results.append(line);}
      const running=next.test?.status==='running';test.disabled=dirty||busy||running||next.busy;save.disabled=busy||running||next.busy;direct.disabled=busy||running||next.busy||next.current==='DIRECT';
      if(running)error.textContent=t('Testing…');else if(error.textContent===t('Testing…'))error.textContent=t('Speed test completed.');
      if(running||next.busy||next.pending)schedule(next.pending?3000:1000);else clearTimeout(timer);
    }
    function schedule(delay=1000){clearTimeout(timer);timer=setTimeout(async()=>{if(!host.open||version!==generation)return;try{status(await api(url));}catch(e){error.textContent=t(e.message);}},delay);}
    async function action(fn){if(busy||!state)return;busy=true;error.textContent='';test.disabled=save.disabled=direct.disabled=true;try{const result=await fn();if(version!==generation||!host.open)return;status(result);}catch(e){if(version===generation&&host.open)error.textContent=t(e.message);}finally{busy=false;if(state&&version===generation&&host.open)status(state);}}
    add.onclick=()=>{row();mark();};
    form.onsubmit=event=>{event.preventDefault();void action(async()=>{const result=await api(url,{method:'PUT',json:{revision:state.revision,enabled:enabled.checked,candidates:[...rows.children].map(item=>item.read())}});dirty=false;error.textContent=t('Transport settings saved.');return result;});};
    test.onclick=()=>void action(()=>api(url+'/test',{method:'POST',json:{}}));direct.onclick=()=>void action(()=>api(url+'/direct',{method:'POST',json:{}}));
    add.disabled=save.disabled=test.disabled=direct.disabled=true;enabled.disabled=true;
    host.addEventListener('close',()=>{clearTimeout(timer);host.remove();});host.showModal();
    try{const result=await api(url);if(version!==generation||!host.open)return;enabled.disabled=false;enabled.checked=result.enabled;add.disabled=false;for(const c of result.candidates)row(c);status(result);}catch(e){error.textContent=t(e.message);save.disabled=test.disabled=direct.disabled=true;}
  }
  return {open};
}
