import {copyText,bindCopyFeedback} from './role-icons.js';
import {t as globalT,getLanguage,dateLocale} from './i18n.js';
import pageZh from './locales/native-takeover-zh.js';
import {UI_ICON,agentIconEl,closeIcon} from './role-icons.js';
import {formatBytes,linkMedia} from './media.js';
import {renderMarkdown} from './markdown.js';
import {liveSceneRows} from './live-scene.js';
import {activityBlock,classifyStep,taskBlock,createPreviewSheet,elapsedText} from './native-transcript.js';
import {simplifiedCliOutput} from './output-language.js';
import {stripAnsi} from './run-log-data.js';
import {sideButton} from './side-preview.js';
const t=(text,params)=>{const own=getLanguage()==='zh'?pageZh[text]:undefined;return own===undefined?globalT(text,params):params?own.replace(/\{(\w+)\}/g,(m,k)=>params[k]??m):own;};
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const button=(text,fn,cls='secondary')=>{const n=el('button',cls,t(text));n.type='button';n.addEventListener('click',fn);return n;};
const setActionIcon=(node,name,label)=>{node.innerHTML=UI_ICON[name]||'';node.title=label;node.setAttribute('aria-label',label);};
const iconButton=(name,label,fn,cls='',feedbackKey)=>{const node=button('',fn,`icon-button ${cls}`);setActionIcon(node,name,t(label));return bindCopyFeedback(node,feedbackKey);};
const endpoint=nodeId=>`/api/native-sessions/${encodeURIComponent(nodeId)}`;
const nativeId=value=>value.sessionId||value.id;
const clock=value=>new Date(value).toLocaleTimeString(dateLocale(),{hour:'2-digit',minute:'2-digit'});
const names={claude:'Claude Code',codex:'Codex'};
/** Long prompts retain the Sessions full-text action instead of trapping text behind the three-line clamp. */
function showPrompt(text){
 const dialog=el('dialog','message-fullscreen'),header=el('header','message-fullscreen-header'),body=el('div','message-fullscreen-body'),content=el('div','message-fullscreen-content');
 header.append(el('h2','',t('My message')),iconButton('copy','Copy',e=>void copyText(e.currentTarget,text).catch(()=>{})),sideButton('icon-button nt-prompt-side',t('Open on the right'),()=>({title:t('My message'),copyText:text,render:()=>el('div','nt-side-prompt',text)}),{before:()=>dialog.close()}),iconButton('close','Close',()=>dialog.close()));content.append(el('div','chat-message-text',text));body.append(content);dialog.append(header,body);dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal();
}


