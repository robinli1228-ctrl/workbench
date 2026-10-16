import {readFile,writeFile,realpath,lstat,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

const exec=promisify(execFile);
const paths=['src','public','bin','package.json','package-lock.json'];
const sha=/^[0-9a-f]{40}$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourcePath=name=>typeof name==='string'&&!name.includes('\\')&&!name.split('/').some(p=>!p||p==='.'||p==='..')&&(/^(src|public|bin)\//.test(name)||['package.json','package-lock.json'].includes(name));
const git=async(root,args)=>(await exec('git',args,{cwd:root,timeout:5000,maxBuffer:1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout.trim();

/** Archive verification includes added files; old release leftovers must not masquerade as the stamped build. */
async function sourceFiles(root) {
  const names=[];
  async function visit(name){
    let entry;try{entry=await lstat(join(root,name));}catch(error){if(error.code==='ENOENT')return;throw error;}
    if(entry.isDirectory()){for(const child of await readdir(join(root,name)))await visit(`${name}/${child}`);}
    else names.push(name);
    if(names.length>5000)throw new Error('Source inventory exceeds the build verification limit.');
  }
  for(const name of paths)await visit(name);
  return names;
}

/** Only the package's public GitHub repository is an update source; no account credentials are forwarded. */
export function githubRepository(url) {
  const match=String(url||'').match(/^(?:git\+)?https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return match?`${match[1]}/${match[2]}`:null;
}

/** Read only the running module root, once at process startup, never the bound project or a parent repository. */
export async function readSoftwareVersion(root) {
  let pkg={};try{pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));}catch{}
  const value={version:String(pkg.version||'unknown').slice(0,80),repository:githubRepository(pkg.repository?.url||pkg.repository),commit:null,dirty:null,source:'unknown',observedAt:new Date().toISOString()};
  try {
    await lstat(join(root,'.git'));
    if(await realpath(await git(root,['rev-parse','--show-toplevel']))!==await realpath(root))return value;
    const commit=await git(root,['rev-parse','HEAD']);if(!sha.test(commit))return value;
    return {...value,commit,dirty:!!await git(root,['status','--porcelain','--untracked-files=all','--',...paths]),source:'git'};
  } catch {}
  try {
    const raw=await readFile(join(root,'software-build.json'));if(raw.length>1024*1024)return value;
    const build=JSON.parse(raw),entries=Object.entries(build.files||{});
    if(build.schema!==1||!sha.test(build.commit)||build.repository!==value.repository||build.version!==value.version||!entries.length||entries.length>5000||!build.files['package.json']||!entries.some(([name])=>name.startsWith('src/')))return value;
    let dirty=(await sourceFiles(root)).some(name=>!Object.hasOwn(build.files,name));
    for(const [name,digest] of entries){
      if(!sourcePath(name)||!/^[0-9a-f]{64}$/.test(digest))return value;
      try{if(!(await lstat(join(root,name))).isFile()||hash(await readFile(join(root,name)))!==digest)dirty=true;}catch{dirty=true;}
    }
    return {...value,commit:build.commit,dirty,source:'build'};
  } catch {return value;}
}

/** Stamp a clean release before copying it without .git. A subset supports the existing Worker source-only installer. */
export async function createBuildManifest(root,includedPaths=null) {
  const version=await readSoftwareVersion(root);
  if(!version.commit||version.dirty!==false)throw new Error('Build stamping requires a verified, clean source version.');
  const names=version.source==='git'?(await git(root,['ls-files','-z','--',...paths])).split('\0').filter(Boolean):Object.keys(JSON.parse(await readFile(join(root,'software-build.json'),'utf8')).files);
  const files={};
  for(const name of names){
    if(includedPaths&&!includedPaths.includes(name))continue;
    if(!sourcePath(name)||!(await lstat(join(root,name))).isFile())throw new Error('Build contains an unsupported source path.');
    files[name]=hash(await readFile(join(root,name)));
  }
  const after=await readSoftwareVersion(root);
  if(after.commit!==version.commit||after.dirty!==false)throw new Error('Source changed while creating the build stamp.');
  return {schema:1,version:version.version,repository:version.repository,commit:version.commit,files};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]!=='--stamp')throw new Error('Usage: node src/software-version.mjs --stamp');
  const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
  await writeFile(join(root,'software-build.json'),JSON.stringify(await createBuildManifest(root),null,2)+'\n');
  console.log('Build stamp saved; no code was deployed or restarted.');
}
