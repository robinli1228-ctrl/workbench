/** A read-only timeline: older pages never replace the selected native session or its controls. */
export function createNativeHistoryTimeline({scroll,readPage,renderMessage,label,t,onLatest}){
 const root=document.createElement('div'),bar=document.createElement('div'),more=document.createElement('button'),note=document.createElement('p'),latest=document.createElement('button'),skip=document.createElement('button');
 root.className='native-history-timeline';bar.className='native-history-loader';more.type=latest.type='button';more.className=latest.className='secondary';note.className='workspace-note';note.setAttribute('role','status');latest.textContent=t('Refresh latest history');latest.hidden=true;latest.onclick=onLatest;bar.append(more,note,latest);
 skip.type='button';skip.className='secondary';skip.textContent=t('Continue to earlier session');skip.hidden=true;bar.append(skip);
 let generation=0,chain=[],sections=[],index=0,busy=false,lastTop=0,touchY=null,failed=null;
 function section(item){const block=document.createElement('section'),heading=document.createElement('div'),history=document.createElement('div');heading.className='native-history-separator';heading.textContent=label(item);history.className='native-history';block.append(heading,history);return {item,block,history,messages:new Map(),cursor:null,initialized:false};}
 function controls(){const current=sections.at(-1),hasMore=Boolean(current?.initialized&&(current.cursor||index+1<chain.length));more.hidden=!hasMore;more.disabled=busy;more.textContent=t(busy?'Loading…':'Load older history');skip.hidden=!failed||!(chain[index+(failed.section===current?1:2)]);skip.disabled=busy;}
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
  if(busy||!sections.at(-1)?.initialized)return;const current=sections.at(-1),next=current.cursor?current:chain[index+1]?section(chain[index+1]):null;if(!next)return;
  const epoch=generation;busy=true;failed=null;note.textContent='';controls();
  try{
   const page=await readPage(next.item,next===current?current.cursor:null);if(epoch!==generation)return;
   const top=scroll.scrollTop,height=scroll.scrollHeight;
   merge(next,page,{older:true});if(next!==current){index++;sections.push(next);bar.after(next.block);}
   controls();scroll.scrollTop=top+scroll.scrollHeight-height;lastTop=scroll.scrollTop;
  }catch(error){if(epoch===generation){failed={section:next,error:error.message};note.textContent=`${label(next.item)}: ${t(error.message)}`;}}
  finally{if(epoch===generation){busy=false;controls();}}
 }
 more.onclick=()=>void loadOlder();
 // Skipping is a display-only choice; retain the failed section and its reason instead of deleting records.
 skip.onclick=()=>{if(!failed||busy)return;const target=failed.section,n=document.createElement('p');target.skippedError=failed.error;n.className='workspace-note';n.textContent=t(failed.error);target.history.append(n);target.initialized=true;target.cursor=null;if(target!==sections.at(-1)){sections.push(target);index++;bar.after(target.block);}failed=null;note.textContent='';controls();void loadOlder();};
 scroll.addEventListener('scroll',()=>{const top=scroll.scrollTop,up=top<lastTop;lastTop=top;if(up&&top<=80)void loadOlder();});
 scroll.addEventListener('wheel',event=>{if(event.deltaY<0&&scroll.scrollTop<=80)void loadOlder();},{passive:true});
 scroll.addEventListener('touchstart',event=>{touchY=event.touches[0]?.clientY??null;},{passive:true});
 scroll.addEventListener('touchmove',event=>{const y=event.touches[0]?.clientY;if(touchY!=null&&y>touchY&&scroll.scrollTop<=80)void loadOlder();touchY=y??null;},{passive:true});
 return {root,
  reset(item,older=[]){generation++;busy=false;failed=null;chain=[item,...older];index=0;sections=[section(item)];note.textContent='';latest.hidden=true;root.replaceChildren(bar,sections[0].block);controls();},
  clear(){generation++;busy=false;failed=null;chain=[];sections=[];root.replaceChildren();},
  showError(error){note.textContent=t(error.message);latest.hidden=false;},
  update(page){if(!sections.length)return null;const top=scroll.scrollTop;merge(sections[0],page);controls();scroll.scrollTop=top;lastTop=top;return sections[0].history;},
  syncScroll(){lastTop=scroll.scrollTop;}
 };
}
