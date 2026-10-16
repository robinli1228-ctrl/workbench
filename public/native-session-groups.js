/** Group native catalogue rows for presentation without changing their identities or stored history. */
export function groupNativeSessions(items, roleSessions) {
  const identity = (node, runtime, id) => JSON.stringify([node, runtime, id]);
  const bindings = new Map(), groups = new Map();
  const created = value => Date.parse(value || '') || 0;
  const newest = (a, b) => created(b.binding?.createdAt || b.item.createdAt) - created(a.binding?.createdAt || a.item.createdAt)
    || (b.binding?.generation || 0) - (a.binding?.generation || 0)
    || String(a.item.id).localeCompare(String(b.item.id));
  const catalogueBindings=items.filter(item=>item.roleBinding).map(item=>({...item.roleBinding,nodeId:item.nodeId,runtime:item.runtime,nativeSessionId:item.sessionId||item.id}));
  for (const binding of [...catalogueBindings,...(roleSessions || [])]) {
    if (binding.historyClearedAt || !binding.nativeSessionId || !binding.nodeId || !binding.projectId || !binding.roleId) continue;
    const id = identity(binding.nodeId, binding.runtime, binding.nativeSessionId);
    if (!bindings.has(id)) bindings.set(id, []);
    bindings.get(id).push(binding);
  }
  for (const item of items) {
    const id = identity(item.nodeId, item.runtime, item.sessionId || item.id);
    const matches = bindings.get(id) || [];
    const owners = new Set(matches.map(s => JSON.stringify([s.projectId, s.roleId])));
    // Never infer ownership from titles or combine ambiguous native identities.
    const binding = owners.size === 1 ? [...matches].sort((a, b) => newest({binding: a, item}, {binding: b, item}))[0] : null;
    const groupId = binding ? `role:${JSON.stringify([binding.projectId, binding.roleId])}` : `native:${identity(item.nodeId, item.runtime, item.entryId || item.id)}`;
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId).push({item, binding});
  }
  return [...groups].map(([id, rows]) => {
    rows.sort(newest);
    return {id, latest: rows[0].item, history: rows.slice(1).map(row => row.item)};
  });
}

/** Discard mixed snapshots; retry a changing catalogue once without adding a background poll loop. */
export async function readNativeSessionPages(read,isCurrent=()=>true) {
  for(let attempt=0;attempt<2;attempt++) {
    let offset=0,revision='',partial=false;const items=[];
    while(isCurrent()) {
      const result=await read(offset,revision);
      if(!isCurrent())return {items:[],partial:false};
      if(result.restart)break;
      items.push(...(result.items||[]));partial||=result.partial===true;
      if(!result.hasMore)return {items,partial};
      if(!Number.isSafeInteger(result.nextOffset)||result.nextOffset<=offset)throw Error('Invalid native session page');
      revision=result.revision||'';offset=result.nextOffset;
    }
    if(!isCurrent())return {items:[],partial:false};
  }
  throw Error('Native session catalogue changed; refresh and try again.');
}
