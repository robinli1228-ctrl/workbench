import OpenCC from 'opencc-js';
import { trIn } from './i18n.mjs';

const convert = OpenCC.Converter({from:'cn',to:'t'});
const protectedText = /(`+)[^\n]*?\1|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\u201c[^\u201d]*\u201d|\u2018[^\u2019]*\u2019|\u300c[^\u300d]*\u300d|\u300e[^\u300f]*\u300f|https?:\/\/[^\s<>]+|\]\([^\n)]*\)/g;
const token = /[^\s\u3000\u3001\u3002\uff0c\uff1b\uff01\uff1f<>`]+/g;
const command = /^\s*(?:[$>]\s+|(?:\.{1,2}\/|~\/|\/|[A-Za-z]:\\)|(?:sudo|env|git|cat|rg|grep|find|sed|awk|echo|printf|python\d*|node|npm|npx|pnpm|yarn|bash|sh|zsh|curl|wget|ssh|scp|rsync|docker|kubectl|systemctl|apt(?:-get)?|pip\d*|claude|grok|agy|codex|mkdir|rm|mv|cp|chmod|chown|touch|ls|cd|pwd|test|export|source|make|cmake|gradle|gradlew|mvn|cargo|go|dotnet|composer|uv|java|javac|ruby|perl|powershell|pwsh|pytest|const|let|var|function|class|import)\b|[A-Za-z_][\w]*=|[{}\[\]]|#!)/;
// A bare ASCII executable followed by Chinese arguments is ambiguous; preserve it rather than rename a build target.
const ambiguousCommand = /^\s*[A-Za-z_][\w.-]*\s+(?=[^\n]*\p{Script=Han})/u;

/** Model-facing maintained text is independent of the browser's language; interpolation keeps user values intact. */
export function executionText(key,params) {
  return trIn('en',key,params);
}

/** Convert a send-only prose copy, not executable text or strings that must match files and tools exactly. */
export function traditionalInput(text) {
  if(typeof text!=='string'||!text)return text;
  let fence=null;
  const prose=value=>value.replace(token,value=>/[._/@=\\]/.test(value)?value:convert(value));
  return text.match(/[^\n]*\n|[^\n]+$/g).map(line=>{
    const marker=line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if(marker) {
      const value=marker[1];
      if(!fence)fence=value;
      else if(value[0]===fence[0]&&value.length>=fence.length)fence=null;
      return line;
    }
    if(fence||/^(?: {4}|\t)/.test(line)||command.test(line)||ambiguousCommand.test(line))return line;
    let offset=0,result='';
    for(const match of line.matchAll(protectedText)) {
      result+=prose(line.slice(offset,match.index))+match[0];
      offset=match.index+match[0].length;
    }
    return result+prose(line.slice(offset));
  }).join('');
}
