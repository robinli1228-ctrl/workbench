/** Session transcript rendering: one activity line per turn (expandable steps), file chips with a preview sheet, and a single working line.
 * Pure DOM helpers; the data still comes from the turn events (live-scene rows) that the Sessions page already loads. */
import {stripAnsi} from './run-log-data.js';

const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const MAX_DIFF_LINES=4000,MAX_PREVIEW=400000;

/** Step icons: 24-unit line artwork scaled into the 20-unit box; each kind gets its own colour in the stylesheet. */
const ICONS={
 // A page with lines: a file read.
 read:'<g transform="scale(.8333)"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8M16 13H8M16 17H8"/></g>',
 // A pencil over a line: a file changed in place.
 edit:'<g transform="scale(.8333)"><path d="M12 20h9"/><path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L7.4 18.6a2 2 0 0 1-.9.5l-2.9.8a.5.5 0 0 1-.6-.6l.8-2.9a2 2 0 0 1 .5-.8Z"/><path d="m15 5 3 3"/></g>',
 // A page with a plus: a new file.
 write:'<g transform="scale(.8333)"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6M12 12v6"/></g>',
 // A terminal window with a prompt: a shell command.
 command:'<g transform="scale(.8333)"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/></g>',
 // A magnifier over code brackets: a code or file search.
 search:'<g transform="scale(.8333)"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="m13 13.5 2-2.5-2-2.5M9 8.5 7 11l2 2.5"/></g>',
 // A globe: a page fetched from the web.
 web:'<g transform="scale(.8333)"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></g>',
 // A robot: a task handed to a sub-agent.
 agent:'<g transform="scale(.8333)"><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/></g>',
 // An info mark: a progress note from the CLI.
 note:'<g transform="scale(.8333)"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></g>',
 // A brain: the model is thinking.
 thinking:'<g transform="scale(.8333)"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M6 18a4 4 0 0 1-1.967-.516M19.967 17.484A4 4 0 0 1 18 18"/></g>',
 // A crossed circle: an error.
 error:'<g transform="scale(.8333)"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></g>',
 // A folder (folder rows in the Files tab).
 folder:'<g transform="scale(.8333)"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></g>',
 // A wrench: any other tool call.
 other:'<g transform="scale(.8333)"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9Z"/></g>'
};
export function stepIcon(kind){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 20 20');svg.setAttribute('aria-hidden','true');svg.classList.add('nt-icon',`is-${kind}`);svg.innerHTML=ICONS[kind]||ICONS.other;return svg;}

/** 只识别 Claude 的完整中断标记，正文引用和其他运行时的文字仍按原消息显示。 */
export function nativeInterruptionText(row,runtime){
 const value=typeof row.text==='string'?row.text.trim():'';
 return runtime==='claude'&&row.role==='user'&&/^\[Request interrupted by user(?: for tool use)?\]$/.test(value)?value:null;
}

/** 页面队列消息按时间插入后再归位提示；只处理本会话的显示节点，不改原始记录或执行状态。 */
export function attachInterruptionNotices(root,t){
 for(const history of root.querySelectorAll('.native-history')){
  for(const note of history.querySelectorAll('.nt-interruption-note'))note.remove();
  for(const row of history.querySelectorAll('[data-native-interruption-attached]')){row.hidden=false;delete row.dataset.nativeInterruptionAttached;}
  let previous=null;
  for(const row of history.querySelectorAll('.native-chat-row')){
   if(row.hidden)continue;
   const original=row.dataset.nativeInterruption;
   if(original){
    const time=previous?.querySelector('.nt-prompt-tools .nt-prompt-time');
    if(!time)continue; // 上一页尚未加载时保留独立提示，不能挂到另一原生会话。
    let note=time.parentNode.querySelector('.nt-interruption-note');
    if(!note){note=el('span','nt-interruption-note',t('Interrupted'));time.after(note);}
    if(!note.title.split('\n').includes(original))note.title=[note.title,original].filter(Boolean).join('\n');
    row.hidden=true;row.dataset.nativeInterruptionAttached='1';
   }else if(row.classList.contains('nt-user'))previous=row;
  }
 }
}

const parseArgs=value=>{if(!value)return {};if(typeof value==='string'){try{const parsed=JSON.parse(value);return parsed&&typeof parsed==='object'?parsed:{raw:value};}catch{return {raw:value};}}return typeof value==='object'?value:{};};
const text=value=>typeof value==='string'?value:value==null?'':JSON.stringify(value,null,2);
const basename=path=>String(path||'').replace(/[\\/]+$/,'').split(/[\\/]/).pop()||String(path||'');
const lines=value=>String(value??'').split('\n');
const countLines=value=>{const s=String(value??'');return s?s.split('\n').length:0;};

/** Unified-diff and apply_patch bodies count their own +/- lines; +++/--- headers are skipped. */
function patchStat(body){let added=0,removed=0;for(const line of lines(body)){if(/^\+\+\+|^---/.test(line))continue;if(line.startsWith('+'))added++;else if(line.startsWith('-'))removed++;}return {added,removed};}

/** Classify one merged tool item (Claude, Codex, Grok and Agy name their tools differently) into a step the transcript can summarize. */
export function classifyStep(item,runStatus){
 const args=parseArgs(item.input??item.arguments??item.parameters);
 const name=String(item.name||item.tool||item.title||item.command&&'command'||item.type||'').toLowerCase();
 const path=args.file_path||args.path||args.filePath||args.filename||args.target_file||args.file||args.notebook_path||null;
 const command=Array.isArray(args.command)?args.command.join(' '):args.command||args.cmd||(Array.isArray(item.command)?item.command.join(' '):typeof item.command==='string'?item.command:null);
 const output=stripAnsi(text(item.aggregatedOutput??item.output??item.results??item.result??''));
 const failed=item.status==='failed'||item.is_error===true||(item.exitCode!=null&&item.exitCode!==0),running=item.status==='inProgress'&&!['succeeded','failed','interrupted'].includes(runStatus);
 const base={id:item.id,name:item.name||item.tool||item.title||item.type||'tool',args,path,command,output,failed,running,error:item.error?text(item.error):'',exitCode:item.exitCode,item};
 const edits=Array.isArray(args.edits)?args.edits:null;
 if(item.type==='file_change'||Array.isArray(item.changes)){const changes=item.changes||[];let added=0,removed=0;for(const c of changes){const s=patchStat(c.diff||c.patch||'');added+=s.added;removed+=s.removed;}return {...base,kind:'edit',files:changes.map(c=>c.path).filter(Boolean),added,removed,changes};}
 if(/apply_patch/.test(name)||/^\s*apply_patch\b/.test(command||'')){const body=args.patch||args.input||command||'';const files=[...String(body).matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(m=>m[1].trim());return {...base,kind:'edit',files,...patchStat(body),patch:String(body)};}
 if(/(multi_?edit|str_replace|^edit|_edit|replace|patch)/.test(name)&&(edits||args.old_string!==undefined||args.old_str!==undefined||args.new_string!==undefined)){
  const pairs=(edits||[args]).map(e=>({before:String(e.old_string??e.old_str??''),after:String(e.new_string??e.new_str??'')}));
  let added=0,removed=0;for(const p of pairs){const d=diffLines(p.before,p.after);added+=d.added;removed+=d.removed;}
  return {...base,kind:'edit',files:path?[path]:[],pairs,added,removed};
 }
 if(/(write|create_file|save_file|write_to_file|notebookedit)/.test(name)&&(args.content!==undefined||args.new_source!==undefined||args.text!==undefined)){const content=String(args.content??args.new_source??args.text??'');return {...base,kind:'write',files:path?[path]:[],content,added:countLines(content),removed:0};}
 if(/(^read|_read|read_file|view_file|^view$|^cat$|open_file|notebookread)/.test(name)||(path&&!command&&/read|view|open/.test(name)))return {...base,kind:'read',files:path?[path]:[]};
 if(item.type==='command_execution'||/(bash|shell|exec|terminal|run_command|run_shell|^run$|^cmd$|powershell|command)/.test(name)||command)return {...base,kind:'command',files:[],command:command||'',description:args.description||''};
 if(/(grep|glob|search|^find|rg$|list_dir|list_files|^ls$|ripgrep|codebase)/.test(name)&&!/web/.test(name))return {...base,kind:'search',files:[],query:args.pattern||args.query||args.regex||args.glob||args.path||''};
 if(/(web|fetch|browse|http|url|crawl)/.test(name)||args.url)return {...base,kind:'web',files:[],url:args.url||args.query||''};
 if(/(agent|task|subagent|delegate|spawn|dispatch)/.test(name))return {...base,kind:'agent',files:[],description:args.description||args.prompt?.slice?.(0,120)||''};
 return {...base,kind:'other',files:path?[path]:[]};
}

/** Line diff with an LCS table, bounded so a huge replacement never freezes the page. */
export function diffLines(before,after){
 const a=lines(before),b=lines(after);
 if(a.length+b.length>MAX_DIFF_LINES){return {added:b.length,removed:a.length,rows:[...a.map(t=>({type:'del',text:t})),...b.map(t=>({type:'add',text:t}))],truncated:true};}
 const n=a.length,m=b.length,dp=Array.from({length:n+1},()=>new Uint16Array(m+1));
 for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
 const rows=[];let i=0,j=0,added=0,removed=0;
 while(i<n&&j<m){if(a[i]===b[j]){rows.push({type:'ctx',text:a[i]});i++;j++;}else if(dp[i+1][j]>=dp[i][j+1]){rows.push({type:'del',text:a[i++]});removed++;}else{rows.push({type:'add',text:b[j++]});added++;}}
 while(i<n){rows.push({type:'del',text:a[i++]});removed++;}while(j<m){rows.push({type:'add',text:b[j++]});added++;}
 return {added,removed,rows};
}

export const elapsedText=(from,to=Date.now())=>{const s=Math.max(0,Math.round((to-new Date(from).getTime())/1000));if(!Number.isFinite(s))return '';return s<60?`${s}s`:s<3600?`${Math.floor(s/60)}m ${s%60}s`:`${Math.floor(s/3600)}h ${Math.floor(s%3600/60)}m`;};
const stat=(added,removed)=>[added?`+${added}`:'',removed?`−${removed}`:''].filter(Boolean).join(' ');

/** One line that says what the turn did: unique files read/edited/created, commands, searches, delegations, failures, and duration. */
export function summarizeSteps(steps,t,{duration=''}={}){
 const uniq=kind=>new Set(steps.filter(s=>s.kind===kind).flatMap(s=>s.files.length?s.files:[s.id||Math.random()])).size;
 const edits=steps.filter(s=>s.kind==='edit'),added=edits.reduce((n,s)=>n+(s.added||0),0),removed=edits.reduce((n,s)=>n+(s.removed||0),0);
 const parts=[];const count=(kind,one,many)=>{const n=kind==='command'||kind==='search'||kind==='web'||kind==='agent'||kind==='other'?steps.filter(s=>s.kind===kind).length:uniq(kind);if(n)parts.push(t(n===1?one:many,{n}));return n;};
 count('read','Read 1 file','Read {n} files');
 if(count('edit','Edited 1 file','Edited {n} files')&&(added||removed))parts[parts.length-1]+=` ${stat(added,removed)}`;
 count('write','Created 1 file','Created {n} files');count('command','Ran 1 command','Ran {n} commands');count('search','1 search','{n} searches');count('web','Fetched 1 page','Fetched {n} pages');count('agent','Delegated 1 task','Delegated {n} tasks');count('other','1 tool call','{n} tool calls');
 const failed=steps.filter(s=>s.failed).length;if(failed)parts.push(t(failed===1?'1 failed':'{n} failed',{n:failed}));
 if(duration)parts.push(duration);
 return parts.join(' · ');
}

/** The target shown after the verb: a file name, the first command line, a pattern, a host or a description. */
export function stepTitle(step,t){
 if(step.kind==='read')return {verb:t('Read'),target:basename(step.path),title:step.path||''};
 if(step.kind==='edit'){const file=step.files[0]||'';return {verb:t(step.files.length>1?'Edited {n} files':'Edited',{n:step.files.length}),target:step.files.length>1?step.files.map(basename).join(', '):basename(file),title:step.files.join('\n'),stat:stat(step.added,step.removed)};}
 if(step.kind==='write')return {verb:t('Created'),target:basename(step.path),title:step.path||'',stat:stat(step.added,0)};
 if(step.kind==='command')return {verb:t('Ran'),target:(step.description||String(step.command||'').split('\n')[0]).slice(0,120),title:String(step.command||'')};
 if(step.kind==='search')return {verb:t('Searched'),target:String(step.query||'').slice(0,120),title:String(step.query||'')};
 if(step.kind==='web'){let host=step.url;try{host=new URL(step.url).host;}catch{}return {verb:t('Fetched'),target:String(host||'').slice(0,120),title:String(step.url||'')};}
 if(step.kind==='agent')return {verb:t('Delegated'),target:String(step.description||'').slice(0,120),title:String(step.description||'')};
 return {verb:step.name,target:step.path?basename(step.path):'',title:step.path||''};
}

function codeBlock(body,{numbers=true}={}){
 const pre=el('pre','nt-code');const content=String(body||'');const rows=lines(content.length>MAX_PREVIEW?content.slice(0,MAX_PREVIEW):content);
 if(!numbers){pre.textContent=content;return pre;}
 for(const [i,line] of rows.entries()){const row=el('span','nt-line');row.append(el('span','nt-ln',String(i+1)),el('span','nt-lt',line));pre.append(row);}
 if(content.length>MAX_PREVIEW)pre.append(el('span','nt-line is-note','…'));return pre;
}
function diffBlock(diff){
 const pre=el('pre','nt-code nt-diff');let a=0,b=0;
 for(const row of diff.rows){const line=el('span',`nt-line is-${row.type}`);const left=row.type==='add'?'':String(++a),right=row.type==='del'?'':String(++b);line.append(el('span','nt-ln',left),el('span','nt-ln',right),el('span','nt-mark',row.type==='add'?'+':row.type==='del'?'−':' '),el('span','nt-lt',row.text));pre.append(line);}
 if(diff.truncated)pre.append(el('span','nt-line is-note','…'));return pre;
}

/** Detail of one step, used inline under the step row and in the preview sheet. */
export function stepDetail(step,t){
 const box=el('div','nt-detail');
 if(step.kind==='edit'&&step.pairs){for(const p of step.pairs)box.append(diffBlock(diffLines(p.before,p.after)));}
 else if(step.kind==='edit'&&step.patch)box.append(codeBlock(step.patch,{numbers:false}));
 else if(step.kind==='edit'&&step.changes){for(const c of step.changes){box.append(el('div','nt-detail-path',c.path||''));if(c.diff||c.patch)box.append(codeBlock(c.diff||c.patch,{numbers:false}));}}
 else if(step.kind==='write')box.append(codeBlock(step.content));
 else if(step.kind==='read')box.append(codeBlock(stripReadNumbers(step.output)));
 else if(step.kind==='command'){const cmd=el('pre','nt-code nt-cmd');cmd.textContent=`$ ${step.command||''}`;box.append(cmd);if(step.output)box.append(codeBlock(step.output,{numbers:false}));if(step.exitCode!=null&&step.exitCode!==0)box.append(el('div','nt-detail-note',t('Exit code {exitCode}',{exitCode:step.exitCode})));}
 else{const args=step.args&&Object.keys(step.args).length?text(step.args):'';if(args)box.append(el('div','nt-detail-label',t('Arguments')),codeBlock(args,{numbers:false}));if(step.output)box.append(el('div','nt-detail-label',t('Output')),codeBlock(step.output,{numbers:false}));}
 if(step.error)box.append(el('div','nt-detail-error',step.error));
 if(step.item?.outputTruncated)box.append(el('div','nt-detail-note',t('Output is truncated; the CLI keeps the full text.')));
 return box;
}
/** Claude's Read output carries "   12→" prefixes; the code block numbers lines itself. */
function stripReadNumbers(output){const rows=lines(output);if(rows.length>2&&rows.slice(0,Math.min(rows.length,20)).every(l=>!l.trim()||/^\s*\d+→/.test(l)))return rows.map(l=>l.replace(/^\s*\d+→/,'')).join('\n');return output;}

/** Latest state of each file touched by the turn: an edit or write wins over a read of the same path. */
export function fileChips(steps){
 const byPath=new Map();
 for(const step of steps)for(const path of step.files||[]){const prior=byPath.get(path);if(!prior||step.kind!=='read'||prior.kind==='read')byPath.set(path,step);}
 return [...byPath].map(([path,step])=>({path,step}));
}

const THINKING=/^(?:Model is thinking|模型正在思考)/i;
/** Notes of one activity block: thinking signals and identical notes collapse to one row each, in first-seen order, with a count. */
export function noteRows(notes,t){
 const rows=new Map();
 for(const note of notes){
  const raw=stripAnsi(String(note.text||'')).replace(/\s+/g,' ').trim(),thinking=note.kind!=='error'&&THINKING.test(raw);
  const kind=note.kind==='error'?'error':thinking?'thinking':'note',text=thinking?t('Model is thinking'):raw.slice(0,160),key=`${kind}\0${text}`;
  if(!text)continue;const row=rows.get(key);if(row)row.count++;else rows.set(key,{kind,text,count:1});
 }
 return [...rows.values()];
}

/** The activity block: summary line with file chips; the step list opens on click (or stays open while live). */
export function activityBlock({steps,notes=[],t,live=false,duration='',open=false,onPreview,onToggle}){
 const box=el('details','nt-activity');box.open=open;
 const summary=el('summary','nt-activity-summary');
 const merged=noteRows(notes,t),onlyThinking=!steps.length&&merged.length===1&&merged[0].kind==='thinking';
 // 与摘要首项的顺序一致；混合操作不改变原有文字和数量。只有思考记录时，摘要用大脑图标。
 const kind=['read','edit','write','command','search','web','agent','other'].find(kind=>steps.some(step=>step.kind===kind))||(onlyThinking?'thinking':null);
 if(kind)summary.append(stepIcon(kind));
 summary.append(el('span','nt-caret'),el('span','nt-activity-text',summarizeSteps(steps,t,{duration})||(onlyThinking?`${t('Model is thinking')}${merged[0].count>1?` \u00d7${merged[0].count}`:''}`:t(live?'Working…':'No tool calls'))));
 const chips=fileChips(steps);
 if(chips.length){const row=el('span','nt-chips');for(const {path,step} of chips.slice(0,8)){const chip=el('button','nt-chip');chip.type='button';chip.title=path;chip.append(stepIcon(step.kind),el('span','',basename(path)));if(step.kind==='edit'&&(step.added||step.removed))chip.append(el('span','nt-chip-stat',stat(step.added,step.removed)));chip.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();onPreview?.(step,path);});row.append(chip);}if(chips.length>8)row.append(el('span','nt-chip-more',`+${chips.length-8}`));summary.append(row);}
 box.append(summary);
 const list=el('div','nt-steps');
 for(const step of steps){
  const row=el('div',`nt-step is-${step.kind}${step.failed?' is-failed':''}${step.running?' is-running':''}`);
  const head=el('button','nt-step-head');head.type='button';const {verb,target,title,stat:s}=stepTitle(step,t);
  head.append(stepIcon(step.kind),el('span','nt-step-verb',verb));const tgt=el('span','nt-step-target',target);tgt.translate=false;if(title)tgt.title=title;head.append(tgt);
  if(s)head.append(el('span','nt-step-stat',s));if(step.failed)head.append(el('span','nt-step-flag',t('Failed')));else if(step.running)head.append(el('span','nt-step-flag is-running',t('Running')));
  row.append(head);
  head.addEventListener('click',()=>{const openNow=row.classList.toggle('is-open');if(openNow&&!row.querySelector('.nt-detail'))row.append(stepDetail(step,t));});
  if(step.files?.length&&onPreview){const preview=el('button','nt-step-preview');preview.type='button';preview.title=t('Preview');preview.setAttribute('aria-label',t('Preview'));preview.textContent='↗';preview.addEventListener('click',()=>onPreview(step,step.files[0]));head.append(preview);}
  list.append(row);
 }
 // Runtime notes, merged: the same note shows once with "×N". The CLI's periodic "model is thinking" signal becomes one
 // thinking row with a brain icon; older records' "(native progress event received)" suffix is dropped.
 for(const note of noteRows(notes,t)){const row=el('div',`nt-step is-${note.kind}`);const head=el('div','nt-step-head is-static');head.append(stepIcon(note.kind),el('span','nt-step-target',note.text));if(note.count>1)head.append(el('span','nt-step-count',`\u00d7${note.count}`));row.append(head);list.append(row);}
 box.append(list);
 box.addEventListener('toggle',()=>onToggle?.(box.open));
 return box;
}

