import {randomUUID} from 'node:crypto';
import {applyNativeTurnEvent} from './native-turns.mjs';
import {SIDE_ASK_LIMITS,SIDE_ASK_RUNTIMES} from './native-side-ask.mjs';

/**
 * Home side of side questions: held in memory only (a Home restart forgets them), one side question at a time across the
 * Sessions page. A question is a small turn-shaped record so the page renders it like a reply; the Worker owns the
 * temporary session and removes it when Home closes the side question, when it expires, or when the main session moves on.
 */
const SIDE_ID=/^[a-f0-9-]{36}$/;
export function createHomeSideAsks({send,online,attachments=null,owner=nodeId=>nodeId,change=()=>{},clock=Date.now,limits=SIDE_ASK_LIMITS}){
 const sides=new Map(),closed=new Map();
 const stamp=()=>new Date(clock()).toISOString();
 const view=side=>({id:side.id,nodeId:side.nodeId,runtime:side.runtime,sessionId:side.sessionId,model:side.model||null,createdAt:side.createdAt,turns:side.turns??null,restarted:Boolean(side.restarted),
  questions:side.questions.map(({id,prompt,text,status,phase,error,createdAt,endedAt,events,attachments:files,contextUsage})=>({id,prompt,text:text||'',status,phase:phase||null,error:error||null,createdAt,endedAt:endedAt||null,events:events||[],attachments:(files||[]).map(({id,name,mime,size})=>({id,name,mime,size})),contextUsage:contextUsage||null}))});
 function close(sideId,reason='closed',{tell=true}={}){
  const side=sides.get(sideId);if(!side)return false;
  sides.delete(sideId);closed.set(sideId,{reason,at:clock()});if(closed.size>64)closed.delete(closed.keys().next().value);
  if(tell&&online(side.nodeId))send(side.nodeId,{type:'side_ask_close',sideId});
  change();return true;
 }
 /** A new prompt in the main session ends its side question: the next one starts from the new state. */
 function closeFor(nodeId,runtime,sessionId,reason='main_prompt'){for(const side of [...sides.values()])if(side.nodeId===nodeId&&side.runtime===runtime&&side.sessionId===sessionId)close(side.id,reason);}
 function ask(nodeId,worker,body={},source=null){
  const {runtime,sessionId}=body,prompt=typeof body.prompt==='string'?body.prompt:'';
  if(!SIDE_ASK_RUNTIMES.has(runtime))throw Error('Side questions work with Claude and Codex sessions');
  if(worker?.capabilities?.nativeSideAsk!==1)throw Error('Upgrade this Worker to ask side questions');
  if(!online(nodeId))throw Error('Device is offline');
  if(typeof sessionId!=='string'||!sessionId)throw Error('Invalid native session ID');
  if(!prompt.trim()&&!body.attachmentIds?.length)throw Error('Enter a question');
  if(prompt.length>20000)throw Error('A side question is limited to 20,000 characters');
  if(body.sideId!=null&&!SIDE_ID.test(String(body.sideId)))throw Error('Invalid side question');
  let side=body.sideId&&sides.get(body.sideId);
  if(side&&(side.nodeId!==nodeId||side.runtime!==runtime||side.sessionId!==sessionId||side.sourceKey!==(source?.key||null)))side=null;
  if(side?.questions.some(q=>['queued','starting','running','waiting_user','stopping'].includes(q.status)))throw Error('The previous side question is still being answered');
  if(!side){
   // One side question at a time: opening another closes the rest.
   for(const other of [...sides.keys()])close(other,'replaced');
   // Asked as a follow-up of a side question that has since closed (the main session moved on, it expired): say it started over.
   side={id:randomUUID(),nodeId,runtime,sessionId,sourceKey:source?.key||null,createdAt:stamp(),lastUsedAt:stamp(),questions:[],turns:null,restarted:Boolean(body.sideId)};sides.set(side.id,side);
  }
  const model=typeof body.model==='string'&&body.model.length<=120?body.model:null;side.model=model;side.lastUsedAt=stamp();
  const items=body.attachmentIds?.length&&attachments?attachments.resolve(owner(nodeId),body.attachmentIds.slice(0,6)):[];
  const question={id:randomUUID(),prompt,text:'',status:'queued',phase:null,events:[],attachments:items,createdAt:stamp()};
  const followUp=side.questions.length>0;side.questions.push(question);
  send(nodeId,{type:'side_ask',sideId:side.id,questionId:question.id,runtime,sessionId,prompt,model,followUp,...(source?.context?{context:source.context,record:source.record,expectedWorkspace:source.workspace}:{}),attachments:items.map(({id,name,mime,size,sha256})=>({id,name,mime,size,sha256}))});
  change();return view(side);
 }
 function get(sideId){const side=sides.get(sideId);if(side)return view(side);const c=closed.get(sideId);return {id:sideId,closed:true,reason:c?.reason||'closed'};}
 function stop(sideId){const side=sides.get(sideId);if(!side)return get(sideId);close(sideId,'cleared');return {id:sideId,closed:true,reason:'cleared'};}
 /** Events from the Worker; 'scope' says how many turns the side session carries, 'restarted' that it began afresh. */
 function receive(nodeId,m){
  if(m.type==='side_ask_closed'){const side=sides.get(m.sideId);if(side?.nodeId===nodeId)close(m.sideId,m.reason||'closed',{tell:false});return true;}
  if(m.type!=='side_ask_event')return false;
  const side=sides.get(m.sideId);if(!side||side.nodeId!==nodeId)return true;
  const question=side.questions.find(q=>q.id===m.questionId);if(!question)return true;
  const event=m.event||{};
  if(event.kind==='scope'){side.turns=Number.isFinite(event.turns)?event.turns:null;change();return true;}
  if(event.kind==='restarted'){side.questions=side.questions.filter(q=>q.id===question.id);side.restarted=true;side.createdAt=stamp();change();return true;}
  if(event.kind==='context_usage'&&event.sample){question.contextUsage=event.sample;change();return true;}
  const next=applyNativeTurnEvent(question,event);if(next!==question)Object.assign(question,next);side.lastUsedAt=stamp();change();return true;
 }
 /** The Worker downloads only files bound to a side question that is still being answered. */
 function attachmentFor(sideId,attachmentId){
  const side=sides.get(sideId),question=side?.questions.find(q=>q.attachments.some(a=>a.id===attachmentId)&&!q.endedAt);
  if(!side||!question)throw Error('Attachment does not belong to an open side question');
  return {owner:owner(side.nodeId),id:attachmentId};
 }
 function sweep(){const now=clock();for(const side of [...sides.values()]){if(now-Date.parse(side.lastUsedAt)>=limits.idleMs)close(side.id,'idle');else if(now-Date.parse(side.createdAt)>=limits.maxAgeMs)close(side.id,'expired');}}
 /** A Worker that goes away takes its side sessions with it. */
 function disconnected(nodeId){for(const side of [...sides.values()])if(side.nodeId===nodeId)close(side.id,'device_disconnected',{tell:false});}
 return {ask,get,stop,close,closeFor,receive,attachmentFor,sweep,disconnected,size:()=>sides.size,
  busy:(nodeId,runtime,sessionId)=>[...sides.values()].some(s=>s.nodeId===nodeId&&s.runtime===runtime&&s.sessionId===sessionId&&s.questions.some(q=>!['succeeded','failed','interrupted','cancelled','stopped'].includes(q.status)))};
}
