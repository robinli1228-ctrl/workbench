/** Pasted text over this many characters goes in as a text attachment, so the input box stays short. */
export const PASTE_TEXT_LIMIT=200;

/** Whether pasted text becomes an attachment: characters are counted (not UTF-16 units), surrounding blank space is not. */
export const pastesAsFile=text=>[...String(text||'').trim()].length>PASTE_TEXT_LIMIT;

/** The attachment's name: the first non-empty line, made safe for a file name, as Markdown so both chats can preview it. */
export function pastedTextName(text){
  const title=String(text||'').split(/\r\n|\r|\n/).find(line=>line.trim())||'Pasted text';
  const stem=[...title.replace(/^\s*#+\s*/,'').replace(/[\x00-\x1f/\\:*?"<>|]/g,'_').trim()].slice(0,48).join('').trim()||'Pasted text';
  return `${stem.replace(/\.(md|markdown|txt)$/i,'')}.md`;
}

/** Text attachments open as text: pasted text and any Markdown or plain-text file. */
export const isTextName=name=>/\.(md|markdown|txt)$/i.test(String(name||''));