/** Both entry points render the same native transcript primitives; no group messages are created here. */
function questionRows(q,session,files,live,preview,api){
 const user=el('article','nt-row nt-user native-chat-row'),userBody=el('div','nt-body'),text=el('div','nt-prompt-text',q.prompt);
 userBody.append(text);userBody.hidden=!q.prompt?.trim();if(files)user.append(files);user.append(userBody);
 const tools=el('div','nt-prompt-tools');tools.append(el('time','nt-prompt-time',clock(q.createdAt)),iconButton('copy','Copy',e=>void copyText(e.currentTarget,q.prompt||'').catch(()=>{}),'',`side:${q.id}:prompt`));const expand=iconButton('fullscreen','Full screen',()=>showPrompt(q.prompt||''),'nt-prompt-expand');expand.hidden=true;tools.append(expand);if(q.prompt?.trim())tools.append(sideButton('icon-button nt-prompt-side',t('Open on the right'),()=>({title:t('My message'),copyText:q.prompt,render:()=>el('div','nt-side-prompt',q.prompt)})));requestAnimationFrame(()=>{expand.hidden=!(text.isConnected&&text.scrollHeight>text.clientHeight+1);});user.append(tools);
 const reply=el('article',`nt-row nt-agent native-chat-row${q.status==='failed'?' is-error':''}`),by=el('div','nt-byline'),avatar=el('span','nt-avatar');avatar.append(agentIconEl(session.runtime));
 by.append(avatar,el('span','nt-name',names[session.runtime]),el('time','',clock(q.endedAt||q.createdAt)));reply.append(by);
 const markdown=value=>linkMedia(renderMarkdown(value),{key:`native:${session.nodeId}:${session.runtime}:${nativeId(session)}`,describe:path=>api(`${endpoint(session.nodeId)}/media?${new URLSearchParams({runtime:session.runtime,sessionId:nativeId(session),path})}`)});
 const body=el('div','nt-body'),content=el('div','nt-turn');body.append(content);reply.append(body);
 const rows=liveSceneRows(q.events||[],{status:q.status}).rows.filter(r=>!(r.kind==='log'&&/^\s*\d{4}-\d\d-\d\dT\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\b/m.test(stripAnsi(r.text||''))));
 const messages=new Set(rows.filter(r=>r.kind==='message').map(r=>r.text.trim())),seen=new Set();let group=[];
 const flush=()=>{if(!group.length)return;content.append(activityBlock({steps:group.filter(r=>r.kind==='tool').map(r=>classifyStep(r.item,q.status)),notes:group.filter(r=>r.kind!=='tool'),t,live,open:live,onPreview:(step,path)=>preview.open(step,path)}));group=[];};
 for(const row of rows){if(['tool','log','error'].includes(row.kind)){group.push(row);continue;}flush();const value=simplifiedCliOutput(stripAnsi(row.text||''));if(!value.trim()||seen.has(value)||row.kind==='text'&&messages.has(row.text.trim()))continue;seen.add(value);content.append(markdown(value));}flush();
 if(!seen.size&&q.text)content.append(markdown(simplifiedCliOutput(q.text)));
 const tasks=taskBlock(q,t,{live});if(tasks)content.append(tasks);
 if(live){const line=el('div','nt-working');line.append(el('span','nt-pulse'),el('span','nt-working-time',elapsedText(q.createdAt)),el('span','nt-working-hint',t(q.status==='queued'?'Waiting for the device…':q.status==='starting'?'Starting the CLI…':'Working…')));content.append(line);}
 else{const foot=el('div','nt-reply-foot'),last=[...rows].reverse().find(r=>['message','text'].includes(r.kind));foot.append(iconButton('copy','Copy',e=>void copyText(e.currentTarget,last?.text||q.text||'').catch(()=>{}),'',`side:${q.id}:reply`));if(q.endedAt)foot.append(el('span','nt-duration',t('Took {duration}',{duration:elapsedText(q.createdAt,new Date(q.endedAt).getTime())})));if(q.status!=='succeeded')foot.append(el('span','nt-foot-status',`${t(q.status==='interrupted'?'Interrupted':'Failed')}${q.error?` · ${t(q.error)}`:''}`));reply.append(foot);}
 return [user,reply];
}