/** The turn's subagents and background shells: what each is, what it is doing now, whether it finished and how long it ran
 * (counting up while it runs). A task the record still calls running after its turn ended was stopped with it. */
export function taskBlock(turn,t,{live=false}={}){
 const tasks=turn?.tasks||[];if(!tasks.length)return null;
 const status=x=>x.status==='running'&&!live?'stopped':x.status,running=tasks.filter(x=>status(x)==='running').length;
 const agents=tasks.filter(x=>x.kind!=='shell').length,shells=tasks.length-agents;
 const box=el('div','nt-tasks'),head=el('div','nt-tasks-head');
 head.append(stepIcon('agent'),el('span','nt-tasks-title',[agents?t(agents===1?'1 subagent':'{n} subagents',{n:agents}):'',shells?t(shells===1?'1 background command':'{n} background commands',{n:shells}):''].filter(Boolean).join(' · ')));
 head.append(el('span',`nt-tasks-count${running?' is-running':''}`,running?t('{n} running',{n:running}):t('All finished')));
 box.append(head);
 for(const x of tasks){
  const state=status(x),row=el('div',`nt-task is-${state}`),name=el('span','nt-task-name',x.description||t(x.kind==='shell'?'Background command':'Subagent'));name.title=x.description||'';
  row.append(stepIcon(x.kind==='shell'?'command':'agent'),name);
  if(x.agentType){const type=el('span','nt-task-type',x.agentType);type.translate=false;row.append(type);}
  if(state==='running'&&x.activity){const now=el('span','nt-task-activity',x.activity);now.title=x.activity;row.append(now);}
  const took=state==='running'?elapsedText(x.startedAt):Number.isFinite(x.durationMs)?elapsedText(0,x.durationMs):x.endedAt?elapsedText(x.startedAt,new Date(x.endedAt).getTime()):'';
  const label=t(state==='running'?'Running':state==='completed'?'Finished':state==='failed'?'Failed':'Stopped');
  const end=el('span','nt-task-state');if(state==='running')end.append(el('span','nt-pulse'));end.append(el('span','',took?`${label} \u00b7 ${took}`:label));row.append(end);
  box.append(row);
 }
 return box;
}

