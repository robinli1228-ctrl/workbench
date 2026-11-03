// A repository with a lot of untracked files once failed every run before it started: the dirty check printed more
// than its 1 MiB buffer ("stdout maxBuffer length exceeded"). The check now stops at the first byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gitPrintsAnything} from '../src/git-changes.mjs';
import {inspectExecutionRepositories} from '../src/execution-workspace.mjs';

const git=(cwd,...args)=>execFileSync('git',['-c','user.name=t','-c','user.email=t@xxxxx',...args],{cwd,stdio:'ignore'});

test('a repository whose status runs to megabytes is dirty, not an error; a clean one is clean', async () => {
  const root=await mkdtemp(join(tmpdir(),'wb-dirty-'));
  try {
    git(root,'init','-q');await writeFile(join(root,'a.txt'),'a');git(root,'add','.');git(root,'commit','-qm','a');
    assert.equal(await gitPrintsAnything(root,['status','--porcelain','--untracked-files=all']),false);
    assert.deepEqual((await inspectExecutionRepositories([{id:'r',key:'r',localRoot:root}]))[0].dirty,false);
    // About 2 MiB of status output: 12 000 untracked files with long names.
    const dir=join(root,'generated-output-'.repeat(4));await mkdir(dir);
    for(let i=0;i<12000;i+=500)await Promise.all(Array.from({length:500},(_,j)=>writeFile(join(dir,`${'untracked-file-with-a-long-name-'.repeat(3)}${i+j}.txt`),'')));
    assert.ok(execFileSync('git',['status','--porcelain','--untracked-files=all'],{cwd:root,maxBuffer:64*1024*1024}).length>1024*1024);
    const [repo]=await inspectExecutionRepositories([{id:'r',key:'r',localRoot:root}]);
    assert.equal(repo.dirty,true);
    await assert.rejects(gitPrintsAnything(join(root,'..'),['status','--porcelain']),/not a git repository/i,'a git failure is still an error');
  } finally {await rm(root,{recursive:true,force:true});}
});