/** Shared temporary side chat: transport, composer, uploads and lifecycle are identical in Sessions and group cards. */
export function createSideAsk({api,getData,getModel=()=>null}){
  const root=el('div','native-side-ask');
  const preview=createPreviewSheet(root,t);
  // The clear button sits in the right panel's header, shown while this tab is selected.
  const clear=iconButton('brush','Clear this side question',()=>{input.value='';void reset({tell:true});},'native-ask-clear');
  const body=el('div','side-preview-body native-ask-body'),note=el('p','workspace-note native-ask-note');note.hidden=true;
  const form=el('form','chat-composer native-takeover-form native-ask-form'),bar=el('div','chat-input-bar'),field=el('div','chat-input-field'),tray=el('div','chat-attachments native-takeover-tray');tray.hidden=true;
  const attach=el('button','native-attach');attach.type='button';attach.title=t('Upload an image or file');attach.setAttribute('aria-label',t('Upload file'));attach.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8M7 13l7-7"/></svg>';
  const model=el('select','native-ask-model');model.setAttribute('aria-label',t('Model for side questions'));
  const input=el('textarea');input.rows=3;input.placeholder=t('Ask a quick question that does not interrupt the main session…');input.setAttribute('aria-label',t('Side question'));
  const send=el('button','primary chat-send');send.type='submit';setActionIcon(send,'send',t('Send'));
  const fileInput=el('input');fileInput.type='file';fileInput.multiple=true;fileInput.hidden=true;document.body.append(fileInput);
  // Text on top, a tool row under it: attach and model on the left, send on the right.
  const tools=el('div','native-ask-tools'),gap=el('span','native-ask-tools-gap');tools.append(attach,model,gap,send);
  field.append(tray,input,tools);bar.append(field);form.append(bar);root.append(body,note,form);
  let session=null,sideId=null,view=null,pending=false,poll=null,signature='',files=[],uploads=0,notice='',generation=0,sourceLoading=false;
  const sessionKey=value=>value?value.sourceKey||`${value.nodeId}/${value.runtime}/${nativeId(value)}`:'';
  const live=q=>['queued','starting','running','waiting_user','stopping'].includes(q?.status);
  const NOTES={main_prompt:'The main session has a new prompt; side questions start over.',main_session_moved:'The main session has a new prompt; side questions start over.',idle:'Closed after an hour without use.',expired:'Closed two hours after it began.',replaced:'Closed because another side question started.',device_disconnected:'The device disconnected; the side question was closed.',restart:'The device restarted; the side question was closed.'};
  function available(value){const worker=getData().workers?.find(w=>w.id===value?.nodeId);return Boolean(value&&['claude','codex'].includes(value.runtime)&&worker?.capabilities?.nativeSideAsk===1&&nativeId(value)&&value.workspace&&worker.online!==false);}
  function fillModels(){
   const worker=getData().workers?.find(w=>w.id===session?.nodeId),runtime=worker?.runtimes?.find(r=>r.type===session?.runtime),main=getModel(session)||session?.sessionConfiguration?.model||'';
   const keep=model.value;model.replaceChildren();const follow=el('option','',main||t('Follow the session'));follow.value='';model.append(follow);
   for(const m of runtime?.models||[]){if(m.id===main)continue;const o=el('option','',m.name||m.id);o.value=m.id;model.append(o);}
   model.value=[...model.options].some(o=>o.value===keep)?keep:'';
  }
  function setNote(text){note.hidden=!text;note.textContent=text?t(text):'';}
  function render(){
   if(!session)return;
   const questions=view?.questions||[];const sig=JSON.stringify([sessionKey(session),questions.map(q=>[q.id,q.status,q.text.length,q.events.length,q.error,q.endedAt]),notice,pending,uploads,files.map(f=>f.id)]);
   const busy=pending||questions.some(live);input.disabled=pending||sourceLoading;model.disabled=pending||sourceLoading;send.disabled=busy||sourceLoading||uploads>0||(!input.value.trim()&&!files.length);attach.disabled=busy||sourceLoading;clear.disabled=sourceLoading||!sideId&&!questions.length&&!pending&&!uploads&&!input.value&&!files.length;
   tray.replaceChildren();for(const f of files){const chip=el('div','attachment-card attachment-file-card');chip.title=f.name;const open=el('span','attachment-open');open.append(el('span','attachment-name',f.name),el('small','',formatBytes(f.size)));chip.append(open,closeIcon(button('',()=>{files=files.filter(x=>x.id!==f.id);render();},'attachment-remove'),t('Remove attachment')));tray.append(chip);}
   if(uploads)tray.append(el('span','attachment-uploading',t('Uploading attachments…')));tray.hidden=!tray.childElementCount;
   if(sig===signature)return;signature=sig;
   body.replaceChildren();
   if(notice)body.append(el('p','workspace-note native-ask-restarted',t(notice)));
   if(!questions.length){const empty=el('div','side-preview-empty');const icon=el('span','side-preview-empty-icon');icon.innerHTML=UI_ICON.sideAsk;empty.append(icon,el('p','',t('An independent side conversation. New messages in the main session do not interrupt it. It is temporary and can be cleared here.')));body.append(empty);return;}
   for(const q of questions){
    const files=q.attachments?.length?el('div','chat-attachments native-turn-files'):null;if(files)for(const a of q.attachments)files.append(el('span','attachment-name native-ask-file',a.name));
    body.append(...questionRows(q,session,files,live(q),preview,api));
   }
   const usage=[...questions].reverse().find(q=>q.contextUsage?.usedTokens)?.contextUsage?.usedTokens;
   if(usage)body.append(el('p','workspace-note native-ask-usage',t('Context about {tokens} tokens',{tokens:usage>=1000?`${Math.round(usage/1000)}k`:usage})));
   body.scrollTop=body.scrollHeight;
  }
  function stopPoll(){clearInterval(poll);poll=null;}
  function startPoll(){if(poll)return;poll=setInterval(()=>void refresh(),1000);}
  async function refresh(){
   if(!session||!sideId)return stopPoll();const asked=sideId,owner=sessionKey(session),ticket=generation;
   try{const next=await api(`${endpoint(session.nodeId)}/side/${encodeURIComponent(asked)}`);if(ticket!==generation||sideId!==asked||sessionKey(session)!==owner)return;
    if(next.closed){sideId=null;view=null;notice=NOTES[next.reason]||'';stopPoll();render();return;}
    view=next;notice=next.restarted?'The previous side conversation is unavailable; a new one has started.':notice;if(!next.questions.some(live))stopPoll();render();}
   catch(error){if(ticket===generation&&sideId===asked&&sessionKey(session)===owner)setNote(error.message);}
  }
  async function reset({tell=false,reason=''}={}){
   stopPoll();generation++;const old=sideId,owner=session;sideId=null;view=null;files=[];pending=false;input.disabled=false;model.disabled=false;uploads=0;notice=reason?NOTES[reason]||'':'';signature='';setNote('');
   if(tell&&old&&owner)void api(`${endpoint(owner.nodeId)}/side/${encodeURIComponent(old)}`,{method:'DELETE'}).catch(()=>{});
   render();
  }
  async function ask(){
   if(!session||pending||sourceLoading||view?.questions?.some(live))return;
   if(!available(session)){setNote('Device is offline or side questions are unavailable');return;}const prompt=input.value;if(!prompt.trim()&&!files.length)return;
   // Every async result belongs to the original session and this opening of its side panel, even after A -> B -> A.
   const owner=session,ticket=generation,current=()=>ticket===generation&&sessionKey(session)===sessionKey(owner);
   pending=true;input.disabled=true;model.disabled=true;setNote('');render();
   try{const next=await api(owner.sideEndpoint||`${endpoint(owner.nodeId)}/side`,{method:'POST',json:{...(owner.messageId?{conversationId:owner.conversationId}:{}),sideId,runtime:owner.runtime,sessionId:nativeId(owner),prompt,model:model.value||null,attachmentIds:files.map(f=>f.id)}});
    if(!current()){if(next.id)void api(`${endpoint(owner.nodeId)}/side/${encodeURIComponent(next.id)}`,{method:'DELETE'}).catch(()=>{});return;}
    if(next.id!==sideId&&sideId&&view?.questions?.length)notice='The previous side conversation is unavailable; a new one has started.';
    sideId=next.id;view=next;input.value='';files=[];startPoll();}
   catch(error){if(current())setNote(error.message);}
   finally{if(current()){pending=false;input.disabled=false;model.disabled=false;render();}}
  }
  async function upload(list){
   if(!session)return;const list2=[...list],owner=session,ticket=generation,current=()=>ticket===generation&&sessionKey(session)===sessionKey(owner);
   if(files.length+uploads+list2.length>6){setNote('At most 6 attachments per message');return;}
   if(list2.some(f=>!f.size||f.size>20*1024*1024)){setNote('Attachments cannot be empty; each file is limited to 20 MB');return;}
   uploads+=list2.length;render();
   for(const file of list2){if(!current())break;
    try{const item=await api(`${endpoint(owner.nodeId)}/attachments`,{method:'POST',body:file,headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(file.name||'pasted-image.png')}});
     if(!current()){void api(`${endpoint(owner.nodeId)}/attachments/${encodeURIComponent(item.id)}`,{method:'DELETE'}).catch(()=>{});return;}
     files.push({id:item.id,name:item.name,mime:item.mime,size:item.size});}
    catch(error){if(current())setNote(error.message);}finally{if(current()){uploads--;render();}}}
  }
  form.addEventListener('submit',e=>{e.preventDefault();void ask();});
  input.addEventListener('input',()=>{input.style.height='auto';input.style.height=`${Math.min(150,Math.max(70,input.scrollHeight))}px`;render();});
  input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&!send.disabled){e.preventDefault();void ask();}});
  input.addEventListener('paste',e=>{const list=[...(e.clipboardData?.files||[])];if(list.length){e.preventDefault();void upload(list);}});
  attach.addEventListener('click',()=>fileInput.click());fileInput.addEventListener('change',()=>{void upload(fileInput.files);fileInput.value='';});
  return {root,clear,available,
   setSourceLoading(value){sourceLoading=value;input.disabled=value;model.disabled=value;attach.disabled=value;send.disabled=value;clear.disabled=value;render();},
   hasUnsentOrBusy:()=>Boolean(input.value.trim()||files.length||uploads||pending||view?.questions?.some(live)),
   focus:()=>input.focus(),
   /** A different session starts a blank side question (the old one is closed); the same session keeps it. */
   attach(value){if(sessionKey(value)!==sessionKey(session)){const previous=session;void reset({tell:Boolean(previous)});input.value='';session=value;signature='';}else session=value;fillModels();render();},
   detach(){void reset({tell:true});session=null;input.value='';body.replaceChildren();}
  };
 }
