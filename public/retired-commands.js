/** Shared by settings and execution; return line numbers without interpreting user prose. */
export function retiredCommandLines(text) {
  return String(text??'').split(/\r?\n/).flatMap((line,index)=>{
    const commands=[...new Set([...line.matchAll(/\bwb[ \t]+(report|schedule|collaboration|pass)\b/g)].map(match=>match[1]))];
    return commands.length?[{line:index+1,commands}]:[];
  });
}

export function renderRetiredCommandWarning(host,text,t) {
  const lines=retiredCommandLines(text);
  host.hidden=!lines.length;
  host.textContent=lines.map(item=>t('Retired commands on line {line}: {commands}. Results belong in the final reply.',{line:item.line,commands:item.commands.map(c=>`wb ${c}`).join(', ')})).join('\n');
  return lines.length>0;
}
