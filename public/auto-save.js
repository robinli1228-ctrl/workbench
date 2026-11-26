/**
 * Settings shown on a page apply as soon as they change; there is no Save button. A switch, select or date saves on change,
 * a text or number field when it is committed (blur, Enter or a spinner step). Saves run one at a time: a change made while
 * one runs is saved right after, with the newest values. An invalid field shows its own message and nothing is sent, and
 * values equal to the last saved (or loaded) ones are not sent again.
 *
 * save() reads the form itself and resolves false when it failed (it shows its own message), so the same values are tried
 * again on the next change. Call reset() after filling the form from the server.
 */
export function autoSave(form,save,{snapshot=()=>JSON.stringify([...new FormData(form)])}={}) {
  let running=false,again=false,last=snapshot();
  async function commit() {
    if(running){again=true;return;}
    if(!form.checkValidity()){form.reportValidity();return;}
    const now=snapshot();if(now===last)return;
    running=true;
    try{if(await save()!==false)last=now;}
    catch{}
    finally{running=false;}
    if(again){again=false;void commit();}
  }
  form.addEventListener('change',()=>void commit());
  // Enter in a one-line field commits it; a form without a submit button would otherwise ignore it.
  form.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing&&event.target instanceof HTMLInputElement&&event.target.type!=='checkbox'){event.preventDefault();void commit();}});
  form.addEventListener('submit',event=>{event.preventDefault();void commit();});
  return {commit,reset(){last=snapshot();},busy:()=>running};
}
