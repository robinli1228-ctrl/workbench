import {simplifiedCliOutput} from './output-language.js';
import {closeIcon,UI_ICON} from './role-icons.js';

export const ASK_ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8.5 8.5 0 0 1-12.6 7.4L4 21l1.6-4.4A8.5 8.5 0 1 1 21 12Z"/><path d="M9.8 9.5a2.3 2.3 0 0 1 4.4.9c0 1.6-2.2 2-2.2 3.3M12 16.6h.01"/></svg>';
const PREV='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14.5 6-6 6 6 6"/></svg>';
const NEXT='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 6 6 6-6 6"/></svg>';
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const iconButton=(cls,svg,label)=>{const b=el('button',`icon-button native-icon-action ${cls}`);b.type='button';b.innerHTML=svg;b.title=label;b.setAttribute('aria-label',label);return b;};

/**
 * A CLI's question card (AskUserQuestion / request_user_input): the question, its numbered options, a free-text reply, Skip
 * and Send. The title bar holds the icon and title, "‹ 1/2 ›" to move between several questions (answers are kept while
 * moving; Send on the last one answers them all), and "View all", a dialog with the question and every option in full that
 * can be answered there too. There is no close button: Skip covers it. Built once per question, so typing survives
 * refreshes. Question and options show in simplified script like replies; the answer sends the CLI's own label.
 * render(entry) takes {key, title, question:{id, questions}} or null; onSend(entry, {questionId, answers} | {questionId, skip}) resolves false when it failed.
 */
