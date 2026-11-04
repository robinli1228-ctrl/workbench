import {t} from './i18n.js';

/**
 * Cross-device access, shared by project settings (for the project's roles) and session settings: one row per device with
 * a read and a write level for wb device. Unset devices read everything and write the project folder (Home's defaults in
 * src/device-access.mjs). Any change saves the whole map at once.
 */
export const DEVICE_ACCESS_LEVELS=['none','project','platform','all'];
export const DEFAULT_DEVICE_ACCESS=Object.freeze({read:'all',write:'project'});
const LABELS={none:'Not allowed',project:'Project folder',platform:'Platform folders',all:'Whole device'};

export function deviceAccessRows({workers=[],value={},save,create,disabled=false}){
  const current=JSON.parse(JSON.stringify(value||{}));
  return workers.map(worker=>{
    const name=worker.name||worker.id,row=create('div','settings-row device-access-row'),main=create('span','settings-row-main');
    const title=create('strong','',name);title.setAttribute('translate','no');main.append(title);
    const pick=kind=>{
      const wrap=create('label','device-access-pick'),select=create('select');
      select.setAttribute('aria-label',t(kind==='read'?'Read on {device}':'Write on {device}',{device:name}));select.disabled=disabled;
      for(const level of DEVICE_ACCESS_LEVELS){const option=create('option','',t(LABELS[level]));option.value=level;select.append(option);}
      select.value=current[worker.id]?.[kind]||DEFAULT_DEVICE_ACCESS[kind];
      select.addEventListener('change',()=>{current[worker.id]={...DEFAULT_DEVICE_ACCESS,...current[worker.id],[kind]:select.value};void save(JSON.parse(JSON.stringify(current)));});
      wrap.append(create('span','',t(kind==='read'?'Read':'Write')),select);
      return wrap;
    };
    row.append(main,pick('read'),pick('write'));
    return row;
  });
}
