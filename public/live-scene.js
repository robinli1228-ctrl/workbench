import {t,dateLocale} from './i18n.js';
import {closeIcon} from './role-icons.js';
import {partitionRunLog,mergeRunEvents,displayRunInput,shouldShowFinalResult,stripAnsi,toolStatusLabel} from './run-log-data.js';
import {executionProgress} from './execution-progress.js';
import {simplifiedCliOutput} from './output-language.js';

const finished=new Set(['succeeded','failed','interrupted']);
const text=value=>typeof value==='string'?value:value==null?'':JSON.stringify(value,null,2);
const node=(tag,cls,value)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(value!==undefined)e.textContent=value;return e;};
const time=value=>value?new Intl.DateTimeFormat(dateLocale(),{hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(value)):'';

/** A read-only projection of recorded events; a final snapshot is not appended a second time to its streamed reply. */
export function liveSceneRows(events,run={}) {
  // Native event previews are capped; ranges point to the complete parts in the existing text field.
  const source=events.map(event=>{
    if(event.type!=='message'||typeof run.text!=='string')return event;
    const range=run.replyRanges?.find(r=>r.messageId?r.messageId===event.payload?.messageId:r.seq===event.seq);
    if(!range||!Number.isInteger(range.offset)||!Number.isInteger(range.length)||range.offset<0||range.length<1||range.offset+range.length>run.text.length)return event;
    return {...event,payload:{...event.payload,text:run.text.slice(range.offset,range.offset+range.length)}};
  });
  const logs=partitionRunLog(source),rows=[];
  for(const event of logs.output) {
    const body=event.payload?.text||event.payload?.error?.message||'';
    if(!body)continue;
    const prior=rows.at(-1);
    if(event.type==='text'&&prior?.kind==='text'&&prior.seq===event.seq-1&&prior.messageId===event.payload?.messageId){prior.text+=body;prior.seq=event.seq;}
    else rows.push({key:`event:${event.id||event.seq}`,seq:event.seq,kind:event.type,text:body,messageId:event.payload?.messageId,phase:event.payload?.phase,aggregate:event.payload?.aggregate,createdAt:event.createdAt});
  }
  for(const tool of logs.tools)rows.push({key:`tool:${tool.item.id||tool.seq}`,seq:tool.seq,kind:'tool',item:tool.item,createdAt:tool.createdAt,updatedAt:tool.updatedAt});
  rows.sort((a,b)=>a.seq-b.seq);
  if(run.result&&shouldShowFinalResult(run.result,logs.output))rows.push({key:'stored-result',seq:Infinity,kind:'message',text:run.result,createdAt:run.finishedAt});
  return {input:logs.input,rows};
}

/** Viewing issues GETs only. Closing aborts reads, never the Run; the dialog stays pinned to its original project and Run. */
export function createLiveScene({api,getProjectId,onNewSession,onResumeSession}) {
  let dialog,view,version=0,timer,controller;
  function close(){version++;clearTimeout(timer);controller?.abort();controller=null;view=null;if(dialog?.open)dialog.close();}
  function ensureDialog(){
    if(dialog)return;
    dialog=node('dialog','live-scene');dialog.setAttribute('aria-label',t('Live execution'));
    dialog.addEventListener('close',()=>{if(!dialog.open)close();});document.body.append(dialog);
  }
  function part(label,value,open=false){const d=node('details','live-scene-part');d.open=open;d.append(node('summary','',t(label)),node('pre','',stripAnsi(text(value))));return d;}
  function draw(){
    const v=view;if(!v)return;
    const atBottom=v.follow,scroll=v.body.scrollTop,opened=new Set([...v.body.querySelectorAll('details[open]')].map(e=>e.dataset.key));
    const model=liveSceneRows(v.events,v.run),input=displayRunInput(v.task,model.input);
    const layout=[],keys=new Set();v.rendered||=new Map();
    const keep=(key,value,element)=>{const fingerprint=JSON.stringify(value),old=v.rendered.get(key);keys.add(key);if(old?.fingerprint===fingerprint)element=old.element;else v.rendered.set(key,{fingerprint,element});layout.push(element);};
    v.heading.textContent=t('Live execution · {name}',{name:v.name||v.run.roleSnapshot?.name||v.run.roleId||''});
    v.status.textContent=[t(executionProgress({run:v.run}).label),v.run.runtime||v.run.roleSnapshot?.runtime,v.run.model||v.run.roleSnapshot?.model,v.run.nodeId].filter(Boolean).join(' · ');
    const entry=node('details','live-scene-input');entry.dataset.key='input';entry.open=opened.has('input');
    entry.append(node('summary','',t(input.complete?'Dispatched input (read-only)':'Input snapshot unavailable; original task only')));
    if(input.instructions){const rules=part('Additional instructions',input.instructions);rules.dataset.key='instructions';rules.open=opened.has('instructions');entry.append(rules);}
    if(input.instructionsInheritedFrom)entry.append(node('p','',t('Instructions inherited from Run {id}; not resent this turn.',{id:input.instructionsInheritedFrom})));
    if(input.configurationUpdate)entry.append(part('Configuration event',input.configurationUpdate));
    entry.append(node('h4','',t('Task input')),node('pre','',input.prompt||t('No dispatched input yet')));keep('input',input,entry);
    for(const row of model.rows){
      const card=node('section',`live-scene-event is-${row.kind}`);card.dataset.key=row.key;
      const header=node('header',''),label=row.kind==='tool'?'Tool execution':row.kind==='log'||row.kind==='error'?'Runtime event':'Agent output';
      header.append(node('strong','',t(label)),node('time','',time(row.createdAt)));card.append(header);
      if(row.kind==='tool'){
        const item=row.item;
        card.append(node('div','live-scene-tool-name',text(item.name||item.command||item.title||item.type||t('Tool'))),node('span','live-scene-tool-state',t(toolStatusLabel(item,v.run.status))));
        for(const [name,value] of [['Arguments',item.input??item.arguments??item.parameters],['Changes',item.changes],['Output',item.aggregatedOutput??item.output??item.results??item.result],['Error',item.error]]){
          if(value===undefined||value===null||value==='')continue;
          card.append(node('h4','',t(name)),node('pre','',stripAnsi(text(value))));
        }
        if(item.outputTruncated)card.append(node('p','live-scene-warning',t('Tool output is truncated; only the recorded portion is shown.')));
        else if(item.aggregatedOutput==null&&item.output==null&&item.results==null&&item.result==null&&item.error==null)card.append(node('p','live-scene-empty',t('No tool output recorded yet')));
        if(item.exitCode!=null)card.append(node('small','',t('Exit code {exitCode}',{exitCode:item.exitCode})));
      }else card.append(node('pre','',row.kind==='text'||row.kind==='message'?simplifiedCliOutput(stripAnsi(row.text)):stripAnsi(row.text)));
      keep(row.key,[row,v.run.status],card);
    }
    if(!model.rows.length)keep('empty','empty',node('p','live-scene-empty',t('Waiting for recorded execution events…')));
    // Preserve unchanged DOM while new events arrive, so reading/selection and expanded input are not reset.
    let cursor=v.body.firstChild;
    for(const element of layout){if(cursor===element)cursor=cursor.nextSibling;else v.body.insertBefore(element,cursor);}
    while(cursor){const next=cursor.nextSibling;cursor.remove();cursor=next;}
    for(const key of v.rendered.keys())if(!keys.has(key))v.rendered.delete(key);
    v.body.scrollTop=atBottom?v.body.scrollHeight:scroll;
  }
  async function poll(generation){
    const v=view;if(!v||generation!==version||!dialog.open)return;
    if(getProjectId()!==v.projectId){close();return;}
    controller=new AbortController();const currentController=controller;
    const timeout=setTimeout(()=>currentController.abort(),15000);
    try{
      const result=await api(`/api/runs/${encodeURIComponent(v.runId)}/events?after=${v.after}&limit=250`,{signal:currentController.signal});
      if(generation!==version||view!==v)return;
      v.events=mergeRunEvents(v.events,result.events||[]);v.after=v.events.at(-1)?.seq||0;
      if(result.runState)v.run={...v.run,...result.runState};
      draw();
      v.connection.textContent=t(result.hasMore?'Loading recorded events…':finished.has(v.run.status)?'This run ended; the recorded scene remains read-only.':'Live · read-only; closing does not stop the Agent');
      if(result.hasMore||!finished.has(v.run.status))timer=setTimeout(()=>void poll(generation),result.hasMore?0:1000);
    }catch(error){
      if(generation!==version||view!==v)return;
      v.connection.textContent=t('Connection interrupted; retrying. Received events are kept.');
      timer=setTimeout(()=>void poll(generation),3000);
    }finally{clearTimeout(timeout);if(controller===currentController)controller=null;}
  }
  async function open(runId,{projectId,name,role}={}){
    close();ensureDialog();const generation=version;
    const heading=node('h2','',t('Live execution')),status=node('p','live-scene-status',''),connection=node('p','live-scene-connection',t('Loading recorded events…'));
    const body=node('div','live-scene-body'),header=node('div','live-scene-heading'),titles=node('div','');titles.append(heading,status);
    const actions=node('div','live-scene-actions'),follow=node('button','icon-button'),exit=closeIcon(node('button','icon-button'),t('Close'));
    // These entries only open confirmation forms; viewing the scene never acquires a terminal.
    for(const [label,handler] of [['New session',onNewSession],['Resume session',onResumeSession]]){
      if(!role||!handler)continue;
      const button=node('button','secondary compact',t(label));button.type='button';
      button.onclick=()=>{close();handler(role);};actions.append(button);
    }
    follow.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M5 20h14"/></svg>';
    follow.title=t('Jump to bottom');follow.setAttribute('aria-label',t('Jump to bottom'));
    follow.type=exit.type='button';exit.setAttribute('aria-label',t('Close'));exit.onclick=close;
    const v={runId,projectId:projectId||getProjectId(),name,heading,status,connection,body,events:[],after:0,follow:true,run:{},task:{}};view=v;
    follow.setAttribute('aria-pressed','true');follow.onclick=()=>{v.follow=true;follow.setAttribute('aria-pressed','true');body.scrollTop=body.scrollHeight;};
    body.addEventListener('scroll',()=>{v.follow=body.scrollHeight-body.scrollTop-body.clientHeight<48;follow.setAttribute('aria-pressed',String(v.follow));});
    actions.append(follow,exit);header.append(titles,actions);dialog.replaceChildren(header,connection,body);dialog.showModal();exit.focus();
    if(!runId){
      heading.textContent=t('Live execution · {name}',{name:name||role?.name||''});
      status.textContent=[role?.runtime,role?.model].filter(Boolean).join(' · ');
      connection.textContent=t('No recorded execution yet.');follow.disabled=true;
      return;
    }
    await load(generation);
  }
  async function load(generation){
    const v=view;if(!v||generation!==version||!dialog.open)return;
    if(getProjectId()!==v.projectId){close();return;}
    controller=new AbortController();const initial=controller,timeout=setTimeout(()=>initial.abort(),15000);
    try{
      const detail=await api(`/api/runs/${encodeURIComponent(v.runId)}/detail`,{signal:initial.signal});
      if(generation!==version||view!==v)return;
      if(detail.run?.projectId!==v.projectId){v.connection.textContent=t('Could not load this run: {message}',{message:'Run does not belong to this project'});return;}
      v.run=detail.run;v.task=detail.task||{};draw();void poll(generation);
    }catch(error){if(generation===version&&view===v){v.connection.textContent=t('Connection interrupted; retrying. Received events are kept.');timer=setTimeout(()=>void load(generation),3000);}}
    finally{clearTimeout(timeout);if(controller===initial)controller=null;}
  }
  return {open,close};
}
