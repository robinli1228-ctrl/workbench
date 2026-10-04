/** A delta applies only to the same project and baseline; if it cannot continue, the caller re-fetches a snapshot. */
export function applyStateUpdate(cache,update) {
  if(update?.schema!==1)throw new Error('Unsupported UI state protocol');
  if(update.reset)return {projectId:update.projectId,cursor:update.cursor,state:update.state};
  if(!cache||cache.projectId!==update.projectId||cache.cursor!==update.baseCursor)throw new Error('State cursor is no longer valid; please resync');
  const state={...cache.state,...update.replace};
  for(const [key,delta] of Object.entries(update.changes||{})) {
    const rows=new Map((state[key]||[]).map(row=>[row.id,row]));
    for(const id of delta.remove)rows.delete(id);
    for(const row of delta.upsert)rows.set(row.id,row);
    if(delta.order.some(id=>!rows.has(id)))throw new Error('State delta is incomplete; please resync');
    state[key]=delta.order.map(id=>rows.get(id));
  }
  return {projectId:update.projectId,cursor:update.cursor,state};
}