export function createAskCard({t,onSend,shouldFocus=()=>true}) {
  const root=el('section','native-ask');root.hidden=true;root.setAttribute('aria-label',t('Question'));
  // "View all": the same question drawn in full in a dialog, sharing the picks and the typed reply with the card.
  const dialog=el('dialog','native-ask-dialog'),full=el('section','native-ask is-full');dialog.append(full);dialog.setAttribute('aria-label',t('Question'));
  // While an answer is on its way the card stays hidden: closing the dialog (its close event comes a moment later) or a
  // refresh must not bring back a question that is being answered, with Send enabled for a second answer.
  let sending=null;
  dialog.addEventListener('close',()=>{full.replaceChildren();if(state&&!sending)render(current,{force:true});});
  dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
  let state=null,built='',current=null;
  // A failed send (onSend resolves false) brings the card back with what was picked and typed.
  const send=async(entry,body)=>{const kept=state;if(sending)return;sending=kept;root.hidden=true;if(dialog.open)dialog.close();
    let sent;try{sent=await onSend(entry,body);}finally{sending=null;}
    if(sent===false&&kept&&(!state||state===kept)){state=kept;built='';render(entry);}else if(state===kept){state=null;built='';root.replaceChildren();}};
  function render(entry,{force=false}={}) {
    const q=entry?.question;current=entry;
    if(!q){root.hidden=true;if(dialog.open)dialog.close();if(built){root.replaceChildren();built='';}state=null;return;}
    if(state?.key!==entry.key||state.questionId!==q.id)state={key:entry.key,questionId:q.id,index:0,picked:{},typed:{}};
    if(sending&&sending===state)return;
    const drawn=JSON.stringify([entry.key,q.id,state.index,entry.title||'']);
    root.hidden=false;if(drawn===built&&!force)return;built=drawn;
    draw(root,entry,false);
    if(dialog.open)draw(full,entry,true);
  }
  function draw(target,entry,inDialog) {
    const q=entry.question,st=state,total=q.questions.length,question=q.questions[st.index]||q.questions[0];
    const head=el('div','native-ask-head'),title=el('span','native-ask-title');title.innerHTML=ASK_ICON;title.append(el('span','',entry.title||t('Question')));head.append(title);
    const tools=el('span','native-ask-tools');head.append(tools);
    // Only with a mouse: on a phone focusing the reply field opens the keyboard over the options the user wants to read.
    const typeFocus=node=>{if(matchMedia?.('(pointer: fine)').matches)node?.focus({preventScroll:true});};
    const go=index=>{st.index=Math.max(0,Math.min(total-1,index));render(entry,{force:true});typeFocus((inDialog?full:root).querySelector('.native-ask-other'));};
    if(total>1){
      const prev=iconButton('native-ask-prev',PREV,t('Previous question')),next=iconButton('native-ask-next',NEXT,t('Next question'));
      prev.disabled=st.index===0;next.disabled=st.index===total-1;prev.onclick=()=>go(st.index-1);next.onclick=()=>go(st.index+1);
      tools.append(prev,el('span','native-ask-pager',`${st.index+1}/${total}`),next);
    }
    if(inDialog){const close=closeIcon(iconButton('native-ask-close','',t('Close')));close.onclick=()=>dialog.close();tools.append(close);}
    else{const expand=iconButton('native-ask-expand',UI_ICON.fullscreen,t('View all'));expand.onclick=()=>{dialog.isConnected||document.body.append(dialog);draw(full,entry,true);dialog.showModal();typeFocus(full.querySelector('.native-ask-other'));};tools.append(expand);}
    const text=el('p','native-ask-text',simplifiedCliOutput(question.question));text.translate=false;
    const list=el('div','native-ask-options');
    const answerOf=()=>{const typed=(st.typed[question.id]||'').trim();return [...(st.picked[question.id]||[]),...(typed?[typed]:[])];};
    const foot=el('div','native-ask-foot'),other=el('input','native-ask-other');other.type=question.secret?'password':'text';other.placeholder=t('Or write your own reply');other.value=st.typed[question.id]||'';other.setAttribute('aria-label',other.placeholder);
    const skip=el('button','secondary compact native-ask-skip',t('Skip')),submit=el('button','primary compact native-ask-send',t('Send'));skip.type=submit.type='button';
    const paint=()=>{for(const row of list.children)row.classList.toggle('is-picked',(st.picked[question.id]||[]).includes(row.dataset.label));submit.disabled=!answerOf().length;};
    // The card and the dialog show the same picks: a change in one is drawn in the other when it is open.
    const changed=()=>{paint();if(inDialog)draw(root,entry,false);else if(dialog.open)draw(full,entry,true);};
    question.options.forEach((option,i)=>{const row=el('button','native-ask-option');row.type='button';row.dataset.label=option.label;row.append(el('span','native-ask-key',String(i+1)),el('span','native-ask-label',simplifiedCliOutput(option.label)));
      if(option.description){const desc=el('span','native-ask-desc'),line=el('span','',simplifiedCliOutput(option.description));desc.append(line);row.append(desc);
        // A description cut off by the row scrolls sideways while the pointer or focus is on its option, then back (the dialog shows it in full).
        if(!inDialog){const roll=()=>{const extra=desc.scrollWidth-desc.clientWidth;if(extra<=2)return;desc.style.setProperty('--ask-roll',`${-extra}px`);desc.style.setProperty('--ask-roll-time',`${Math.max(3,extra/40+2).toFixed(1)}s`);desc.classList.add('is-rolling');};
          const stop=()=>desc.classList.remove('is-rolling');
          row.addEventListener('pointerenter',roll);row.addEventListener('focus',roll);row.addEventListener('pointerleave',stop);row.addEventListener('blur',stop);}}
      row.translate=false;
      row.addEventListener('click',()=>{const now=new Set(question.multiSelect?st.picked[question.id]||[]:[]);if(now.has(option.label))now.delete(option.label);else now.add(option.label);st.picked[question.id]=[...now];if(!question.multiSelect){other.value='';st.typed[question.id]='';}changed();});
      list.append(row);});
    other.addEventListener('input',()=>{st.typed[question.id]=other.value;if(!question.multiSelect&&other.value.trim())st.picked[question.id]=[];paint();});
    other.addEventListener('change',changed);
    const advance=()=>{if(st.index<total-1){go(st.index+1);return;}
      const answers={};for(const item of q.questions){const typed=(st.typed[item.id]||'').trim(),values=[...(st.picked[item.id]||[]),...(typed?[typed]:[])];if(values.length)answers[item.id]=values;}
      send(entry,Object.keys(answers).length?{questionId:q.id,answers}:{questionId:q.id,skip:true});};
    skip.addEventListener('click',()=>{st.picked[question.id]=[];st.typed[question.id]='';advance();});
    submit.addEventListener('click',()=>{if(answerOf().length)advance();});
    other.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();e.stopPropagation();if(answerOf().length)advance();}});
    target.onkeydown=e=>{if(e.target===other||e.ctrlKey||e.metaKey||e.altKey)return;const n=Number(e.key);if(n>=1&&n<=question.options.length){e.preventDefault();list.children[n-1].click();}else if(e.key==='Enter'&&answerOf().length&&!e.target.closest('.native-ask-tools')){e.preventDefault();advance();}};
    foot.append(other,skip,submit);target.replaceChildren(head,text,list,foot);paint();
    if(!inDialog&&shouldFocus()&&!dialog.open)other.focus({preventScroll:true});
  }
  return {node:root,render};
}
