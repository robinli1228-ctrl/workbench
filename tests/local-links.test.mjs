// A folder or file linked in a reply opens in the page, only inside that run's project; file: links and picture links
// with spaces (macOS screenshots) are read as the local paths they name.
import test from 'node:test';
import assert from 'node:assert/strict';
import {runOpenablePath} from '../src/folder-access.mjs';
import {localFileAddress,safeLink} from '../public/markdown.js';

test('only paths inside the run workspace, project root or folder binding can be opened in the page', () => {
  const run={workspace:'/xxxxx/proj/.worktrees/run-1',projectRoot:'/xxxxx/proj'};
  assert.equal(runOpenablePath(run,'/xxxxx/proj','/xxxxx/proj/.workbench/tmp/T25/主管'),'/xxxxx/proj/.workbench/tmp/T25/主管');
  assert.equal(runOpenablePath(run,'/xxxxx/proj','out/截屏 2026-11-03 17.50.12.png'),'/xxxxx/proj/.worktrees/run-1/out/截屏 2026-11-03 17.50.12.png','relative to the workspace');
  assert.equal(runOpenablePath({workspace:'/xxxxx/proj'},'/xxxxx/proj','/xxxxx/proj'),'/xxxxx/proj','the root itself');
  for(const path of ['/xxxxx/other','/xxxxx/proj/../other','../../../etc','/etc/passwd','',null,'a\nb'])
    assert.equal(runOpenablePath(run,'/xxxxx/proj',path),null,String(path));
  assert.equal(runOpenablePath({workspace:'/xxxxx/proj'},null,'/xxxxx/proj..evil/x'),null,'a sibling with the same prefix is outside');
  assert.equal(runOpenablePath({workspace:'/xxxxx/proj'},null,'/xxxxx/proj/..hidden/x'),'/xxxxx/proj/..hidden/x','a name starting with two dots is inside');
});

test('local file: URLs become their path; remote and malformed ones do not', () => {
  assert.equal(localFileAddress('file:///Users/xxxxx/proj/%E6%88%AA%E5%B1%8F%202026.png'),'/Users/xxxxx/proj/截屏 2026.png');
  assert.equal(localFileAddress('file://localhost/xxxxx/a.png'),'/xxxxx/a.png');
  for(const value of ['file://server/share/a.png','https://x.example/a.png','/xxxxx/a.png','file:///a%0Ab.png',null])assert.equal(localFileAddress(value),null,String(value));
});

test('a picture or file link with a relative path is a local link, not left as raw Markdown', () => {
  for(const value of ['outputs/悟理TMS官网内容稿-20261113/01-home.png','out/截屏 2026-11-03 17.50.12.png','report.pdf','./a.png','../b/c.png','/xxxxx/a.png','https://x.example/a.png'])
    assert.equal(safeLink(value),true,value);
  for(const value of ['javascript:alert(1)','data:image/png;base64,AAAA','word','','a\nb/c.png'])
    assert.equal(safeLink(value),false,JSON.stringify(value));
});
