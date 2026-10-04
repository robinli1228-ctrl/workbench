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

/** Local or cloud documents in role replies open in a same-origin read-only page; the path is re-authorized by the Run workspace. */
export function runDocumentHref(href,runId){
  if(!runId||typeof href!=='string'||!/^(?:\/(?!\/)|\.\.?\/)/.test(href)||!/\.(?:md|markdown|txt)$/i.test(href))return null;
  return `/document.html?${new URLSearchParams({runId,path:href})}`;
}

export function linkRunDocuments(root,runId){
  if(!runId)return root;
  for(const link of root.querySelectorAll('a[href]')){
    const href=runDocumentHref(link.getAttribute('href'),runId);
    if(!href)continue;
    link.setAttribute('href',href);
    link.setAttribute('target','_blank');
    link.setAttribute('rel','opener');
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
    const strong = text.slice(cursor).match(/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/);
    if (strong) {
      const node = element('strong'); appendInline(node, strong[2]); parent.append(node); cursor += strong[0].length; continue;
    }
    const emphasis = text.slice(cursor).match(/^(\*|_)(?=\S)([^\n]*?\S)\1/);
    if (emphasis) {
      const node = element('em'); appendInline(node, emphasis[2]); parent.append(node); cursor += emphasis[0].length; continue;
    }
    const link = text.slice(cursor).match(/^\[([^\]\n]+)]\(([^)\s]+)\)/);
    if (link) {
      if (safeLink(link[2])) {
        const node = element('a'); node.setAttribute('href', link[2]);
        if (/^https?:/i.test(link[2])) { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
        appendInline(node, link[1]); parent.append(node);
      } else {
        parent.append(document.createTextNode(link[0]));
      }
      cursor += link[0].length; continue;
    }
    let end = cursor + 1;
    while (end < text.length && !/[\n\\`*_[\]]/.test(text[end])) end += 1;
    parent.append(document.createTextNode(text.slice(cursor, end))); cursor = end;
  }
}

function safeLink(href) {
  const value = String(href || '').trim();
  return /^(?:https?:\/\/|mailto:|#|\/|\.\.?\/)/i.test(value);
}
