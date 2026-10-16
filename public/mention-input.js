/** Match actual role names with the same textual boundaries used by chat routing; ordinary email addresses stay plain. */
export function roleMentionRanges(text,names) {
  const known=new Set(names),ranges=[];
  for(const m of text.matchAll(/(^|[\s,.!?;:(\u3001\uFF0C\u3002\uFF01\uFF1F\uFF1B\uFF1A\uFF08])@([\p{L}\p{N}_-]+)/gu)){
    if(known.has(m[2])){const start=m.index+m[1].length;ranges.push({start,end:start+m[2].length+1,name:m[2]});}
  }
  return ranges;
}

/** Any edit intersecting part of a role consumes the whole label, including partial selections and word deletion. */
export function mentionEditRange(text,ranges,start,end,type) {
  let from=start,to=end;
  if(start===end&&type.startsWith('delete')){
    if(/Backward$/.test(type))from=type==='deleteWordBackward'?(text.slice(0,start).match(/\S+\s*$/)?.index??Math.max(0,start-1)):Math.max(0,start-1);
    else if(/Forward$/.test(type))to=type==='deleteWordForward'?start+(text.slice(start).match(/^\s*\S+/)?.[0].length??1):Math.min(text.length,start+1);
  }
  for(const r of ranges){
    // Consuming a boundary separator must not join a role name to adjacent prose and turn it into a partial plain word.
    const separator=from<to&&/^\s+$/.test(text.slice(from,to))&&(from===r.end||to===r.start);
    if(separator||from<r.end&&to>r.start||from===to&&from>r.start&&from<r.end){from=Math.min(from,r.start);to=Math.max(to,r.end);}
  }
  return {start:from,end:to,atomic:ranges.some(r=>from<=r.start&&to>=r.end)&&(from!==start||to!==end)};
}

/** Keep the native textarea's plaintext, selection, IME and submission contract; a noninteractive mirror colors role labels. */
export function createMentionInput(input,getNames) {
  const wrapper=document.createElement('div'),mirror=document.createElement('div');wrapper.className='mention-input';mirror.className='mention-input-mirror';
  mirror.setAttribute('aria-hidden','true');mirror.translate=false;input.before(wrapper);wrapper.append(mirror,input);
  let composing=false,mutating=false,snapshot=null;
  const ranges=()=>roleMentionRanges(input.value,getNames());
  function refresh() {
    const tokens=ranges(),style=getComputedStyle(input),fragment=document.createDocumentFragment();let offset=0;
    for(const token of tokens){fragment.append(document.createTextNode(input.value.slice(offset,token.start)));const tag=document.createElement('span');tag.className='role-mention-token';tag.textContent=input.value.slice(token.start,token.end);fragment.append(tag);offset=token.end;}
    fragment.append(document.createTextNode(input.value.slice(offset)+'\u200b'));mirror.replaceChildren(fragment);
    for(const property of ['font','lineHeight','letterSpacing','textAlign','direction','padding','borderWidth','boxSizing','tabSize','wordBreak','overflowWrap','whiteSpace'])mirror.style[property]=style[property];
    const highlighted=tokens.length>0&&!composing;input.classList.toggle('has-role-mentions',highlighted);mirror.hidden=!highlighted;
    mirror.scrollTop=input.scrollTop;mirror.scrollLeft=input.scrollLeft;
  }
  function expandSelection() {
    const r=mentionEditRange(input.value,ranges(),input.selectionStart,input.selectionEnd,'insertReplacementText');
    if(r.atomic)input.setSelectionRange(r.start,r.end);
  }
  function replace(start,end,text) {
    mutating=true;input.setSelectionRange(start,end);
    // The native edit command retains the browser undo entry; setRangeText is a fallback for engines without it.
    let applied=false;
    try{applied=document.execCommand(text?'insertText':'delete',false,text);}catch{}
    if(!applied){input.setRangeText(text,start,end,'end');input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:text?'insertText':'deleteContentBackward',data:text||null}));}
    mutating=false;refresh();
  }
  input.addEventListener('beforeinput',event=>{
    if(mutating||composing||event.isComposing||/^history/.test(event.inputType))return;
    const text=input.value,tokens=ranges(),start=input.selectionStart,end=input.selectionEnd;
    const r=mentionEditRange(text,tokens,start,end,event.inputType);snapshot=r.atomic||start===end&&event.inputType.startsWith('delete')?{text,tokens}:null;
    if(!r.atomic)return;
    const inserted=event.inputType.startsWith('delete')?'':event.data??event.dataTransfer?.getData('text/plain');
    if(event.cancelable&&inserted!==undefined&&inserted!==null){event.preventDefault();event.stopImmediatePropagation();snapshot=null;replace(r.start,r.end,inserted);}
    else input.setSelectionRange(r.start,r.end);
  },{capture:true});
  input.addEventListener('input',event=>{
    // Some mobile edits cannot be cancelled. Repair only the edited role range before the draft handler observes it.
    const before=snapshot;snapshot=null;
    if(before&&!mutating&&!composing&&!event.isComposing&&!/^history/.test(event.inputType||'')){
      const value=input.value;let left=0,right=0;
      while(left<before.text.length&&left<value.length&&before.text[left]===value[left])left++;
      while(right<before.text.length-left&&right<value.length-left&&before.text.at(-right-1)===value.at(-right-1))right++;
      const end=before.text.length-right,r=mentionEditRange(before.text,before.tokens,left,end,'insertReplacementText');
      if(r.atomic){const inserted=value.slice(left,value.length-right);input.value=before.text.slice(0,r.start)+inserted+before.text.slice(r.end);input.setSelectionRange(r.start+inserted.length,r.start+inserted.length);}
    }
    refresh();
  },{capture:true});
  for(const type of ['cut','paste','drop','dragstart'])input.addEventListener(type,expandSelection,{capture:true});
  input.addEventListener('compositionstart',()=>{expandSelection();snapshot=null;composing=true;refresh();});
  input.addEventListener('compositionend',()=>{composing=false;refresh();});
  input.addEventListener('scroll',()=>{mirror.scrollTop=input.scrollTop;mirror.scrollLeft=input.scrollLeft;});
  input.addEventListener('keydown',event=>{
    if(composing||event.isComposing||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||input.selectionStart!==input.selectionEnd)return;
    const caret=input.selectionStart,token=ranges().find(r=>event.key==='ArrowLeft'?caret>r.start&&caret<=r.end:event.key==='ArrowRight'&&caret>=r.start&&caret<r.end);
    if(token){event.preventDefault();const at=event.key==='ArrowLeft'?token.start:token.end;input.setSelectionRange(at,at);}
  },{capture:true});
  // Callers clear or restore the draft by assigning value (send, draft switch, reply prefix), which fires no input event.
  // Redraw on every assignment so the mirror never keeps old text over the emptied box or its placeholder.
  const native=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value');
  if(native?.set)Object.defineProperty(input,'value',{configurable:true,enumerable:native.enumerable,get(){return native.get.call(this);},set(value){native.set.call(this,value);refresh();}});
  const observer=new ResizeObserver(refresh);observer.observe(input);refresh();return {refresh};
}
