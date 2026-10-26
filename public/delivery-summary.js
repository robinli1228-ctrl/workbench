/** Display scope from the frozen source Run, never guess from a later project configuration. */
export function deliveryRepositorySummary(delivery, repositories=[]) {
  const items=delivery.items||[];
  return {names:items.map(item=>{const repo=repositories.find(r=>r.id===item.id);return repo?.key||repo?.name||item.id;}),partial:items.length>0&&items.length<repositories.length};
}
