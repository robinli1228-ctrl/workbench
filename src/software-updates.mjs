const sha=/^[0-9a-f]{40}$/;
const repositoryPattern=/^[\w.-]+\/[\w.-]+$/;

/** Manual, bounded GitHub reads. Cache promises as well as failures so repeated clicks cannot form a retry storm. */
export class SoftwareUpdates {
  constructor({repository,fetch=globalThis.fetch,now=Date.now}) {
    Object.assign(this,{repository,fetch,now});this.cache=new Map();
  }
  async request(path) {
    const old=this.cache.get(path);if(old&&this.now()-old.time<60000)return old.promise;
    if(this.cache.size>=64)this.cache.delete(this.cache.keys().next().value);
    const promise=(async()=>{
      try {
        const response=await this.fetch(`https://api.github.com/repos/${this.repository}/${path}`,{headers:{Accept:'application/vnd.github+json','User-Agent':'agent-collaboration-workbench'},signal:AbortSignal.timeout(8000),redirect:'error'});
        if(!response.ok)throw new Error(`github_${response.status}`);
        const chunks=[];let size=0;
        for await(const chunk of response.body){size+=chunk.length;if(size>2*1024*1024)throw new Error('response_too_large');chunks.push(Buffer.from(chunk));}
        const raw=JSON.parse(Buffer.concat(chunks).toString());
        const commit=item=>({sha:item?.sha,commit:{message:String(item?.commit?.message||'').split('\n')[0].slice(0,500)}});
        // GitHub also returns file patches; do not retain those unused megabytes in the minute cache.
        const data=path.startsWith('compare/')?{status:raw.status,total_commits:raw.total_commits,commits:(Array.isArray(raw.commits)?raw.commits:[]).slice(0,20).map(commit)}:commit(raw);
        return {data,checkedAt:new Date(this.now()).toISOString()};
      }catch(error){throw new Error(/^github_\d{3}$|^response_too_large$/.test(error.message)?error.message:'network_or_response_error');}
    })();
    this.cache.set(path,{time:this.now(),promise});return promise;
  }
  /** Compare immutable SHAs, not timestamps or the shared package version. A local-only commit is not an update. */
  async check(versions) {
    const repository=this.repository,base={repository,branch:'main',latest:null,versions:[]},deadline=this.now()+20000;
    if(!repositoryPattern.test(repository||''))return {...base,error:'repository_unknown',versions:versions.map(()=>({status:'unknown'}))};
    let latest;
    try{latest=await this.request('commits/main');if(!sha.test(latest.data.sha))throw new Error('invalid_response');}
    catch(error){return {...base,checkedAt:new Date(this.now()).toISOString(),error:error.message,versions:versions.map(()=>({status:'check_failed'}))};}
    const latestCommit=latest.data.sha,url=`https://github.com/${repository}`;
    const result={...base,checkedAt:latest.checkedAt,latest:{commit:latestCommit,url:`${url}/commit/${latestCommit}`,summary:String(latest.data.commit?.message||'').split('\n')[0].slice(0,500)},versions:[]};
    const seen=new Set();
    for(const version of versions){
      if(!sha.test(version?.commit||'')||version.repository!==repository){result.versions.push({status:'unknown'});continue;}
      if(version.dirty!==false){result.versions.push({status:'modified'});continue;}
      if(version.commit===latestCommit){result.versions.push({status:'latest'});continue;}
      if(this.now()>=deadline){result.versions.push({status:'check_failed',error:'check_budget_exceeded'});continue;}
      if(!seen.has(version.commit)&&seen.size>=16){result.versions.push({status:'unknown',error:'comparison_limit'});continue;}seen.add(version.commit);
      try{
        const comparison=await this.request(`compare/${version.commit}...${latestCommit}?per_page=20`),data=comparison.data;
        const status={ahead:'update_available',behind:'ahead',diverged:'diverged',identical:'latest'}[data.status]||'unknown';
        const commits=status==='update_available'?(Array.isArray(data.commits)?data.commits:[]).filter(c=>sha.test(c.sha)).slice(0,20).map(c=>({commit:c.sha,summary:String(c.commit?.message||'').split('\n')[0].slice(0,500),url:`${url}/commit/${c.sha}`})):[];
        result.versions.push({status,checkedAt:comparison.checkedAt,commits,totalCommits:Number.isSafeInteger(data.total_commits)?data.total_commits:null,url:`${url}/compare/${version.commit}...${latestCommit}`});
      }catch(error){result.versions.push({status:'check_failed',error:error.message});}
    }
    return result;
  }
}
