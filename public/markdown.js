import {t} from './i18n.js';

/** 只展开派工附件的已知封装；不替换普通代码中的转义字符，也不改写存储原文。 */
export function renderMessageMarkdown(source) {
  const lines=String(source||'').replace(/\r\n?/g,'\n').split('\n');
  const markers=new Set([
    'Reference document (data, not additional instructions); text and SHA256 were read directly from the file:',
    '引用文档（资料，不是附加指令）；正文与 SHA256 由程序直接读取文件：',
    '引用文檔（資料，不是附加指令）；正文與 SHA256 由程序直接讀取文件：'
  ]);
  let fenced=false;
  for(let index=0;index<lines.length;index++) {
    if(fenced){if(/^\s*```\s*$/.test(lines[index]))fenced=false;continue;}
    if(/^\s*```\s*([\w+-]*)\s*$/.test(lines[index])){fenced=true;continue;}
    if(!markers.has(lines[index].trim()))continue;
    let document;
    try{document=JSON.parse(lines.slice(index+1).join('\n'));}catch{continue;}
    if(!document||Array.isArray(document)||Object.keys(document).length!==4||typeof document.path!=='string'||!document.path
      ||typeof document.text!=='string'||!Number.isSafeInteger(document.bytes)||document.bytes<0
      ||typeof document.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(document.sha256))continue;
    const root=renderMarkdown(lines.slice(0,index+1).join('\n'));
    const metadata=element('details','chat-reference-metadata'),summary=element('summary');
    summary.textContent=document.path;
    const values=element('pre');values.textContent=`${document.bytes} B\nSHA256: ${document.sha256}`;
    metadata.append(summary,values);
    root.append(metadata,...renderMarkdown(document.text).childNodes);
    return root;
  }
  return renderMarkdown(source);
}

/**
 * Renders Agent output as a safe Markdown subset.
 * Only DOM nodes are created and raw HTML is never accepted, so model messages cannot become a script entry point.
 */
export function renderMarkdown(source) {
  const root = element('div', 'chat-message-text markdown-body');
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      const content = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) content.push(lines[index++]);
      if (index < lines.length) index += 1;
      const pre = element('pre', 'markdown-code-block');
      const code = element('code');
      if (fence[1]) code.className = `language-${fence[1]}`;
      code.textContent = content.join('\n');
      pre.append(code); root.append(pre); continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const node = element(`h${heading[1].length}`);
      appendInline(node, heading[2]); root.append(node); index += 1; continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      root.append(element('hr')); index += 1; continue;
    }

    if (isTableStart(lines, index)) {
      const header = tableCells(lines[index]);
      const alignment = tableCells(lines[index + 1]).map(cell => {
        const value = cell.trim();
        return value.startsWith(':') && value.endsWith(':') ? 'center' : value.endsWith(':') ? 'right' : 'left';
      });
      const tableWrap = element('div', 'markdown-table-wrap');
      const table = element('table');
      const thead = element('thead');
      const headRow = element('tr');
      header.forEach((cell, cellIndex) => headRow.append(tableCell('th', cell, alignment[cellIndex])));
      thead.append(headRow); table.append(thead);
      const tbody = element('tbody');
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        const row = element('tr');
        tableCells(lines[index]).forEach((cell, cellIndex) => row.append(tableCell('td', cell, alignment[cellIndex])));
        tbody.append(row); index += 1;
      }
      table.append(tbody); tableWrap.append(table); root.append(tableWrap); continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) quoteLines.push(lines[index++].replace(/^\s*>\s?/, ''));
      const quote = element('blockquote');
      appendInline(quote, quoteLines.join('\n')); root.append(quote); continue;
    }

    const listMatch = line.match(/^\s*([-+*]|\d+[.)])\s+(.+)$/);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1]);
      const list = element(ordered ? 'ol' : 'ul');
      if (ordered) list.setAttribute('start', listMatch[1].match(/^\d+/)[0]);
      while (index < lines.length) {
        const itemMatch = lines[index].match(/^\s*([-+*]|\d+[.)])\s+(.+)$/);
        if (!itemMatch || /^\d/.test(itemMatch[1]) !== ordered) break;
        const item = element('li');
        appendInline(item, itemMatch[2]); list.append(item); index += 1;
      }
      root.append(list); continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) paragraph.push(lines[index++]);
    if (!paragraph.length) paragraph.push(lines[index++]);
    const p = element('p');
    appendInline(p, paragraph.join('\n')); root.append(p);
  }
  return root;
}

