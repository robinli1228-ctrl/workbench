// Leaner group-chat collaboration: a task a role already read is one line, work materials have a folder other devices
// can read (not /tmp), the default prompt sizes reviews to the change, and platform folders do not make a repository dirty.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,symlink,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {ConversationTasks} from '../src/conversation-tasks.mjs';
import {renderRunPrompt,renderRunInputParts} from '../src/run-context.mjs';
import {workMaterialsFolder,workMaterialsParts} from '../src/work-materials.mjs';
import {executionEnvironmentHint} from '../src/run-input.mjs';
import {runWithLanguage,tr} from '../src/i18n.mjs';
import {defaultPlatformPrompt} from '../src/platform-prompts.mjs';
import {inspectGitRepositoryVersion} from '../src/git-version.mjs';

const P='p1',at='2026-11-03T10:00:00.000Z';
function env(){
  const db=new Store(':memory:');db.put('projects',{id:P,name:'demo',createdAt:at});
  for(const [id,name] of [['owner','执行'],['helper','Claude']])db.put('roles',{id,projectId:P,name,runtime:'claude',createdAt:at});
  const tasks=new ConversationTasks(db),scope={projectId:P,conversationId:P};
  const task=tasks.create(scope,{requestId:'r1',title:'修复预填',description:'当前状态：方案 v3 待确认。',ownerRoleId:'owner',
    plan:{steps:[{description:'核对',status:'done'},{description:'实施',status:'in_progress'}],currentStep:1}},{user:true});
  db.put('coordinationRequests',{id:'q1',projectId:P,conversationId:P,conversationTaskId:task.id});
  // A linked run as Store.createRun makes it, then what the Worker reported: input accepted unless told otherwise.
  let n=0;const runFor=(roleId,{session=`s-${roleId}`,resume=true,delivered='accepted'}={})=>{
    const run={id:`run${++n}`,projectId:P,conversationId:P,roleId,requestId:'q1',roleSessionId:session,resumeNativeSessionId:resume?`native-${session}`:null};
    const value=tasks.forRun(run);db.put('runs',{...run,inputDeliveryState:delivered});return value;};
  return {db,tasks,scope,task,runFor};
}
const prompt=task=>renderRunPrompt({instruction:'do it',conversationTask:task},{minimal:true});
const part=task=>renderRunInputParts({instruction:'do it',conversationTask:task}).home.find(p=>p.key==='task').text;

test('a role gets the full task unless its resumed session already received this description and plan', () => runWithLanguage('zh',() => {
  const e=env(),full=task=>/方案 v[34]/.test(prompt(task)),line=task=>/T1「修复预填」/.test(prompt(task))&&!full(task);
  const first=e.runFor('helper',{resume:false});
  assert.ok(full(first),'first read: full description');
  assert.doesNotMatch(prompt(first),/"known"|"updated"|ownerRoleId|"id"/,'readable text: no read flags or internal ids');
  const again=e.runFor('helper');
  for(const text of [prompt(again),part(again)]){
    assert.doesNotMatch(text,/方案 v3/,'same session, input delivered: no description');
    assert.match(text,/T1「修复预填」· todo · 2\/2 · 第 1 版/);assert.match(text,/wb task show T1/);
  }
  assert.ok(prompt(again).length<prompt(first).length);
  e.runFor('helper',{delivered:'not_delivered'});
  assert.ok(full(e.runFor('helper')),'the previous run never received its input: full again');
  assert.ok(line(e.runFor('helper')));
  assert.ok(full(e.runFor('helper',{session:'s-review'})),'a separate session (review, reset) gets the full task');
  assert.ok(full(e.runFor('helper',{session:'s-review',resume:false})),'a new CLI session gets the full task');
  e.runFor('helper');
  e.tasks.update(e.scope,e.task.id,{revision:1,description:'当前状态：方案 v4 已冻结。'},{user:true});
  const changed=e.runFor('helper');
  assert.match(prompt(changed),/任务说明已更新。/);assert.ok(full(changed),'description changed: full text again');
  assert.ok(full(e.runFor('owner')),'each role has its own first read');
  assert.ok(line(e.runFor('helper')));
  const current=e.tasks.show(e.scope,e.task.id);
  e.tasks.update(e.scope,e.task.id,{revision:current.revision,plan:{steps:[...current.plan.steps,{description:'复审',status:'todo'}],currentStep:1}},{user:true});
  assert.ok(full(e.runFor('helper')),'plan changed: full text again');
  const marked=e.tasks.show(e.scope,e.task.id);
  e.tasks.update(e.scope,e.task.id,{revision:marked.revision,plan:{steps:marked.plan.steps.map((step,i)=>i===1?{...step,status:'done'}:step),currentStep:2}},{user:true});
  assert.ok(line(e.runFor('helper')),'a step marked done is not a new plan: one line');
  // A step's settings are part of the plan: a changed review sends it all again, with the ids a plan update must keep.
  const reviewed=e.tasks.show(e.scope,e.task.id);
  e.tasks.update(e.scope,e.task.id,{revision:reviewed.revision,plan:{steps:reviewed.plan.steps.map((step,i)=>i===0?{...step,review:{roleIds:['owner'],count:1,sequential:true}}:step),currentStep:reviewed.plan.currentStep}},{user:true});
  const settings=e.runFor('helper');
  assert.ok(full(settings),'review settings changed: full text again');
  assert.match(prompt(settings),/"review":\{"roleIds":\["owner"\],"count":1,"sequential":true\}/,'the settings travel with their ids');
  const later=e.tasks.show(e.scope,e.task.id);
  e.tasks.update(e.scope,e.task.id,{revision:later.revision,status:'in_progress'},{user:true});
  assert.match(prompt(e.runFor('helper')),/T1「修复预填」· in_progress · 3\/3 · 第 6 版/,'a status change alone keeps the one line, with the new state');
  // A packet saved before this change (no read flags) still carries the full snapshot.
  const {known,...old}=first;assert.match(prompt(old),/方案 v3/);
}));

