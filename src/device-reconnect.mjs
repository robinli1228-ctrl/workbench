/** Runs read-only over a separate SSH connection. Unknown process ownership is never treated as idle. */
export async function remoteReconnectProbe(nodeId) {
  const {readdir, readFile, readlink} = await import('node:fs/promises');
  const {dirname, resolve, join} = await import('node:path');
  const {DatabaseSync} = await import('node:sqlite');
  if (process.platform !== 'linux') return {idle:false, reason:'unsupported_platform'};
  const matches=[];
  for (const id of (await readdir('/proc')).filter(id=>/^\d+$/.test(id))) {
    let args;
    try { args=(await readFile(`/proc/${id}/cmdline`,'utf8')).split('\0').filter(Boolean); }
    catch (error) { if(error.code==='ENOENT'||error.code==='ESRCH')continue; return {idle:false,reason:'process_unreadable'}; }
    const entry=args.find(arg=>arg.endsWith('/src/worker.mjs'));
    if(!entry)continue;
    try {
      const identity=await readFile(`/proc/${id}/stat`,'utf8');
      const env=Object.fromEntries((await readFile(`/proc/${id}/environ`,'utf8')).split('\0').filter(Boolean).map(v=>{const at=v.indexOf('=');return[v.slice(0,at),v.slice(at+1)];}));
      const cwd=await readlink(`/proc/${id}/cwd`),data=resolve(cwd,env.WORKER_DATA_DIR||join(dirname(dirname(entry)),'.data/worker'));
      const db=new DatabaseSync(join(data,'worker.sqlite'),{readOnly:true});
      try {
        const saved=db.prepare("SELECT data FROM records WHERE kind='identity' AND id='node'").get();
        if(!saved||JSON.parse(saved.data).nodeId!==nodeId)continue;
        const active=db.prepare("SELECT 1 FROM records WHERE kind='runs' AND coalesce(json_extract(data,'$.status'),'') NOT IN ('succeeded','failed','interrupted','cancelled','stopped') LIMIT 1").get();
        const terminal=db.prepare("SELECT 1 FROM records WHERE kind='terminalSessions' AND coalesce(json_extract(data,'$.status'),'') NOT IN ('released','cancelled','finished','expired') LIMIT 1").get();
        const children=(await readFile(`/proc/${id}/task/${id}/children`,'utf8')).trim();
        const after=await readFile(`/proc/${id}/stat`,'utf8');
        const start=value=>value.slice(value.lastIndexOf(')')+2).split(' ')[19];
        matches.push({pid:Number(id),idle:!active&&!terminal&&!children&&start(identity)===start(after)});
      } finally { db.close(); }
    } catch { return {idle:false,reason:'worker_unverifiable'}; }
  }
  return {nodeId,idle:matches.length===1&&matches[0].idle,pid:matches.length===1?matches[0].pid:null};
}
