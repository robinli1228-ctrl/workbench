import {t} from './i18n.js';

/** Model discovery is not a billing check; retain the warning even for a saved, temporarily unavailable Fable. */
export function renderModelUsageNotice(note,runtime,model){
  if(!note)return;
  const fable=runtime==='claude'&&(model?.usageCreditsMayApply===true||/^(?:fable(?:$|\[)|claude-fable-)/i.test(model?.id||''));
  note.hidden=!fable;
  note.textContent=fable?t('Fable may use paid usage credits depending on your plan. Workbench runs Claude Code non-interactively, so charges may occur without another confirmation. Check your account billing before saving. Discovery does not run the model or enable credit purchases; current tasks keep their model.'):'';
}
