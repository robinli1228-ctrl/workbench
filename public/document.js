import {copyText} from './role-icons.js';
import { t, dateLocale } from './i18n.js';
import {renderMarkdown} from './markdown.js';
import {simplifiedCliOutput} from './output-language.js';
import {readApiToken} from './browser-token.js';

const title=document.querySelector('#document-title');
const status=document.querySelector('#document-status');
const content=document.querySelector('#document-content');
const copy=document.querySelector('#document-copy');
const params=new URLSearchParams(location.search);
const runId=params.get('runId'),projectId=params.get('projectId'),scopeId=params.get('scopeId'),path=params.get('path');
const token=readApiToken();
window.opener=null;

/** File content comes only from the authorized Run API; Markdown never inserts raw HTML. */
async function openDocument(){
  if((!runId&&(!projectId||!scopeId))||!path)throw new Error('Incomplete document link');
  const name=path.split(/[\\/]/).at(-1)||'Project Document';
  title.textContent=name;document.title=`${name} · Agent Workbench`;
  const headers={};if(token)headers.Authorization=`Bearer ${token}`;
  const endpoint=projectId?`/api/projects/${encodeURIComponent(projectId)}/local-file?${new URLSearchParams({scopeId,path})}`:`/api/runs/${encodeURIComponent(runId)}/document?path=${encodeURIComponent(path)}`;
  const response=await fetch(endpoint,{headers});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||t('Read failed (HTTP {status})', { status: response.status }));
  if(result.shared){const location=document.createElement('p');location.setAttribute('translate','no');location.textContent=result.path||t('Waiting for local synchronization');status.after(location);}
  if(result.shared&&result.content===null){status.textContent=t(result.preview==='binary'?'Binary file; preview unavailable.':result.preview==='too_large'?(result.reason==='serialized_response_limit'?'Text preview exceeds the serialized response size limit.':'File synchronized; text preview exceeds 600 KB.'):result.syncState==='missing'?'Local file not found.':'Waiting for local synchronization');return;}
  const text=String(result.content||'');
  content.replaceChildren(/\.(?:md|markdown)$/i.test(name)?renderMarkdown(simplifiedCliOutput(text)):Object.assign(document.createElement('pre'),{textContent:text}));
  status.textContent=t('Full text loaded · {v} characters', { v: text.length.toLocaleString(dateLocale()) });
  if(result.syncState==='conflict'||result.syncState==='local_changes')status.textContent+=' · '+t(result.syncState==='conflict'?'Conflict detected; showing actual local file.':'Showing local changes; synchronization pending.');
  copy.hidden=false;
  copy.addEventListener('click',async()=>{
    try {await copyText(copy,text);status.textContent=t('Full text copied · {v} characters', { v: text.length.toLocaleString(dateLocale()) });}
    catch(error){status.textContent=t('Copy failed: {message}', { message: error.message });}
  });
}

openDocument().catch(error=>{status.textContent=t('Unable to open document: {message}', { message: error.message });title.textContent='Document unavailable';});
