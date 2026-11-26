import {t} from './i18n.js';

const ARROW='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="m6 13 6 6 6-6"/></svg>';

/**
 * "Back to bottom": a round button at the bottom right of a chat's scroll area, shown once it is scrolled up by more than one
 * screen and gone again near the bottom. It sits in a stable ancestor (`host`) and follows the scroll area's own bottom and
 * right edges, so it stays just above the composer and its tray whatever their height, and survives the scroll area's
 * content being replaced. A click scrolls smoothly to the latest message.
 */
export function attachJumpToBottom(scroller,host=scroller.parentElement) {
  if(!scroller||!host)return null;
  if(getComputedStyle(host).position==='static')host.style.position='relative';
  const button=document.createElement('button');button.type='button';button.className='jump-to-bottom';button.innerHTML=ARROW;
  const label=()=>{const text=t('Back to bottom');button.title=text;button.setAttribute('aria-label',text);};label();
  host.append(button);
  let frame=0;
  const place=()=>{frame=0;
    const shown=scroller.isConnected&&scroller.clientHeight>0&&scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight>scroller.clientHeight;
    button.classList.toggle('is-shown',shown);button.tabIndex=shown?0:-1;button.setAttribute('aria-hidden',String(!shown));
    if(!shown)return;
    const box=host.getBoundingClientRect(),area=scroller.getBoundingClientRect();
    button.style.bottom=`${Math.max(0,box.bottom-area.bottom)+14}px`;button.style.right=`${Math.max(0,box.right-area.right)+16}px`;
  };
  const update=()=>{if(!frame)frame=requestAnimationFrame(place);};
  scroller.addEventListener('scroll',update,{passive:true});
  const sizes=new ResizeObserver(update);sizes.observe(scroller);sizes.observe(host);
  // New messages make the content taller without a scroll event.
  new MutationObserver(update).observe(scroller,{childList:true,subtree:true});
  button.addEventListener('click',()=>{scroller.scrollTo({top:scroller.scrollHeight,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});button.blur();});
  return {update,label};
}