/** A sheet over the transcript column that shows one file: a transcript step (latest edit as a diff, content read or written) or the file as it is on the device. */
/** The file sheet over the transcript. With onSide (Sessions page, desktop), "Open on the right" moves what it shows into the right-side Preview tab. */
export function createPreviewSheet(host,t,{onSide=null,canSide=()=>Boolean(onSide)}={}){
 let sheet=null;
 const onKey=e=>{if(e.key==='Escape'&&sheet)close();};
 const close=()=>{sheet?.remove();sheet=null;host.classList.remove('has-preview');document.removeEventListener('keydown',onKey);};
 function frame(path,{icon='read',kind='',actions=[],side=null}){
  close();sheet=el('aside','nt-sheet');sheet.setAttribute('aria-label',path);
  const head=el('header','nt-sheet-head'),name=el('div','nt-sheet-name');name.append(stepIcon(icon),el('strong','',basename(path)));name.translate=false;
  const dir=String(path||'').slice(0,Math.max(0,String(path||'').length-basename(path).length));const sub=el('div','nt-sheet-path',dir);sub.translate=false;sub.title=path;
  const titles=el('div','nt-sheet-titles');titles.append(name,sub);head.append(titles);
  if(kind)head.append(el('span','nt-sheet-kind',kind));
  for(const action of actions){const b=el('button','nt-sheet-btn');b.type='button';b.textContent=action.label;b.addEventListener('click',()=>action.onClick(b));head.append(b);}
  if(side&&canSide()){const b=el('button','nt-sheet-btn is-side');b.type='button';b.textContent=t('Open on the right');b.addEventListener('click',()=>{const item=side();close();onSide(item);});head.append(b);}
  const copy=el('button','nt-sheet-btn');copy.type='button';copy.textContent=t('Copy path');copy.addEventListener('click',()=>void navigator.clipboard?.writeText(path).catch(()=>{}));
  const x=el('button','nt-sheet-btn is-close');x.type='button';x.setAttribute('aria-label',t('Close'));x.textContent='\u00d7';x.addEventListener('click',close);
  head.append(copy,x);
  const body=el('div','nt-sheet-body');sheet.append(head,body);host.append(sheet);host.classList.add('has-preview');document.addEventListener('keydown',onKey);
  return body;
 }
 return {close,
  open(step,path,{actions=[]}={}){const kind=t(step.kind==='edit'?'Latest edit':step.kind==='write'?'Written content':step.kind==='read'?'Content read by the CLI':'Tool call');
   const body=frame(path,{icon:step.kind,kind,actions,side:()=>({title:basename(path),subtitle:`${kind} \u00b7 ${path}`,copyText:path,render:()=>{const box=el('div','nt-side-sheet');box.append(stepDetail(step,t));return box;}})});body.append(stepDetail(step,t));},
  openText(path,{content=null,note='',kind='',actions=[]}={}){const label=kind||t('Current file'),body=frame(path,{icon:'read',kind:label,actions,side:typeof content==='string'?()=>({title:basename(path),subtitle:`${label} \u00b7 ${path}`,copyText:content,render:()=>{const box=el('div','nt-side-sheet');box.append(codeBlock(content));return box;}}):null});if(typeof content==='string')body.append(codeBlock(content));if(note)body.append(el('p','nt-detail-note',note));},
  loading(path){const body=frame(path,{icon:'read',kind:t('Current file')});body.append(el('p','nt-detail-note',t('Loading\u2026')));}
 };
}

