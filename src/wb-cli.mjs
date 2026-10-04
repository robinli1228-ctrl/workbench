import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadTurnContext } from './turn-context.mjs';
import { agentRequest } from './agent-bridge.mjs';
import {DISCUSSION_HELP} from './discussion-policy.mjs';
import { setupCatalog, setupPropose, updateRolePrompt } from './setup-tools.mjs';
import {
  HELP, boot, memoryRead, memoryWrite, memorySearch, docsList, docsRead,
  gitStatus, chatPost, askRole, callRole, waitForRole, requestDelivery, writeHandoff, handoffLast
} from './wb-tools.mjs';

function out(data) {
  process.stdout.write(`${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n`);
}

/** New session queries accept only explicit pagination parameters and never swallow unknown parameters into the current project request. */
function sessionOptions(args) {
  const values={};
  const names={'--offset':'offset','--limit':'limit','--version':'version','--cursor':'cursor'};
  for(let i=0;i<args.length;i+=2) {
    const key=names[args[i]],value=args[i+1];
    if(!key || value===undefined || values[key]!==undefined)throw new Error('Invalid session query parameters');
    values[key]=['offset','limit'].includes(key)?Number(value):value;
  }
  return values;
}

function parseHandoffArgs(args) {
  const fields = {};
  const leftover = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    const key = token.replace(/^--/, '');
    if (['done', 'files', 'next', 'blocked', 'verify'].includes(key) && args[i + 1]) {
      fields[key] = args[++i];
    } else leftover.push(token);
  }
  if (!fields.done && leftover.length) fields.done = leftover.join(' ');
  return fields;
}

