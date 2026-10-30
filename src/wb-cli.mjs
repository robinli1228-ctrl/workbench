import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadTurnContext } from './turn-context.mjs';
import { agentRequest } from './agent-bridge.mjs';
import { setupCatalog, setupPropose } from './setup-tools.mjs';
import { conversationTask, helpText, historySearchInput, memorySearchInput, chatPost, callRole, waitForRole, requestDelivery, parseDeliveryArgs } from './wb-tools.mjs';
import { tr } from './i18n.mjs';

function out(data) {
  process.stdout.write(`${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n`);
}

/** Session queries accept only explicit pagination parameters and never swallow unknown parameters into the current project request. */
function sessionOptions(args) {
  const values={};
  const names={'--offset':'offset','--limit':'limit','--version':'version','--cursor':'cursor'};
  for(let i=0;i<args.length;i+=2) {
    const key=names[args[i]],value=args[i+1];
    if(!key || value===undefined || values[key]!==undefined)throw new Error(tr('wbCli.invalidSessionQueryParameters'));
    values[key]=['offset','limit'].includes(key)?Number(value):value;
  }
  return values;
}

const COMMANDS=['task','sync','discuss','capabilities','session','setup','history','memory','device','timer','note','wait','deliver','call'];

export async function main(argv = process.argv.slice(2)) {
  const turnId=argv[0]==='--turn'?argv[1]:undefined;
  if(argv[0]==='--turn')argv=argv.slice(2);
  const [cmd, sub, ...rest] = argv;
  const tail = [sub, ...rest].filter(v => v !== undefined);
  try {
    // Discovery must work even when a retained process inherited a deleted turn context.
    // Long-form guidance that left the platform template: read on demand, no turn context needed.
    // A sessions-page CLI has no Run and no collaboration tools: only platform memory search, relayed by its Worker.
    if(process.env.WB_NATIVE==='1'){
      if(cmd==='memory'&&sub==='search'&&!tail.some(value=>['--help','-h'].includes(value)))return out(await agentRequest('/api/agent/native-memory/search',memorySearchInput(rest)));
      if(cmd==='device'&&['ls','read'].includes(sub)&&rest.length<=1){
        let input={};if(rest.length)try{input=JSON.parse(rest[0]);}catch{throw new Error(tr('wbCli.nativeDeviceUsage'));}
        if(!input||typeof input!=='object'||Array.isArray(input))throw new Error(tr('wbCli.nativeDeviceUsage'));
        return out(await agentRequest('/api/agent/native-device-read',{...input,action:sub}));
      }
      if(!cmd||['help','-h','--help'].includes(cmd)||cmd==='memory')return out(tr('wbCli.nativeHelp'));
      throw new Error(tr('wbCli.nativeHelp'));
    }
    if(['help','-h','--help'].includes(cmd)&&['review','sync','errors'].includes(sub))return out(tr(`wbTools.help${sub[0].toUpperCase()}${sub.slice(1)}`));
    if(!cmd||['help','-h','--help'].includes(cmd)||(tail.some(value=>['--help','-h'].includes(value))&&!tail.includes('--'))||(cmd==='deliver'&&sub==='help'))
      return out(helpText());
    if(['report','schedule','collaboration','pass','notify'].includes(cmd))throw new Error(tr(`wbCli.retired.${cmd}`));
    if(!COMMANDS.includes(cmd))throw new Error(tr('wbCli.unknownCommand',{cmd,HELP:helpText()}));
    loadTurnContext(process.env,{turnId});
    const supervisor = process.env.WB_SYSTEM_SUPERVISOR === '1';
    const sourceSync=process.env.WB_SOURCE_SYNC==='1';
    if(cmd==='task'){
      if(sub==='list'&&(!rest.length||rest.length===2&&rest[0]==='--status'))return out(await conversationTask('list',rest.length?{status:rest[1]}:{}));
      if(sub==='show'&&rest.length===1)return out(await conversationTask('show',{id:rest[0]}));
      if(sub==='create'&&rest.length===1)return out(await conversationTask('create',JSON.parse(rest[0])));
      if(sub==='update'&&rest.length===2)return out(await conversationTask('update',{...JSON.parse(rest[1]),id:rest[0]}));
      throw new Error(tr('conversationTasks.help'));
    }
    if(cmd==='sync'){
      if(!sourceSync)throw new Error(tr('sourceSync.failure',{code:'worker_unsupported',detail:''}));
      if(!['status','read','request','assign','propose'].includes(sub)||rest.length>1)throw new Error(tr('sourceSync.toolGuide'));
      return out(await agentRequest('/api/agent/source-sync',{runId:process.env.WB_RUN_ID,action:sub,input:rest.length?JSON.parse(rest[0]):{}}));
    }
    if(cmd==='discuss') {
      if(sub!=='peers'||rest.length>1)throw new Error(tr('wbCli.discussPeersUsage'));
      return out(await agentRequest('/api/agent/discussions',{runId:process.env.WB_RUN_ID,action:'peers',input:rest.length?JSON.parse(rest[0]):{view:'summary'}}));
    }
    if (cmd === 'capabilities') return out({protocol:2,sourceSyncTools:sourceSync?1:0,sessionTools:1,timerTools:1,transfer:1,
      tools:[...(sourceSync?['sync status','sync read','sync request','sync propose',...(supervisor?['sync assign']:[])]:[]),'task list','task show','task create','task update','discuss peers','call','wait','note','timer',
        'history','history search','history read','history summary','memory search','device ls','device read','deliver','session current',...(process.env.WB_PLATFORM_ASSISTANT==='1'?['setup catalog','setup propose']:[])]});
    if (cmd === 'session' && sub === 'current') return out(await agentRequest('/api/agent/sessions/current',{runId:process.env.WB_RUN_ID}));
    // Configuration cards belong to the platform assistant; project roles read the team with wb discuss peers.
    if (cmd === 'setup' && process.env.WB_PLATFORM_ASSISTANT === '1' && sub === 'catalog') return out(await setupCatalog());
    if (cmd === 'setup' && process.env.WB_PLATFORM_ASSISTANT === '1' && sub === 'propose') return out(await setupPropose(JSON.parse(rest.join(' '))));
    if (cmd === 'setup') throw new Error(tr('wbCli.setupAssistantOnly'));
    if (cmd === 'history' && sub === 'search') return out(await agentRequest('/api/agent/history/search',{runId:process.env.WB_RUN_ID,...historySearchInput(rest)}));
    if (cmd === 'history' && sub === 'read') {
      if(!rest[0]||rest.length>3)throw new Error(tr('wbCli.historyReadUsage'));
      return out(await agentRequest('/api/agent/history/read',{runId:process.env.WB_RUN_ID,kind:'auto',id:rest[0],offset:rest[1]===undefined?0:Number(rest[1]),version:rest[2]}));
    }
    if (cmd === 'history' && sub === 'summary') return out(await agentRequest('/api/agent/conversation/summary',{runId:process.env.WB_RUN_ID,...sessionOptions(rest)}));
    // Bare wb history lists the latest messages; any other words are search terms, as with wb history search.
    if (cmd === 'history') return out(await agentRequest('/api/agent/history/search',{runId:process.env.WB_RUN_ID,...historySearchInput(tail)}));
    if (cmd === 'memory') {
      if (sub !== 'search') throw new Error(tr('platformMemory.searchUsage'));
      return out(await agentRequest('/api/agent/memory/search',{runId:process.env.WB_RUN_ID,...memorySearchInput(rest)}));
    }
    if (cmd === 'device') {
      if (!['ls','read'].includes(sub) || rest.length !== 1) throw new Error(tr('wbCli.deviceUsage'));
      let input;try{input=JSON.parse(rest[0]);}catch{throw new Error(tr('wbCli.deviceUsage'));}
      if(!input||typeof input!=='object'||Array.isArray(input))throw new Error(tr('wbCli.deviceUsage'));
      return out(await agentRequest('/api/agent/device-read',{...input,runId:process.env.WB_RUN_ID,action:sub}));
    }
    if (cmd === 'timer') {
      if (sub === 'list' && !rest.length) return out(await agentRequest('/api/agent/timers',{runId:process.env.WB_RUN_ID,action:'list'}));
      if (!['create','update','pause','resume','delete'].includes(sub) || rest.length !== 1) throw new Error(tr('wbCli.usageWbTimerListWb'));
      return out(await agentRequest('/api/agent/timers',{...JSON.parse(rest[0]),runId:process.env.WB_RUN_ID,action:sub}));
    }
    if (cmd === 'note') return out(await chatPost(tail.join(' ')));
    if (cmd === 'wait') {
      if(tail.length===1&&tail[0].trim().startsWith('{')){const input=JSON.parse(tail[0]);if(Object.keys(input).some(k=>!['summary','requestIds','timeoutSeconds'].includes(k)))throw new Error(tr('minimal.invalidWait'));return out(await waitForRole(input.summary,input));}
      return out(await waitForRole(tail.join(' ')));
    }
    if (cmd === 'deliver') {
      if (['help', '-h', '--help'].includes(sub)) return out(tr('wbTools.deliveryUsage'));
      const {requestId,commit,summary,...options}=parseDeliveryArgs(tail);
      return out(await requestDelivery(requestId,commit,summary,options));
    }
    if (cmd === 'call') {
      const values = {}, flags = { '--role': 'role', '--kind': 'kind', '--request-id': 'requestId', '--text': 'text', '--file':'file', '--delivery-id': 'deliveryId','--source-sync-batch-id':'sourceSyncBatchId',
        '--task':'task','--goal':'goal','--scope':'scope','--input':'input','--return':'returns' };
      for (let i = 0; i < tail.length; i += 2) {
        const key = flags[tail[i]];
        if (!key || tail[i + 1] === undefined || key!=='role'&&values[key] !== undefined) throw new Error(tr('wbCli.invalidDuplicateWbCallParameters'));
        if(key==='role'&&values.role!==undefined){values.roles||=[values.role];values.roles.push(tail[i+1]);continue;}
        values[key] = tail[i + 1];
      }
      if(values.roles)delete values.role;
      return out(await callRole(values));
    }
    throw new Error(tr('wbCli.unknownCommand', { cmd, HELP: helpText() }));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