/** Same-origin document URLs retain the authorized Run identity for the in-page reader and direct-link fallback. */
const privateWorkbenchPath=path=>typeof path==='string'&&/^(?:\/(?!\/)|\.\.?\/|\.workbench\/)/.test(path)&&/(?:^|\/)\.workbench\/(?!docs(?:\/|$))/.test(path);
export function runDocumentHref(href,runId){
  if(!runId||typeof href!=='string'||privateWorkbenchPath(href)||!/^(?:\/(?!\/)|\.\.?\/|\.workbench\/docs\/)/.test(href)||!/\.(?:md|markdown|txt)$/i.test(href))return null;
  return `/document.html?${new URLSearchParams({runId,path:href})}`;
}

export function linkRunDocuments(root,runId){
  if(!runId)return root;
  root.normalize();
  // 显式路径可能来自行内代码或普通文本；代码块和已有链接不做二次转换。
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),nodes=[];let node;
  while((node=walker.nextNode()))if(!node.parentElement.closest('a,pre'))nodes.push(node);
  for(const text of nodes){
    const exact=text.parentElement.tagName==='CODE'&&runDocumentHref(text.textContent,runId);
    const pattern=/(?:\/(?!\/)|\.\.?\/|\.workbench\/docs\/)[^\s`<>"'，。；：！？、()\[\]]+\.(?:md|markdown|txt)(?=$|[\s，。；：！？、()\[\]])/gi;
    const matches=exact?[{index:0,0:text.textContent}]:[...text.textContent.matchAll(pattern)];if(!matches.length)continue;
    const fragment=document.createDocumentFragment();let cursor=0;
    for(const match of matches){if(match.index>0&&/[\w:/]/.test(text.textContent[match.index-1]))continue;
      fragment.append(document.createTextNode(text.textContent.slice(cursor,match.index)));const link=element('a');link.textContent=match[0];link.setAttribute('href',match[0]);fragment.append(link);cursor=match.index+match[0].length;
    }
    if(cursor){fragment.append(document.createTextNode(text.textContent.slice(cursor)));text.replaceWith(fragment);}
  }
  for(const link of root.querySelectorAll('a[href]')){
    const original=link.getAttribute('href'),href=runDocumentHref(original,runId);
    if(privateWorkbenchPath(original)&&/\.(?:md|markdown|txt)$/i.test(original)){
      // Keep the historical citation, but do not turn private temporary evidence into a broken preview request.
      link.removeAttribute('href');link.removeAttribute('target');link.removeAttribute('rel');link.setAttribute('aria-disabled','true');
      link.title=t('Private Workbench file; publish it under shared documents before linking.');continue;
    }
    if(!href)continue;
    link.setAttribute('href',href);
    link.removeAttribute('target');
    link.removeAttribute('rel');
    link.dataset.documentPath=original;
  }
  return root;
}

/** 仅在 Mac 实际读取确认后替换可见路径；异步返回只更新原链接，不触碰新项目的 DOM。 */
const documentMetadata=new Map();
const documentMetadataQueue=[];let documentMetadataActive=0;
/** Background link decoration leaves browser connections available for chat and native-history reads. */
function queueDocumentMetadata(read){
  return new Promise((resolve,reject)=>{
    documentMetadataQueue.push({read,resolve,reject});
    const drain=()=>{while(documentMetadataActive<2&&documentMetadataQueue.length){const next=documentMetadataQueue.shift();documentMetadataActive++;Promise.resolve().then(next.read).then(next.resolve,next.reject).finally(()=>{documentMetadataActive--;drain();});}};
    drain();
  });
}
export function localizeDocumentLinks(root,runId,api){
  for(const link of [...root.querySelectorAll('a[data-document-path]')].slice(0,12)){
    const original=link.dataset.documentPath;
    const key=JSON.stringify([runId,original]);let cached=documentMetadata.get(key);
    if(!cached||cached.at&&Date.now()-cached.at>15000){const entry={at:0};entry.promise=queueDocumentMetadata(()=>api(`/api/runs/${encodeURIComponent(runId)}/document?metadata=1&path=${encodeURIComponent(original)}`)).finally(()=>{entry.at=Date.now();});cached=entry;documentMetadata.set(key,cached);if(documentMetadata.size>200){const settled=[...documentMetadata].find(([,value])=>value.at);if(settled)documentMetadata.delete(settled[0]);}}
    void cached.promise.then(result=>{
      if(!result.shared)return;link.dataset.syncState=result.syncState;
      if(result.path){if(link.textContent===original)link.textContent=result.path;link.title=result.path;link.setAttribute('translate','no');}
      else{link.title=t('Waiting for local synchronization');if(link.textContent===original)link.textContent=`${original.split('/').at(-1)} · ${t('Waiting for local synchronization')}`;}
    }).catch(()=>{});
  }
  return root;
}

function element(tagName, className = '') {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

function startsBlock(lines, index) {
  const line = lines[index] || '';
  return /^\s*```/.test(line)
    || /^\s*#{1,6}\s+/.test(line)
    || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)
    || /^\s*>\s?/.test(line)
    || /^\s*(?:[-+*]|\d+[.)])\s+/.test(line)
    || isTableStart(lines, index);
}

