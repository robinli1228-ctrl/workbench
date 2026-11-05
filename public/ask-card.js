import {simplifiedCliOutput} from './output-language.js';
import {closeIcon} from './role-icons.js';

const ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8.5 8.5 0 0 1-12.6 7.4L4 21l1.6-4.4A8.5 8.5 0 1 1 21 12Z"/><path d="M9.8 9.5a2.3 2.3 0 0 1 4.4.8c0 1.5-2.2 2-2.2 3.2"/><path d="M12 16.6h.01"/></svg>';
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};

/**
 * A CLI's question card (AskUserQuestion / request_user_input): the question, its numbered options, a free-text reply, Skip
 * and Send; several questions page through with "1/2" and are answered together. Built once per question, so typing
 * survives refreshes. Question and options show in simplified script like replies; the answer sends the CLI's own label.
 * render(entry) takes {key, title, question:{id, questions}} or null; onSend(entry, {questionId, answers} | {questionId, skip}).
 */
export function createAskCard({t,onSend,shouldFocus=()=>true}) {
  const root=el('section','native-ask');root.hidden=true;root.setAttribute('aria-label',t('Question'));
  let state=null,built='',keys=null;
  // One listener for the card's whole life; it acts on the question drawn last.
  root.addEventListener('keydown',e=>keys?.(e));
  const send=(entry,body)=>{state=null;built='';keys=null;root.hidden=true;root.replaceChildren();void onSend(entry,body);};
  function render(entry) {
    const q=entry?.question;
    if(!q){root.hidden=true;if(built){root.replaceChildren();built='';keys=null;}state=null;return;}
    if(state?.key!==entry.key||state.questionId!==q.id)state={key:entry.key,questionId:q.id,index:0,picked:{},typed:{}};
    const st=state,total=q.questions.length,question=q.questions[st.index]||q.questions[0],drawn=JSON.stringify([entry.key,q.id,st.index,entry.title||'']);
    root.hidden=false;if(drawn===built)return;built=drawn;
    const head=el('div','native-ask-head'),title=el('span','native-ask-title');title.innerHTML=ICON;title.append(el('span','',entry.title||t('Question')));head.append(title);
    if(total>1)head.append(el('span','native-ask-pager',`${st.index+1}/${total}`));
    const close=closeIcon(el('button','icon-button native-icon-action native-ask-close'),t('Skip all questions'));close.type='button';
    close.addEventListener('click',()=>send(entry,{questionId:q.id,skip:true}));head.append(close);
    const text=el('p','native-ask-text',simplifiedCliOutput(question.question));text.translate=false;
    const list=el('div','native-ask-options');
    const answerOf=()=>{const typed=(st.typed[question.id]||'').trim();return [...(st.picked[question.id]||[]),...(typed?[typed]:[])];};
    const foot=el('div','native-ask-foot'),other=el('input','native-ask-other');other.type=question.secret?'password':'text';other.placeholder=t('Or write your own reply');other.value=st.typed[question.id]||'';other.setAttribute('aria-label',other.placeholder);
    const skip=el('button','secondary compact native-ask-skip',t('Skip')),submit=el('button','primary compact native-ask-send',t('Send'));skip.type=submit.type='button';
    const paint=()=>{for(const row of list.children)row.classList.toggle('is-picked',(st.picked[question.id]||[]).includes(row.dataset.label));submit.disabled=!answerOf().length;};
    question.options.forEach((option,i)=>{const row=el('button','native-ask-option');row.type='button';row.dataset.label=option.label;row.append(el('span','native-ask-key',String(i+1)),el('span','native-ask-label',simplifiedCliOutput(option.label)));
      if(option.description)row.append(el('span','native-ask-desc',simplifiedCliOutput(option.description)));row.translate=false;
      row.addEventListener('click',()=>{const now=new Set(question.multiSelect?st.picked[question.id]||[]:[]);if(now.has(option.label))now.delete(option.label);else now.add(option.label);st.picked[question.id]=[...now];if(!question.multiSelect){other.value='';st.typed[question.id]='';}paint();});
      list.append(row);});
    other.addEventListener('input',()=>{st.typed[question.id]=other.value;if(!question.multiSelect&&other.value.trim())st.picked[question.id]=[];paint();});
    const advance=()=>{if(st.index<total-1){st.index+=1;render(entry);root.querySelector('.native-ask-other')?.focus({preventScroll:true});return;}
      const answers={};for(const item of q.questions){const typed=(st.typed[item.id]||'').trim(),values=[...(st.picked[item.id]||[]),...(typed?[typed]:[])];if(values.length)answers[item.id]=values;}
      send(entry,Object.keys(answers).length?{questionId:q.id,answers}:{questionId:q.id,skip:true});};
    skip.addEventListener('click',()=>{st.picked[question.id]=[];st.typed[question.id]='';advance();});
    submit.addEventListener('click',()=>{if(answerOf().length)advance();});
    other.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();e.stopPropagation();if(answerOf().length)advance();}});
    keys=e=>{if(e.target===other||e.ctrlKey||e.metaKey||e.altKey)return;const n=Number(e.key);if(n>=1&&n<=question.options.length){e.preventDefault();list.children[n-1].click();}else if(e.key==='Enter'&&answerOf().length){e.preventDefault();advance();}};
    foot.append(other,skip,submit);root.replaceChildren(head,text,list,foot);paint();
    if(shouldFocus())other.focus({preventScroll:true});
  }
  return {node:root,render};
}
