const count=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;

/** Context is a last-request snapshot, never the cumulative billing counters. Unknown limits stay unknown. */
export function contextSample({usedTokens,limitTokens,model=null,sessionId=null,state='measured',observedAt=new Date().toISOString(),compacted=null}) {
  return {usedTokens:count(usedTokens),limitTokens:count(limitTokens)>0?limitTokens:null,model,sessionId,state,observedAt,source:'native',...(compacted?{compacted}:{})};
}

/** Claude reports request input on assistant/message_start, but the resolved model window on result. */
export class ClaudeContextUsage {
  constructor(){this.limits=new Map();this.current=null;}
  receive(raw,sessionId){
    if(raw.parent_tool_use_id)return null;
    const event=raw.type==='stream_event'?raw.event:raw;
    if(!event||event.parent_tool_use_id)return null;
    if(event.subtype==='compact_boundary'){const meta=event.compact_metadata||{};return this.current=contextSample({...this.current,usedTokens:count(meta.post_tokens),sessionId,state:'compacted',observedAt:new Date().toISOString(),compacted:{preTokens:count(meta.pre_tokens),postTokens:count(meta.post_tokens)}});}
    const message=['assistant','message_start'].includes(event.type)?event.message:null;
    if(message?.usage&&typeof message.model==='string'){
      const usage=message.usage,parts=[usage.input_tokens,usage.cache_creation_input_tokens??0,usage.cache_read_input_tokens??0];
      if(parts.some(value=>count(value)===null))return null;
      return this.current=contextSample({usedTokens:parts.reduce((a,b)=>a+b,0),limitTokens:this.limits.get(message.model),model:message.model,sessionId});
    }
    if(event.type==='result'){
      for(const[model,usage]of Object.entries(event.modelUsage||{}))if(count(usage?.contextWindow)>0)this.limits.set(model,usage.contextWindow);
      const limit=this.limits.get(this.current?.model);
      if(this.current&&limit&&limit!==this.current.limitTokens)return this.current={...this.current,limitTokens:limit};
    }
    return null;
  }
}