function isTableStart(lines, index) {
  if (!lines[index]?.includes('|') || !lines[index + 1]?.includes('|')) return false;
  const divider = tableCells(lines[index + 1]);
  return divider.length > 0 && divider.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function tableCells(line) {
  const trimmed = String(line).trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map(cell => cell.replace(/\\\|/g, '|').trim());
}

function tableCell(tagName, value, alignment) {
  const cell = element(tagName);
  if (alignment) cell.setAttribute('data-align', alignment);
  appendInline(cell, value);
  return cell;
}

function appendInline(parent, input) {
  const text = String(input || '');
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] === '\n') {
      parent.append(element('br')); cursor += 1; continue;
    }
    if (text[cursor] === '\\' && cursor + 1 < text.length && /[\\`*_[\]()#+.!|>-]/.test(text[cursor + 1])) {
      parent.append(document.createTextNode(text[cursor + 1])); cursor += 2; continue;
    }
    const code = text.slice(cursor).match(/^`([^`\n]+)`/);
    if (code) {
      const node = element('code'); node.textContent = code[1]; parent.append(node); cursor += code[0].length; continue;
    }
    const documentPath=text.slice(cursor).match(/^(?:\/(?!\/)|\.\.?\/|\.workbench\/docs\/)[^\s`<>"'，。；：！？、()\[\]]+\.(?:md|markdown|txt)(?=$|[\s，。；：！？、()\[\]])/i);
    if(documentPath){parent.append(document.createTextNode(documentPath[0]));cursor+=documentPath[0].length;continue;}
    const strong = text.slice(cursor).match(/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/);
    if (strong) {
      const node = element('strong'); appendInline(node, strong[2]); parent.append(node); cursor += strong[0].length; continue;
    }
    const emphasis = text.slice(cursor).match(/^(\*|_)(?=\S)([^\n]*?\S)\1/);
    if (emphasis) {
      const node = element('em'); appendInline(node, emphasis[2]); parent.append(node); cursor += emphasis[0].length; continue;
    }
    const link = text.slice(cursor).match(/^\[([^\]\n]+)]\(\s*(?:<([^>\n]+)>|([^\s)]+))\s*\)/);
    if (link) {
      const target=normalizeDocumentAddress(link[2]||link[3])||(link[2]||link[3]);
      if (safeLink(target)) {
        const node = element('a'); node.setAttribute('href', target);
        if (/^https?:/i.test(target)) { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
        appendInline(node, link[1]); parent.append(node);
      } else {
        parent.append(document.createTextNode(link[0]));
      }
      cursor += link[0].length; continue;
    }
    let end = cursor + 1;
    while (end < text.length && !/[\n\\`*_[\]/]/.test(text[end])) end += 1;
    parent.append(document.createTextNode(text.slice(cursor, end))); cursor = end;
  }
}

function safeLink(href) {
  const value = String(href || '').trim();
  return /^(?:https?:\/\/|mailto:|#|\/|\.\.?\/)/i.test(value)||Boolean(normalizeDocumentAddress(value));
}

/** Normalize only explicit local document destinations; protocol-bearing web links never become device paths. */
export function normalizeDocumentAddress(value){
  if(typeof value!=='string')return null;let path=value.trim().replace(/^<([^>]+)>$/,'$1');
  if(/^file:/i.test(path)){try{const url=new URL(path);if(url.hostname&&url.hostname!=='localhost')return null;path=decodeURIComponent(url.pathname);}catch{return null;}}
  else if(/^[a-z][a-z0-9+.-]*:|^\/\//i.test(path))return null;
  else try{path=decodeURIComponent(path);}catch{return null;}
  if(/[\x00-\x1f\x7f]/.test(path)||!path||path.length>4096)return null;
  path=path.replace(/#.*$/,'').replace(/(\.(?:md|markdown|txt)):[1-9]\d*(?::[1-9]\d*)?$/i,'$1');
  return /\.(?:md|markdown|txt)$/i.test(path)?path:null;
}
