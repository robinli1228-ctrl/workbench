import { t, dateLocale } from './i18n.js';
import {renderMarkdown} from './markdown.js';
import {readApiToken} from './browser-token.js';

const title=document.querySelector('#document-title');
const status=document.querySelector('#document-status');
const content=document.querySelector('#document-content');
const copy=document.querySelector('#document-copy');
const params=new URLSearchParams(location.search);
const runId=params.get('runId'),path=params.get('path');
const token=readApiToken();
window.opener=null;

/** File content comes only from the authorized Run API; Markdown never inserts raw HTML. */
async function openDocument(){
  if(!runId||!path)throw new Error('Incomplete document link');
  const name=path.split(/[\\/]/).at(-1)||'Project Document';
  title.textContent=name;document.title=`${name} · Agent Workbench`;
  const headers={};if(token)headers.Authorization=`Bearer ${token}`;
  const response=await fetch(`/api/runs/${encodeURIComponent(runId)}/document?path=${encodeURIComponent(path)}`,{headers});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||t('Read failed (HTTP {status})', { status: response.status }));
  const text=String(result.content||'');
  content.replaceChildren(/\.(?:md|markdown)$/i.test(name)?renderMarkdown(text):Object.assign(document.createElement('pre'),{textContent:text}));
  status.textContent=t('Full text loaded · {v} characters', { v: text.length.toLocaleString(dateLocale()) });
  copy.hidden=false;
  copy.addEventListener('click',async()=>{
    try {await navigator.clipboard.writeText(text);status.textContent=t('Full text copied · {v} characters', { v: text.length.toLocaleString(dateLocale()) });}
    catch(error){status.textContent=t('Copy failed: {message}', { message: error.message });}
  });
}

openDocument().catch(error=>{status.textContent=t('Unable to open document: {message}', { message: error.message });title.textContent='Document unavailable';});
