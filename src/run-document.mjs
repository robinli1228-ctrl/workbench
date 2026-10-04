import {readFile,realpath,stat} from 'node:fs/promises';
import {isAbsolute,relative,resolve,sep} from 'node:path';

const MAX_DOCUMENT_BYTES=600000;

/** Read only text inside the current Run workspace; the platform artifact directory is additionally allowed, other hidden directories are not. */
export async function readRunDocument(workspace,path){
  if(typeof path!=='string'||!path.trim())throw new Error('Invalid document path');
  const root=await realpath(workspace),file=await realpath(resolve(root,path));
  const rel=relative(root,file);
  if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new Error('File escapes the workspace');
  const parts=rel.split(sep),managed=parts[0]==='.workbench'&&parts[1]==='docs';
  if(parts.some((part,index)=>part.startsWith('.')&&!(managed&&index===0)||/credential|secret/i.test(part)))throw new Error('Reading this path is not allowed');
  if(!/\.(?:md|markdown|txt)$/i.test(file))throw new Error('Only Markdown and text files are supported');
  const info=await stat(file);
  if(!info.isFile()||info.size>MAX_DOCUMENT_BYTES)throw new Error('Document exceeds the 600KB reading limit');
  const content=await readFile(file,'utf8');
  if(content.includes('\0'))throw new Error('Binary files cannot be read as text');
  return {path:rel,content};
}
