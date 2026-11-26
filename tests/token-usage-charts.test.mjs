// The token page reads every device: agents are summed across devices by model name, the model donut keeps the five largest
// models in their daily-chart colours and folds the rest into Other, and the report accepts any number of devices.
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentOf, usageChartModel, usageShares } from '../public/token-usage.js';
import { TokenUsage } from '../src/token-usage.mjs';
import { Store } from '../src/store.mjs';

const day=(date,breakdown,extra=0)=>{
  const modelBreakdowns=Object.entries(breakdown).map(([modelName,totalTokens])=>({modelName,totalTokens}));
  return {date,totalTokens:modelBreakdowns.reduce((sum,item)=>sum+item.totalTokens,0)+extra,modelBreakdowns,collectedAt:'x'};
};
const device=(id,name,daily)=>({id,name,online:true,state:{status:'ready'},total:{totalTokens:daily.reduce((sum,row)=>sum+row.totalTokens,0)},daily});

test('agents are told apart by model name', () => {
  assert.equal(agentOf('claude-opus-5-5'),'Claude');
  assert.equal(agentOf('anthropic/claude-sonnet-4-5'),'Claude');
  assert.equal(agentOf('gpt-5.6-sol'),'Codex');
  assert.equal(agentOf('o4-mini'),'Codex');
  assert.equal(agentOf('gpt-5-codex'),'Codex');
  assert.equal(agentOf('gemini-3-pro'),'Agy');
  assert.equal(agentOf('grok-5'),'Grok');
  assert.equal(agentOf('qwen-3'),'Other');
  assert.equal(agentOf('Unclassified'),'Unclassified');
});

test('agents add up across devices and the model donut keeps the top five', () => {
  const report={devices:[
    device('a','Macbook',[day('2026-11-01',{'claude-opus-5-5':600,'gpt-5.6-sol':200,'m-small-1':10,'grok-5':40})]),
    device('b','Debian',[day('2026-11-01',{'claude-opus-5-5':100,'gemini-3-pro':80,'m-small-2':5,'claude-haiku-4-5':30},20)])
  ],total:{totalTokens:1085}};
  const model=usageChartModel(report),shares=usageShares(model);
  assert.deepEqual(shares.devices.map(d=>[d.name,d.value]),[['Macbook',850],['Debian',235]]);
  assert.deepEqual(shares.agents.map(a=>[a.name,a.value]),[['Claude',730],['Codex',200],['Agy',80],['Grok',40],['Other',15],['Unclassified',20]]);
  assert.equal(shares.agents.reduce((sum,a)=>sum+a.value,0),shares.devices.reduce((sum,d)=>sum+d.value,0));
  assert.deepEqual(shares.models.map(m=>[m.name,m.value]),[['claude-opus-5-5',700],['gpt-5.6-sol',200],['gemini-3-pro',80],['grok-5',40],['claude-haiku-4-5',30],['Other',15],['Unclassified',20]]);
  assert.equal(shares.models.find(m=>m.name==='Other').count,2);
  assert.equal(shares.modelCount,7);
  // A model keeps the colour it has in the daily chart, whatever its rank.
  const daily=new Map(model.models.map(m=>[m.modelName,m.color]));
  for(const item of shares.models.filter(m=>m.name!=='Other'))assert.equal(item.color,daily.get(item.name));
  assert.notEqual(shares.models.find(m=>m.name==='Other').color,shares.models.find(m=>m.name==='Unclassified').color);
});

test('a sixth model is shown by name rather than as Other of one', () => {
  const names=['m1','m2','m3','m4','m5','m6'],breakdown=Object.fromEntries(names.map((name,i)=>[name,100-i*10]));
  const six=usageShares(usageChartModel({devices:[device('a','Macbook',[day('2026-11-01',breakdown)])],total:{}}));
  assert.deepEqual(six.models.map(m=>m.name),names);
  const seven=usageShares(usageChartModel({devices:[device('a','Macbook',[day('2026-11-01',{...breakdown,m7:5})])],total:{}}));
  assert.deepEqual(seven.models.map(m=>[m.name,m.value]),[['m1',100],['m2',90],['m3',80],['m4',70],['m5',60],['Other',55]]);
});

test('the report reads one device or several, and still refuses none', () => {
  const db=new Store(':memory:');
  for(const id of ['n1','n2','n3'])db.put('workers',{id,name:id});
  db.put('tokenUsageDaily',{id:'n1:2026-11-01',nodeId:'n1',date:'2026-11-01',inputTokens:1,outputTokens:2,cacheCreationTokens:3,cacheReadTokens:4,totalTokens:10,costUSD:0,agents:[],models:[]});
  const usage=new TokenUsage(db,null,()=>false);
  assert.equal(usage.report({from:'2026-11-01',to:'2026-11-01',nodeIds:['n1']}).total.totalTokens,10);
  assert.deepEqual(usage.report({from:'2026-11-01',to:'2026-11-01',nodeIds:['n1','n2','n3']}).devices.map(d=>d.id),['n1','n2','n3']);
  assert.throws(()=>usage.report({from:'2026-11-01',to:'2026-11-01',nodeIds:[]}));
});