/** History rows grouped into turns: a prompt, then the prose and tool calls up to the next prompt. A tool result joins
 * its call by id; injected user rows (reminders, context) neither start a turn nor split one. A user row that noticeOf
 * names (a background task finishing) stays inside the running turn as a notice part. */
export function historyTurns(rows,{isPrompt=row=>row.role==='user',noticeOf=()=>''}={}){
 const turns=[],calls=new Map();let turn=null;
 const open=()=>{turn={prompt:null,parts:[],endedAt:null};turns.push(turn);return turn;};
 for(const row of rows){
  if(row.role==='user'){if(isPrompt(row)){turn=open();turn.prompt=row;continue;}const notice=noticeOf(row);if(!notice)continue;if(!turn)turn=open();turn.parts.push({kind:'notice',task:notice,timestamp:row.timestamp||null});continue;}
  if(row.role==='tool_result'){const tool=calls.get(row.callId);if(tool){tool.output=row.output||'';tool.failed=row.failed===true;tool.done=true;}continue;}
  if(!turn)turn=open();
  if(row.role==='tool_call'){const tool={kind:'tool',id:row.callId,name:row.name,input:row.input,output:'',failed:false,done:false,timestamp:row.timestamp||null};calls.set(row.callId,tool);turn.parts.push(tool);}
  else if(row.role==='assistant')turn.parts.push({kind:'text',text:row.text||'',timestamp:row.timestamp||null});
  else continue;
  if(row.timestamp)turn.endedAt=row.timestamp;
 }
 return turns;
}
