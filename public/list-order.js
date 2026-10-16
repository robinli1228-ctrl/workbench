import {t} from './i18n.js';

const PREFIX='agent-workbench.list-order.v1.';
const ids=values=>Array.isArray(values)?[...new Set(values.filter(value=>typeof value==='string'&&value.length>0&&value.length<=1000))]:[];

/** Reuse the same saved presentation order when snapshotting a team from any project row. */
export function readListOrder(scope){try{return ids(JSON.parse(localStorage.getItem(PREFIX+scope)||'[]'));}catch{return [];}}

/** Filtered-out sessions keep their slots; reordering one view never discards other devices' saved positions. */
export function mergeListOrder(previous,before,after) {
  const visible=new Set(before),pool=ids([...previous,...before]);let index=0;
  return pool.map(id=>visible.has(id)?after[index++]:id);
}

/** Manual order overrides arrival/activity order while new entries retain their relative order at the end. */
export function orderedItems(items,order,key=item=>item.id) {
  const ranks=new Map(order.map((id,index)=>[id,index]));
  return [...items].sort((a,b)=>(ranks.get(key(a))??Infinity)-(ranks.get(key(b))??Infinity));
}

/** Long press is local presentation unless `persist` hands the new order to Home. Pending gestures defer live rerenders; release never clicks a moved card. */
export function createListOrder({container,scope,onEnd=()=>{},onError=()=>{},persist=null}) {
  let gesture=null,frame=0,suppressClickUntil=0;
  const storageKey=()=>PREFIX+(typeof scope==='function'?scope():scope);
  const read=key=>{try{return ids(JSON.parse(localStorage.getItem(key)||'[]'));}catch{return [];}};
  const items=()=>[...container.children].filter(item=>item.dataset.orderId);
  const announce=document.createElement('p');announce.className='list-order-announcement';announce.setAttribute('role','status');announce.setAttribute('aria-live','polite');document.body.append(announce);

  function scrollParent() {
    for(let node=container;node;node=node.parentElement)if(/auto|scroll/.test(getComputedStyle(node).overflowY)&&node.scrollHeight>node.clientHeight+1)return node;
    return document.scrollingElement;
  }
  function relocate() {
    const g=gesture;if(!g?.started)return;
    g.ghost.style.left=`${g.x-g.offsetX}px`;g.ghost.style.top=`${g.y-g.offsetY}px`;
    if(!g.moved)return;
    const peers=items().filter(item=>item!==g.item),next=peers.find(item=>{const r=item.getBoundingClientRect();return g.y<r.top+r.height/2;});
    if(next)container.insertBefore(g.item,next);else if(peers.length)peers.at(-1).after(g.item);
  }
  function scrollTick(time) {
    const g=gesture;if(!g?.started)return;
    const rect=g.scroller===document.scrollingElement?{top:0,bottom:innerHeight}:g.scroller.getBoundingClientRect();
    const edge=48,top=Math.max(rect.top,0),bottom=Math.min(rect.bottom,innerHeight),bounds=container.getBoundingClientRect();
    const distance=g.y<top+edge?-Math.min(edge,top+edge-g.y):g.y>bottom-edge?Math.min(edge,g.y-bottom+edge):0;
    if(g.moved&&g.x>=bounds.left&&g.x<=bounds.right&&distance){const previous=g.scroller.scrollTop;g.scroller.scrollTop+=distance/edge*Math.min(32,time-(g.lastFrame||time))*0.6;if(g.scroller.scrollTop!==previous)relocate();}
    g.lastFrame=time;frame=requestAnimationFrame(scrollTick);
  }
  function begin() {
    const g=gesture;if(!g||!g.item.isConnected||!container.getClientRects().length||items().length<2)return finish(false);
    const rect=g.item.getBoundingClientRect();g.started=true;g.before=items().map(item=>item.dataset.orderId);g.scroller=scrollParent();
    g.initialScroll=g.scroller.scrollTop;
    g.offsetX=g.x-rect.left;g.offsetY=g.y-rect.top;
    g.ghost=g.item.cloneNode(true);g.ghost.removeAttribute('id');for(const el of g.ghost.querySelectorAll('[id]'))el.removeAttribute('id');
    g.ghost.classList.add('list-order-ghost');g.ghost.setAttribute('aria-hidden','true');g.ghost.inert=true;g.ghost.style.width=`${rect.width}px`;document.body.append(g.ghost);
    g.item.classList.add('list-order-placeholder');container.classList.add('is-reordering');document.body.classList.add('is-list-reordering');
    window.getSelection()?.removeAllRanges();
    try{container.setPointerCapture(g.pointerId);}catch{}
    announce.textContent=t('Drag to change the order. Release to save; Escape to cancel.');relocate();frame=requestAnimationFrame(scrollTick);
  }
  function finish(save) {
    const g=gesture;if(!g)return;gesture=null;clearTimeout(g.timer);cancelAnimationFrame(frame);let saved=false;
    if(g.started){
      suppressClickUntil=performance.now()+500;
      const after=items().map(item=>item.dataset.orderId),bounds=container.getBoundingClientRect();
      const inside=g.x>=bounds.left-24&&g.x<=bounds.right+24&&g.y>=bounds.top-24&&g.y<=bounds.bottom+24;
      if(save&&inside&&g.key===storageKey()&&JSON.stringify(after)!==JSON.stringify(g.before)&&persist){
        saved=true;announce.textContent=t('Queue order saved.');
        Promise.resolve().then(()=>persist(after,g.before)).catch(error=>onError(error?.message||String(error)));
      } else if(save&&inside&&g.key===storageKey()&&JSON.stringify(after)!==JSON.stringify(g.before)){
        try{localStorage.setItem(g.key,JSON.stringify(mergeListOrder(read(g.key),g.before,after)));saved=true;announce.textContent=t('Order saved in this browser.');}
        catch{announce.textContent=t('Could not save the order in this browser.');onError(announce.textContent);}
      }
      g.ghost.remove();g.item.classList.remove('list-order-placeholder');container.classList.remove('is-reordering');document.body.classList.remove('is-list-reordering');
      try{if(container.hasPointerCapture(g.pointerId))container.releasePointerCapture(g.pointerId);}catch{}
    }
    // Click follows pointerup; rebuilding synchronously here would swallow an ordinary short click.
    const scroll=saved?g.scroller.scrollTop:g.initialScroll;
    requestAnimationFrame(()=>{onEnd();if(g.started&&g.key===storageKey()&&g.scroller.isConnected){g.scroller.scrollTop=scroll;items().find(item=>item.dataset.orderId===g.item.dataset.orderId)?.focus({preventScroll:true});}});
  }
  container.addEventListener('pointerdown',event=>{
    if(gesture){finish(false);return;}
    suppressClickUntil=0;
    if(!event.isPrimary||event.button!==0||document.querySelector('dialog[open]'))return;
    const item=event.target.closest('[data-order-id]');if(!item||item.parentElement!==container||items().length<2)return;
    const control=event.target.closest('button,a,input,textarea,select,summary,[contenteditable="true"],[role="button"]');
    if(control&&control!==item)return;
    gesture={item,pointerId:event.pointerId,key:storageKey(),x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY};
    gesture.timer=setTimeout(begin,420);
  });
  document.addEventListener('pointermove',event=>{
    const g=gesture;if(!g||event.pointerId!==g.pointerId)return;g.x=event.clientX;g.y=event.clientY;
    if(!g.started){if(Math.hypot(g.x-g.startX,g.y-g.startY)>8)finish(false);return;}
    if(event.cancelable)event.preventDefault();g.moved||=Math.hypot(g.x-g.startX,g.y-g.startY)>8;relocate();
  },{passive:false});
  document.addEventListener('pointerup',event=>{if(event.pointerId===gesture?.pointerId)finish(true);});
  document.addEventListener('pointercancel',event=>{if(event.pointerId===gesture?.pointerId)finish(false);});
  // Register before touch scrolling starts; quick swipes remain native, only an activated hold consumes movement.
  container.addEventListener('touchmove',event=>{if(event.touches.length!==1){finish(false);return;}if(gesture?.started&&event.cancelable)event.preventDefault();},{passive:false});
  container.addEventListener('touchstart',event=>{if(event.touches.length>1)finish(false);},{passive:true});
  container.addEventListener('contextmenu',event=>{if(gesture)event.preventDefault();});
  container.addEventListener('dragstart',event=>{if(event.target.closest('[data-order-id]'))event.preventDefault();});
  container.addEventListener('click',event=>{if(performance.now()<suppressClickUntil){event.preventDefault();event.stopImmediatePropagation();}},{capture:true});
  document.addEventListener('keydown',event=>{if(gesture&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();finish(false);}},{capture:true});
  window.addEventListener('blur',()=>finish(false));
  document.addEventListener('visibilitychange',()=>{if(document.hidden)finish(false);});
  window.addEventListener('storage',event=>{if(event.key===storageKey()&&!gesture)onEnd();});
  return {active:()=>Boolean(gesture),ordered:(values,key)=>orderedItems(values,read(storageKey()),key),seedInitialOrder(order){
    try{if(localStorage.getItem(storageKey())===null)localStorage.setItem(storageKey(),JSON.stringify(ids(order)));}catch{onError(t('Could not save the order in this browser.'));}
  }};
}
