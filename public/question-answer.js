import {simplifiedCliOutput} from './output-language.js';

/**
 * The user's answer to a CLI's or role's question, drawn as the user's own message: "Reply to the question from <who>", then each
 * question (small, grey) with the answer under it; a skipped question says so. Shared by the Sessions page and the group chat.
 * record: {items:[{question, answer:[…]} | {question, skipped:true}], skipped}.
 */
export function answerContent(record,{asker,t}){
 const box=document.createElement('div');box.className='qa-answer';
 const lead=document.createElement('div');lead.className='qa-lead';lead.textContent=t('Reply to the question from {name}',{name:asker||t('Assistant')});box.append(lead);
 const list=document.createElement('ol');
 for(const item of record?.items||[]){
  const li=document.createElement('li'),q=document.createElement('div'),a=document.createElement('div');
  q.className='qa-q';q.textContent=simplifiedCliOutput(item.question||'');q.translate=false;
  a.className=`qa-a${item.skipped?' is-skipped':''}`;a.textContent=item.skipped?t('Skipped'):item.secret?t('Filled in'):(item.answer||[]).map(simplifiedCliOutput).join(t(', '));if(!item.skipped)a.translate=false;
  li.append(q,a);list.append(li);
 }
 box.append(list);return box;
}

/** Plain text of an answer for Copy and full screen. */
export function answerPlainText(record,{asker,t}){
 return [t('Reply to the question from {name}',{name:asker||t('Assistant')}),...(record?.items||[]).map((item,i)=>`${i+1}. ${simplifiedCliOutput(item.question||'')}\n${item.skipped?t('Skipped'):item.secret?t('Filled in'):(item.answer||[]).map(simplifiedCliOutput).join(t(', '))}`)].join('\n');
}

/** One answer record from the questions asked and the answers given (by question id, or by question text). */
export function answerRecord(questions,given,failed=false){
 const items=(questions||[]).map(q=>{const raw=given?.byId?.[q.id]??(given?.byText&&Object.hasOwn(given.byText,q.question)?given.byText[q.question]:[]);
  const list=[].concat(raw??[]).map(String).filter(Boolean);
  return failed||!list.length?{question:q.question,skipped:true}:{question:q.question,answer:q.secret?[]:list,...(q.secret?{secret:true}:{})};});
 return {items,skipped:items.every(item=>item.skipped)};
}

/**
 * History rows to transcript rows: a question call and its result (paired by call id) become the user's answer row at the
 * result's place and time; a result whose call is on an earlier page keeps its tool role until that page is loaded. A call whose
 * result has not come yet shows nothing here (the page's question card stands for it).
 */
export function answerRows(rows){
 if(!rows.some(row=>row.role==='question_call'))return rows;
 const asked=new Map(),out=[];
 for(const row of rows){
  if(row.role==='question_call'){asked.set(row.callId,row);continue;}
  const call=asked.get(row.callId);
  if(call&&['question_answer','tool_result'].includes(row.role)){
   // The call supplies the trusted question schema, including secret flags. A result alone is still a tool result.
   const questions=call.questions;
   asked.delete(row.callId);out.push({role:'user',text:'',answer:answerRecord(questions,row.given,row.failed===true),timestamp:row.timestamp||null,...(row.id?{id:row.id}:{})});continue;}
  out.push(row);
 }
 return out;
}