export async function main(argv = process.argv.slice(2)) {
  loadTurnContext();
  const [cmd, sub, ...rest] = argv;
  const tail = [sub, ...rest].filter(v => v !== undefined);
  const supervisor = process.env.WB_SYSTEM_SUPERVISOR === '1';
  try {
    const roleSession=Boolean(process.env.WB_ROLE_SESSION_ID),discussion=roleSession&&process.env.WB_DISCUSSION_PROTOCOL==='2';
    if(cmd==='discuss') {
      if(!discussion&&sub!=='peers')throw new Error('Discussion tools are not enabled for this turn');
      if(!['peers','ask','reply','read','resolve','budget_extend'].includes(sub)||rest.length>(sub==='peers'?0:1))throw new Error(DISCUSSION_HELP);
      return out(await agentRequest('/api/agent/discussions',{runId:process.env.WB_RUN_ID,action:sub,input:rest.length?JSON.parse(rest[0]):{}}));
    }
    if(discussion&&(!cmd||['help','-h','--help'].includes(cmd)))return out(`${HELP}\n\n${DISCUSSION_HELP}`);
    if (cmd === 'capabilities') return out({protocol:2,discussionProtocol:discussion?2:0,sessionTools:1,timerTools:1,tools:['setup catalog',...(roleSession?['discuss peers']:[]),...(discussion?['discuss ask','discuss reply','discuss read','discuss resolve',...(supervisor?['discuss budget_extend']:[])]:[]),'call','wait',...(supervisor?['schedule','timer','role prompt']:[]),'note','git status','memory read','memory write','report','history search','history read','result read','deliver','session current','session list','session summary','session read','chat summary']});
    if (cmd === 'session' && sub === 'current') return out(await agentRequest('/api/agent/sessions/current',{runId:process.env.WB_RUN_ID}));
    if (cmd === 'session' && sub === 'list') return out(await agentRequest('/api/agent/sessions/list',{runId:process.env.WB_RUN_ID,...sessionOptions(rest)}));
    if (cmd === 'session' && sub === 'summary') return out(await agentRequest('/api/agent/sessions/summary',{runId:process.env.WB_RUN_ID,roleSessionId:rest[0]}));
    if (cmd === 'session' && sub === 'read') return out(await agentRequest('/api/agent/sessions/read',{runId:process.env.WB_RUN_ID,roleSessionId:rest[0],...sessionOptions(rest.slice(1))}));
    if (cmd === 'chat' && sub === 'summary') return out(await agentRequest('/api/agent/conversation/summary',{runId:process.env.WB_RUN_ID,...sessionOptions(rest)}));
    if (cmd === 'setup' && sub === 'catalog') return out(await setupCatalog());
    if (cmd === 'report') return out(await agentRequest('/api/agent/report',{...JSON.parse(tail.join(' ')),runId:process.env.WB_RUN_ID}));
    if (cmd === 'history' && sub === 'search') return out(await agentRequest('/api/agent/history/search',{runId:process.env.WB_RUN_ID,query:rest.join(' ')}));
    if ((cmd === 'history' || cmd === 'result') && sub === 'read') return out(await agentRequest('/api/agent/history/read',{runId:process.env.WB_RUN_ID,kind:cmd==='history'?'message':'result',id:rest[0],offset:rest[1]===undefined?0:Number(rest[1]),version:rest[2]}));
    if (cmd === 'schedule') {
      if (!supervisor) throw new Error('Only the project supervisor can submit a plan');
      return out(await agentRequest('/api/agent/schedule',{...JSON.parse(tail.join(' ')),runId:process.env.WB_RUN_ID}));
    }
    if (cmd === 'timer') {
      if (sub === 'list' && !rest.length) return out(await agentRequest('/api/agent/timers',{runId:process.env.WB_RUN_ID,action:'list'}));
      if (!['create','update','pause','resume','delete'].includes(sub) || rest.length !== 1) throw new Error('Usage: wb timer list or wb timer <create|update|pause|resume|delete> \'<JSON>\'');
      return out(await agentRequest('/api/agent/timers',{...JSON.parse(rest[0]),runId:process.env.WB_RUN_ID,action:sub}));
    }
    if (cmd === 'setup' && sub === 'propose') return out(await setupPropose(JSON.parse(rest.join(' '))));
    if (cmd === 'role' && sub === 'prompt') return out(await updateRolePrompt(JSON.parse(rest.join(' '))));
    if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') return out(supervisor ? `${HELP}\nwb schedule '<JSON>'  Supervisor submits a lightweight execution schedule that advances automatically without waiting for manual confirmation. failurePolicy defaults to stop; independent read-only reviews by several roles should be a separate batch that explicitly selects collect_reviews (all members audit, no writeRepositories). A temporary service error confirmed to have ended is logged and the run continues; output that exceeds the limit is separately recorded as an incomplete result; permission problems, unknown errors, cancellation, pending answers, or version anomalies still stop it. No automatic retry, and a missing result does not count as a pass.` : HELP);
    if (cmd === 'boot' || cmd === 'status') return out(await boot());
    if (cmd === 'memory' && (!sub || sub === 'read')) return out(await memoryRead());
    if (cmd === 'memory' && sub === 'write') return out(await memoryWrite(rest.join(' ')));
    if (cmd === 'memory' && sub === 'search') return out(await memorySearch(rest.join(' ')));
    if (cmd === 'docs' && (!sub || sub === 'list')) return out(await docsList());
    if (cmd === 'docs' && sub === 'read') return out(await docsRead(rest.join(' ')));
    if (cmd === 'git' && (!sub || sub === 'status')) return out(await gitStatus());
    if (cmd === 'chat' || cmd === 'note') return out(await chatPost(tail.join(' ')));
    if (cmd === 'ask') return out(await askRole(sub, rest.join(' ')));
    if (cmd === 'wait') return out(await waitForRole(tail.join(' ')));
    if (cmd === 'deliver') return out(await requestDelivery(sub, rest[0], rest.slice(1).join(' ')));
    if (cmd === 'call') {
      const values = {}, flags = { '--role': 'role', '--kind': 'kind', '--request-id': 'requestId', '--text': 'text', '--delivery-id': 'deliveryId' };
      for (let i = 0; i < tail.length; i += 2) {
        const key = flags[tail[i]];
        if (!key || tail[i + 1] === undefined || values[key] !== undefined) throw new Error('Invalid or duplicate wb call parameters');
        values[key] = tail[i + 1];
      }
      return out(await callRole(values));
    }
    if (cmd === 'handoff' && (sub === 'last' || sub === 'read')) return out(await handoffLast());
    if (cmd === 'handoff') return out(await writeHandoff(parseHandoffArgs(argv.slice(1))));
    throw new Error(`Unknown command ${cmd}\n\n${HELP}`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
