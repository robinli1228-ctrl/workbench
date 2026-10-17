/** A read-only timeline: older pages never replace the selected native session or its controls. */
export function createNativeHistoryTimeline({scroll,readPage,renderMessage,label,t,onLatest}){
 const root=document.createElement('div'),bar=document.createElement('div'),more=document.createElement('button'),note=document.createElement('p'),latest=document.createElement('button'),skip=document.createElement('button');
 root.className='native-history-timeline';bar.className='native-history-loader';more.type=latest.type='button';more.className=latest.className='secondary';note.className='workspace-note';note.setAttribute('role','status');latest.textContent=t('Refresh latest history');latest.hidden=true;latest.onclick=onLatest;bar.append(more,note,latest);
 skip.type='button';skip.className='secondary';skip.textContent=t('Continue to earlier session');skip.hidden=true;bar.append(skip);
 let generation=0,chain=[],sections=[],busy=false,lastTop=0,touchY=null,failed=null;
 const identity=item=>JSON.stringify([item.nodeId,item.runtime,item.sessionId||item.id]);
 const nextPage=()=>{for(const item of chain){const loaded=sections.find(s=>identity(s.item)===identity(item));if(!loaded||loaded.cursor)return {item,loaded};}return null;};
 // Reuse loaded section nodes; late catalogues can insert an intermediate session without losing older cursors.
 function placeSections(){const ranks=new Map(chain.map((item,i)=>[identity(item),i]));sections.sort((a,b)=>ranks.get(identity(a.item))-ranks.get(identity(b.item)));root.replaceChildren(bar,...sections.toReversed().map(s=>s.block));}
 function section(item){const block=document.createElement('section'),heading=document.createElement('div'),history=document.createElement('div');heading.className='native-history-separator';heading.textContent=label(item);history.className='native-history';block.append(heading,history);return {item,block,history,messages:new Map(),cursor:null,initialized:false};}
 function controls(){const hasMore=Boolean(sections[0]?.initialized&&nextPage());more.hidden=!hasMore;more.disabled=busy;more.textContent=t(busy?'Loading…':'Load older history');skip.hidden=!failed||!chain.slice(chain.findIndex(item=>identity(item)===identity(failed.section.item))+1).some(item=>{const loaded=sections.find(s=>identity(s.item)===identity(item));return !loaded||loaded.cursor;});skip.disabled=busy;}
 function merge(target,page,{older=false}={}){
  const rows=page.messages||[],prior=[...target.messages.values()];
  // Do not silently bridge an unobserved burst while the reader is in loaded history.
  if(!older&&prior.length&&page.historyPage===1&&rows.length&&rows[0].offset>prior.reduce((max,m)=>Math.max(max,m.offset),0)){note.textContent=t('Newer messages are available. Refresh latest history to read them.');latest.hidden=false;return;}
  if(page.historyPage!==1)target.messages.clear();
  rows.forEach((m,i)=>target.messages.set(m.id||String(i),m));
  const ordered=[...target.messages.values()].sort((a,b)=>(a.offset??0)-(b.offset??0));target.history.replaceChildren(...ordered.map(m=>renderMessage(m,target.item)));
  if(page.notice||target.skippedError){const n=document.createElement('p');n.className='workspace-note';n.textContent=t(page.notice||target.skippedError);target.history.append(n);}
  if(!target.initialized||older){target.cursor=page.nextCursor||null;target.initialized=true;}
 }
 async function loadOlder(){
  if(busy||!sections[0]?.initialized)return;const target=nextPage();if(!target)return;const next=target.loaded||section(target.item);
  const epoch=generation;busy=true;failed=null;note.textContent='';controls();
  try{
   const page=await readPage(next.item,target.loaded?.cursor||null);if(epoch!==generation)return;
   const top=scroll.scrollTop,height=scroll.scrollHeight,edge=scroll.getBoundingClientRect().top;
   const anchor=[...root.querySelectorAll('.native-history > *')].find(node=>node.getBoundingClientRect().bottom>=edge),anchorTop=anchor?.getBoundingClientRect().top;
   merge(next,page,{older:true});if(!target.loaded){sections.push(next);placeSections();}
   controls();if(anchor?.isConnected)scroll.scrollTop+=anchor.getBoundingClientRect().top-anchorTop;else scroll.scrollTop=top+scroll.scrollHeight-height;lastTop=scroll.scrollTop;
  }catch(error){if(epoch===generation){failed={section:next,error:error.message};note.textContent=`${label(next.item)}: ${t(error.message)}`;}}
  finally{if(epoch===generation){busy=false;controls();}}
 }
 more.onclick=()=>void loadOlder();
 // Skipping is a display-only choice; retain the failed section and its reason instead of deleting records.
 skip.onclick=()=>{if(!failed||busy)return;const target=failed.section,n=document.createElement('p');target.skippedError=failed.error;n.className='workspace-note';n.textContent=t(failed.error);target.history.append(n);target.initialized=true;target.cursor=null;if(!sections.includes(target)){sections.push(target);placeSections();}failed=null;note.textContent='';controls();void loadOlder();};
 scroll.addEventListener('scroll',()=>{const top=scroll.scrollTop,up=top<lastTop;lastTop=top;if(up&&top<=80)void loadOlder();});
 scroll.addEventListener('wheel',event=>{if(event.deltaY<0&&scroll.scrollTop<=80)void loadOlder();},{passive:true});
 scroll.addEventListener('touchstart',event=>{touchY=event.touches[0]?.clientY??null;},{passive:true});
 scroll.addEventListener('touchmove',event=>{const y=event.touches[0]?.clientY;if(touchY!=null&&y>touchY&&scroll.scrollTop<=80)void loadOlder();touchY=y??null;},{passive:true});
 return {root,
  reset(item,older=[]){generation++;busy=false;failed=null;chain=[item,...older];sections=[section(item)];note.textContent='';latest.hidden=true;root.replaceChildren(bar,sections[0].block);controls();},
  /** Extend the selected session's lineage without resetting messages, an in-flight page or the reader's scroll. */
  setOlder(item,older){if(!sections.length||identity(sections[0].item)!==identity(item))return;chain=[...new Map([chain[0],...older,...chain.slice(1)].map(value=>[identity(value),value])).values()];controls();},
  clear(){generation++;busy=false;failed=null;chain=[];sections=[];root.replaceChildren();},
  showError(error){note.textContent=t(error.message);latest.hidden=false;},
  update(page){if(!sections.length)return null;const top=scroll.scrollTop;merge(sections[0],page);controls();scroll.scrollTop=top;lastTop=top;return sections[0].history;},
  syncScroll(){lastTop=scroll.scrollTop;}
 };
}