test('the work materials folder is per task and role inside the project, and never leads out through a link', async () => {
  const root=await mkdtemp(join(tmpdir(),'wb-materials-'));
  try {
    const folder=await workMaterialsFolder(root,25,'Claude');
    assert.equal(folder,join(await import('node:fs/promises').then(f=>f.realpath(root)),'.workbench','tmp','T25','Claude'));
    assert.ok((await stat(folder)).isDirectory());
    assert.deepEqual(workMaterialsParts(undefined,'../执行/x'),['.workbench','tmp','misc','_执行_x'],'no task: misc; the name cannot climb or nest');
    assert.equal(workMaterialsParts(1,'Auth-Token').at(-1),'role','a secret-looking name would be refused by wb device read');
    const elsewhere=await mkdtemp(join(tmpdir(),'wb-elsewhere-')),linked=await mkdtemp(join(tmpdir(),'wb-linked-'));
    await symlink(elsewhere,join(linked,'.workbench'));
    assert.equal(await workMaterialsFolder(linked,1,'Claude'),null,'a linked .workbench is refused');
    await rm(elsewhere,{recursive:true,force:true});await rm(linked,{recursive:true,force:true});
    const hint=runWithLanguage('zh',()=>executionEnvironmentHint({cwd:root,projectRoot:root,materials:folder}));
    // Text sent to the model is converted to Traditional script; the path is what matters.
    assert.ok(hint.split('\n').includes(`中間資料目錄：${folder}（本設備，不同步）`),hint);
  } finally {await rm(root,{recursive:true,force:true});}
});

for(const lang of ['zh','en'])test(`${lang}: the default prompt sizes reviews, keeps materials out of /tmp, and drops per-file hashes`, () => runWithLanguage(lang,() => {
  const text=defaultPlatformPrompt(),sync=tr('wbTools.helpSync');
  assert.match(text,lang==='zh'?/默认自己做。/:/Do the work yourself by default\./);
  assert.match(text,lang==='zh'?/大的改动请其他角色审核，小改动自测后直接交付/:/have another role review a large change; deliver a small one after testing it yourself/);
  assert.match(text,lang==='zh'?/下一步自己能做就接着做/:/carry on with the next step if you can do it/);
  assert.match(text,lang==='zh'?/修复后只请提出问题的人复核/:/only the reviewer who raised the issue rechecks/);
  assert.doesNotMatch(text,lang==='zh'?/至少请两位非作者的模型角色审核/:/at least two model roles other than the author/);
  assert.match(text,lang==='zh'?/中间资料目录（不同步，不要放 \/tmp）/:/work materials folder from the environment notes \(not synced; never \/tmp\)/);
  assert.match(text,lang==='zh'?/任务说明只写当前状态，控制在 3 KB 以内/:/Keep the description to the current state \(about 3 KB\)/);
  assert.doesNotMatch(text,lang==='zh'?/文件路径与哈希/:/file path and hash/);
  assert.doesNotMatch(sync,lang==='zh'?/哈希并确认接收|路径和哈希/:/hash and confirm receipt|path and hash/);
}));

test('platform folders do not make the Git version card dirty; other untracked files still do', async () => {
  const base=await mkdtemp(join(tmpdir(),'wb-gitver-')),origin=join(base,'origin.git'),work=join(base,'work');
  const git=(cwd,...args)=>execFileSync('git',['-c','user.name=t','-c','user.email=t@xxxxx',...args],{cwd,stdio:'ignore'});
  try {
    git(base,'init','-q','--bare',origin);git(base,'clone','-q',origin,work);
    await writeFile(join(work,'a.txt'),'a');git(work,'add','.');git(work,'commit','-qm','a');git(work,'push','-q','origin','HEAD');
    await mkdir(join(work,'.workbench','tmp','T1','Claude'),{recursive:true});await writeFile(join(work,'.workbench','tmp','T1','Claude','probe.log'),'x');
    assert.equal((await inspectGitRepositoryVersion({localRoot:work,repoUrl:origin})).dirty,false);
    await writeFile(join(work,'b.txt'),'b');
    assert.equal((await inspectGitRepositoryVersion({localRoot:work,repoUrl:origin})).dirty,true);
  } finally {await rm(base,{recursive:true,force:true});}
});
