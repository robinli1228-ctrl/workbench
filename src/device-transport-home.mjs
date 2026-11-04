import {DeviceTransport,validateTransportConfig} from './device-transport.mjs';
import {probeTransport,localTransportPort} from './device-transport-io.mjs';
import {tr} from './i18n.mjs';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};

/** Home owns settings, probes and its own SSH route. Backup endpoints are loopback SOCKS listeners, never global selectors. */
export class DeviceTransportHome {
  constructor({db,admin,credentials,change,probe=probeTransport,portOpen=localTransportPort}) {
    Object.assign(this,{db,admin,credentials,change,probe,portOpen});this.controllers=new Map();this.routes=new Map();this.tests=new Map();
  }
  settings(id){return this.db.get('deviceTransportSettings',id)||{id,revision:0,enabled:false,candidates:[]};}
  device(id){const device=this.db.get('devices',id);if(!device)fail(tr('deviceAdmin.deviceNotFound'),404);return device;}
  controller(id) {
    if(this.controllers.has(id))return this.controllers.get(id);
    const device=this.device(id),settings=this.settings(id);
    const config={devices:[{deviceId:id,nodeId:device.nodeId,defaultNode:'DIRECT',candidates:[{name:'DIRECT',probePort:null},...settings.candidates.map(c=>({name:c.name,probePort:c.port}))]}]};
    validateTransportConfig(config);
    const controller=new DeviceTransport({config,enabled:settings.enabled,
      probe:async(_,candidate)=>{const key=await this.credentials.get(id);return this.probe(this.device(id),key?.keyPath,candidate.probePort);},
      select:async(_,name)=>{this.routes.set(id,name);},
      reconnect:async(_,hooks)=>{try{return await this.admin.reconnect(id,hooks);}catch(error){if([tr('deviceAdmin.reconnectBusy'),tr('deviceAdmin.reconnectUnverified')].includes(error.message))error.code='transport_busy';throw error;}},
      change:()=>this.change(),persist:view=>this.db.put('deviceTransports',{id,...view})});
    this.controllers.set(id,controller);return controller;
  }
  view(id){const settings=this.settings(id);return {...this.controller(id).view(id),busy:this.busy(id),revision:settings.revision,candidates:settings.candidates,defaultNode:'DIRECT',test:this.tests.get(id)||{status:'idle',results:[]}};}
  busy(id){return this.controller(id).busy(id)||this.admin.running?.has(id)||this.tests.get(id)?.status==='running';}
  save(id,input) {
    this.device(id);if(this.busy(id))fail(tr('transport.testingBusy'),409);
    const old=this.settings(id);if(input.revision!==old.revision)fail(tr('transport.settingsChanged'),409);
    if(typeof input.enabled!=='boolean'||!Array.isArray(input.candidates)||input.candidates.length>7||input.candidates.some(c=>!c||typeof c!=='object'))fail(tr('transport.invalidSettings'));
    const candidates=input.candidates.map(c=>({name:typeof c.name==='string'?c.name.trim():'',port:c.port}));
    if(candidates.some(c=>c.name==='DIRECT')||input.enabled&&!candidates.length)fail(tr('transport.invalidSettings'));
    try{validateTransportConfig({devices:[{deviceId:id,nodeId:this.device(id).nodeId,defaultNode:'DIRECT',candidates:[{name:'DIRECT',probePort:null},...candidates.map(c=>({name:c.name,probePort:c.port}))]}]});}
    catch{fail(tr('transport.invalidSettings'));}
    const current=this.routes.get(id)||'DIRECT';
    if(current!=='DIRECT'&&!candidates.some(c=>c.name===current&&c.port===old.candidates.find(x=>x.name===current)?.port))fail(tr('transport.activeBackup'),409);
    this.db.put('deviceTransportSettings',{id,revision:old.revision+1,enabled:input.enabled,candidates});this.controllers.delete(id);
    this.controller(id).applied(id,current);this.change();return this.view(id);
  }
  async options(id) {
    if(!this.db.get('devices',id))return {args:[],route:'DIRECT'};
    const route=this.routes.get(id)||'DIRECT',candidate=this.settings(id).candidates.find(c=>c.name===route);
    if(route==='DIRECT'||!candidate||!await this.portOpen(candidate.port))return {args:[],route:'DIRECT'};
    return {args:this.controller(id).sshOptions(id,route),route};
  }
  /** Record creation of an actual tunnel, including direct fallback after the local proxy has stopped. */
  started(id,route='DIRECT') {
    this.routes.set(id,route);const controller=this.controller(id),view=controller.view(id);
    // An automatic target remains pending until the reconnect heartbeat proves it; other creations record the actual route.
    if(!view.busy||view.pending!==route)controller.applied(id,route);
  }
  stalled(nodeId,reason){const device=this.db.list('devices').find(d=>d.nodeId===nodeId);if(!device||this.admin.running?.has(device.id)||this.tests.get(device.id)?.status==='running')return;return this.controller(device.id).stalled(nodeId,reason);}
  retry(nodeId){const device=this.db.list('devices').find(d=>d.nodeId===nodeId);if(device&&!this.admin.running?.has(device.id)&&this.tests.get(device.id)?.status!=='running')return this.controller(device.id).retryPending(nodeId);}
  test(id) {
    this.device(id);if(this.busy(id))fail(tr('transport.testingBusy'),409);
    const test={status:'running',results:[]};this.tests.set(id,test);this.change();
    void (async()=>{
      const device=this.device(id),key=await this.credentials.get(id);
      for(const candidate of [{name:'DIRECT',port:null},...this.settings(id).candidates]){
        try{const sample=await this.probe(device,key?.keyPath,candidate.port);test.results.push({name:candidate.name,complete:sample.complete,uploadBps:sample.bytes/sample.uploadSeconds,downloadBps:sample.bytes/sample.downloadSeconds});}
        catch{test.results.push({name:candidate.name,complete:false,error:'transport_probe_failed'});}
        this.change();
      }
    })().catch(()=>{test.error='transport_probe_failed';}).finally(()=>{test.status='completed';this.change();});
    return this.view(id);
  }
  async direct(id) {
    this.device(id);if(this.busy(id))fail(tr('transport.testingBusy'),409);
    const previous=this.routes.get(id)||'DIRECT';if(previous==='DIRECT')return this.view(id);
    await this.admin.reconnect(id,{before:async()=>{this.routes.set(id,'DIRECT');},rollback:async()=>{this.routes.set(id,previous);}});
    this.controller(id).applied(id,'DIRECT');return this.view(id);
  }
}
