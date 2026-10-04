/** Resending only selects the original events and never creates new IDs; the amount sent is limited by Run order, window size, and connection backlog. */
export function outboxBatch(events,sent,now,{bufferedAmount=0,maxEvents=64,maxBytes=256*1024,retryMs=5000}={}) {
  if(bufferedAmount>=maxBytes)return [];
  const batch=[],blockedRuns=new Set();let bytes=0;
  let inFlight=events.filter(e=>sent.has(e.id)).length;
  let inFlightBytes=events.filter(e=>sent.has(e.id)).reduce((sum,e)=>sum+Buffer.byteLength(JSON.stringify(e)),0);
  for(const event of [...events].sort((a,b)=>a.runId.localeCompare(b.runId)||a.seq-b.seq)) {
    if(blockedRuns.has(event.runId))continue;
    if(sent.has(event.id)&&now-sent.get(event.id)<retryMs)continue;
    const size=Buffer.byteLength(JSON.stringify(event));
    if(!sent.has(event.id)) {
      if(inFlight>=maxEvents||(inFlight&&inFlightBytes+size>maxBytes)){blockedRuns.add(event.runId);continue;}
      inFlight++;inFlightBytes+=size;
    }
    if(batch.length&&(batch.length>=maxEvents||bytes+size>maxBytes))break;
    batch.push(event);bytes+=size;
  }
  return batch;
}
