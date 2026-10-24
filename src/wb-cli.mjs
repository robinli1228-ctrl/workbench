import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadTurnContext } from './turn-context.mjs';
import { agentRequest } from './agent-bridge.mjs';
import { setupCatalog, setupPropose } from './setup-tools.mjs';
import { helpText, historySearchInput, chatPost, notifySupervisor, callRole, waitForRole, requestDelivery } from './wb-tools.mjs';
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

const COMMANDS=['pass','notify','collaboration','sync','discuss','capabilities','session','setup','history','schedule','timer','note','wait','deliver','call'];

export async function main(argv = process.argv.slice(2)) {
  const turnId=argv[0]==='--turn'?argv[1]:undefined;
  if(argv[0]==='--turn')argv=argv.slice(2);
  const [cmd, sub, ...rest] = argv;
  const tail = [sub, ...rest].filter(v => v !== undefined);
  try {
    // Discovery must work even when a retained process inherited a deleted turn context.
    // Long-form guidance that left the platform template: read on demand, no turn context needed.
    if(['help','-h','--help'].includes(cmd)&&['review','sync','errors'].includes(sub))return out(tr(`wbTools.help${sub[0].toUpperCase()}${sub.slice(1)}`));
    if(!cmd||['help','-h','--help'].includes(cmd)||(tail.some(value=>['--help','-h'].includes(value))&&!tail.includes('--'))||(cmd==='deliver'&&sub==='help'))
      return out(process.env.WB_SYSTEM_SUPERVISOR==='1'?tr('wbCli.wbScheduleJsonSupervisorSubmits',{HELP:helpText()}):helpText());
    if(!COMMANDS.includes(cmd))throw new Error(tr('wbCli.unknownCommand',{cmd,HELP:helpText()}));
    loadTurnContext(process.env,{turnId});
    const supervisor = process.env.WB_SYSTEM_SUPERVISOR === '1';
    const sourceSync=process.env.WB_SOURCE_SYNC==='1';
    if (cmd === 'notify') {
      if (!['send','status'].includes(sub) || rest.length !== 1) throw new Error(tr('wechatChannel.toolGuide'));
      return out(await notifySupervisor(sub,sub==='status'?{id:rest[0]}:JSON.parse(rest[0])));
    }
    if(cmd==='collaboration') {
      if(!['list','create','link','add-member','remove-member','release','close'].includes(sub)||rest.length>1)throw new Error(tr('collabSessions.toolHelp'));
      return out(await agentRequest('/api/agent/collaboration-sessions',{runId:process.env.WB_RUN_ID,action:sub,input:rest.length?JSON.parse(rest[0]):{}}));
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
    if (cmd === 'capabilities') return out({protocol:2,notifications:supervisor?1:0,sourceSyncTools:sourceSync?1:0,sessionTools:1,timerTools:1,transfer:1,
      tools:[...(sourceSync?['sync status','sync read','sync request','sync propose',...(supervisor?['sync assign']:[])]:[]),'discuss peers','call','wait','note','timer',
        ...(supervisor?['notify send','notify status','schedule','collaboration list','collaboration create','collaboration link','collaboration add-member','collaboration remove-member','collaboration release','collaboration close']:[]),
        ...(process.env.WB_QUEUE_BATCH==='1'?['pass']:[]),'history','history search','history read','history summary','deliver','session current']});
    // Discussion batches belong to collaboration sessions and leave with them.
    if (cmd === 'pass' && process.env.WB_QUEUE_BATCH === '1') return out(await agentRequest('/api/agent/pass',{runId:process.env.WB_RUN_ID}));
    if (cmd === 'pass') throw new Error(tr('sessionQueue.passNoBatch'));
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
    if (cmd === 'schedule') {
      if (!supervisor) throw new Error(tr('wbCli.onlyProjectSupervisorCanSubmit'));
      return out(await agentRequest('/api/agent/schedule',{...JSON.parse(tail.join(' ')),runId:process.env.WB_RUN_ID}));
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
      return out(await requestDelivery(sub, rest[0], rest.slice(1).join(' ')));
    }
    if (cmd === 'call') {
      const values = {}, flags = { '--role': 'role', '--kind': 'kind', '--request-id': 'requestId', '--text': 'text', '--file':'file', '--delivery-id': 'deliveryId','--source-sync-batch-id':'sourceSyncBatchId',
        '--goal':'goal','--scope':'scope','--input':'input','--return':'returns' };
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
