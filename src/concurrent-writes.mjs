/** A project's manual switch lets several roles on one device work in it at once; a Worker that cannot honour it keeps the lock. */
export const concurrentWritesAllowed=(project,worker)=>project?.allowConcurrentWrites===true&&worker?.capabilities?.concurrentWrites===1;

/** Roles already admitted on this device in this project, named once so a starting run can say who else is working. */
export const concurrentPeers=(db,projectId,nodeId)=>[...new Set(db.activeRuns(nodeId).filter(r=>r.projectId===projectId).map(r=>r.roleSnapshot?.name).filter(Boolean))];
