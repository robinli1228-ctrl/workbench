import {highlightLatestChatCard} from './chat-card-state.js';
/** A read-only timeline: older pages never replace the selected native session or its controls. */
export function createNativeHistoryTimeline({scroll,readPage,renderMessage,renderMessages=(rows,item)=>rows.map(m=>renderMessage(m,item)),label,t,onLatest,onHistoryChange=()=>{}}){
 const root=document.createElement('div'),bar=document.createElement('div'),more=document.createElement('button'),note=document.createElement('p'),latest=document.createElement('button'),skip=document.createElement('button');
 root.className='native-history-timeline';bar.className='native-history-loader';more.type=latest.type='button';more.className=latest.className='secondary';note.className='workspace-note';note.setAttribute('role','status');latest.textContent=t('Refresh latest history');latest.hidden=true;latest.onclick=onLatest;bar.append(more,note,latest);
 skip.type='button';skip.className='secondary';skip.textContent=t('Continue to earlier session');skip.hidden=true;bar.append(skip);
 let generation=0,chain=[],sections=[],busy=false,failed=null,readError=null,olderNotice=null,newerAvailable=false;
 const identity=item=>JSON.stringify([item.nodeId,item.runtime,item.sessionId||item.id]);
 const nextPage=()=>{for(const item of chain){const loaded=sections.find(s=>identity(s.item)===identity(item));if(!loaded||loaded.cursor)return {item,loaded};}return null;};
 // Reuse loaded section nodes; late catalogues can insert an intermediate session without losing older cursors.
 function placeSections(){const ranks=new Map(chain.map((item,i)=>[identity(item),i]));sections.sort((a,b)=>ranks.get(identity(a.item))-ranks.get(identity(b.item)));root.replaceChildren(bar,...sections.toReversed().map(s=>s.block));highlightLatestChatCard(scroll);}
 function section(item){const block=document.createElement('section'),heading=document.createElement('div'),history=document.createElement('div');heading.className='native-history-separator';heading.textContent=label(item);history.className='native-history';block.append(heading,history);return {item,block,history,messages:new Map(),cursor:null,initialized:false,turnStartedAt:null};}
 /** 最新页恢复不应清除更早分页的失败，也不能丢失未读消息断层提示。 */
 function renderNote(){const error=failed?`${label(failed.section.item)}: ${t(failed.error)}`:readError;note.className=error?'workspace-note chat-bubble is-error-card':'workspace-note';note.textContent=error||olderNotice||(newerAvailable?t('Newer messages are available. Refresh latest history to read them.'):'');latest.hidden=!readError&&!newerAvailable;}
 /** 内容未变时也独立清除读取错误，不重建历史节点或重置分页。 */
 function readSucceeded(){readError=null;renderNote();}
 function controls(){renderNote();const hasMore=Boolean(sections[0]?.initialized&&nextPage());more.hidden=!hasMore;more.disabled=busy;more.textContent=t(busy?'Loading…':'Load older history');skip.hidden=!failed||!chain.slice(chain.findIndex(item=>identity(item)===identity(failed.section.item))+1).some(item=>{const loaded=sections.find(s=>identity(s.item)===identity(item));return !loaded||loaded.cursor;});skip.disabled=busy;}
 function merge(target,page,{older=false}={}){
  const rows=page.messages||[],prior=[...target.messages.values()];
  // Empty progress pages advance the cursor without rebuilding the rows the user is reading.
  if(older&&page.historyPage===1&&!rows.length){target.cursor=page.nextCursor||null;target.initialized=true;return;}
  // Do not silently bridge an unobserved burst while the reader is in loaded history.
  // (Rows appended right after the loaded ones, a `delta`, are contiguous by construction and join directly.)
  if(!older&&!page.delta&&prior.length&&page.historyPage===1&&rows.length&&rows[0].offset>prior.reduce((max,m)=>Math.max(max,m.offset),0)){newerAvailable=true;return;}
  if(page.historyPage!==1)target.messages.clear();
  rows.forEach((m,i)=>target.messages.set(m.id||String(i),m));
  // The oldest page read decides where the loaded rows begin; a refresh of the latest page never moves that start.
  if(!target.initialized||older)target.turnStartedAt=page.turnStartedAt||null;
  const ordered=[...target.messages.values()].sort((a,b)=>(a.offset??0)-(b.offset??0)),nodes=renderMessages(ordered,target.item,{turnStartedAt:target.turnStartedAt});
  // Unchanged turns come back as the same nodes; when nothing changed at all, the list is left alone (the feed's own
  // anchored rows, day lines and notes stay where they are). Otherwise the list is swapped, reusing those nodes.
  // The notice line under the rows is the timeline's own: it is replaced on its own and never forces the rows to be swapped.
  for(const old of target.history.querySelectorAll(':scope > .native-history-notice'))old.remove();
  const owned=[...target.history.children].filter(node=>!node.matches('.native-turn-anchored,.nt-day,.nt-interruption-note'));
  if(owned.length!==nodes.length||owned.some((node,i)=>node!==nodes[i]))target.history.replaceChildren(...nodes);
  if(page.notice||target.skippedError){const n=document.createElement('p');n.className=`${target.skippedError?'workspace-note chat-bubble is-error-card':'workspace-note'} native-history-notice`;n.textContent=t(page.notice||target.skippedError);target.history.append(n);}
  if(!target.initialized||older){target.cursor=page.nextCursor||null;target.initialized=true;}highlightLatestChatCard(scroll);
 }
 async function loadOlder(){
  if(busy||!sections[0]?.initialized)return;const target=nextPage();if(!target)return;const next=target.loaded||section(target.item);
  const epoch=generation;busy=true;failed=null;controls();
  try{
   const page=await readPage(next.item,target.loaded?.cursor||null);if(epoch!==generation)return;
   const top=scroll.scrollTop,height=scroll.scrollHeight,edge=scroll.getBoundingClientRect().top;
   const anchor=[...root.querySelectorAll('.native-history > :not(.nt-day)')].find(node=>node.getBoundingClientRect().bottom>=edge),anchorTop=anchor?.getBoundingClientRect().top;
   olderNotice=!page.messages?.length&&page.nextCursor?t(page.notice||'No displayable messages in this portion. Earlier history remains; click Load older history to continue.'):null;
   merge(next,page,{older:true});if(!target.loaded){sections.push(next);placeSections();}onHistoryChange();
   controls();if(anchor?.isConnected)scroll.scrollTop+=anchor.getBoundingClientRect().top-anchorTop;else scroll.scrollTop=top+scroll.scrollHeight-height;
  }catch(error){if(epoch===generation)failed={section:next,error:error.message};}
  finally{if(epoch===generation){busy=false;controls();}}
 }
 more.onclick=()=>void loadOlder();
 // Skipping is a display-only choice; retain the failed section and its reason instead of deleting records.
 skip.onclick=()=>{if(!failed||busy)return;const target=failed.section,n=document.createElement('p');target.skippedError=failed.error;n.className='workspace-note chat-bubble is-error-card';n.textContent=t(failed.error);target.history.append(n);target.initialized=true;target.cursor=null;if(!sections.includes(target)){sections.push(target);placeSections();}failed=null;controls();void loadOlder();};
 // 更早记录只由按钮加载；滚动和触摸仅改变阅读位置，不触发额外历史查询。
 // Page-turn visibility belongs to the selected session; another session's unread pages cannot hide its saved turns.
 return {root,hasOlder:()=>Boolean(sections[0]?.cursor),
  reset(item,older=[]){generation++;busy=false;failed=readError=olderNotice=null;newerAvailable=false;chain=[item,...older];sections=[section(item)];root.replaceChildren(bar,sections[0].block);controls();},
  /** Extend the selected session's lineage without resetting messages, an in-flight page or the reader's scroll. */
  setOlder(item,older){if(!sections.length||identity(sections[0].item)!==identity(item))return;chain=[...new Map([chain[0],...older,...chain.slice(1)].map(value=>[identity(value),value])).values()];controls();},
  clear(){generation++;busy=false;failed=readError=olderNotice=null;newerAvailable=false;chain=[];sections=[];root.replaceChildren();},
  showError(error){readError=t(error.message);renderNote();},
  readSucceeded,
  update(page){if(!sections.length)return null;readSucceeded();const top=scroll.scrollTop;merge(sections[0],page);controls();scroll.scrollTop=top;return sections[0].history;}
 };
}
