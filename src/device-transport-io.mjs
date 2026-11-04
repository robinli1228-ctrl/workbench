import {spawn} from 'node:child_process';
import {connect} from 'node:net';
import {randomBytes} from 'node:crypto';

/** An unavailable local proxy must leave Home's existing direct SSH fallback usable. */
export function localTransportPort(port) {
  return new Promise(resolve=>{
    const socket=connect({host:'127.0.0.1',port});let done=false;
    const finish=value=>{if(done)return;done=true;socket.destroy();resolve(value);};
    socket.setTimeout(500);socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.once('timeout',()=>finish(false));
  });
}

/**
 * A bounded, uncompressed round trip to the actual device, over a separate candidate SSH connection. Only this probe's
 * child is stopped; no project files, Worker process, managed run or existing tunnel is touched. Setup time is separate
 * from payload time, while an incomplete sample is never considered a successful route.
 */
export function probeTransport(device,keyPath,proxyPort,{spawnProcess=spawn,bytes=512*1024,timeoutMs=10000,clock=()=>performance.now()}={}) {
  if(!device||typeof device.host!=='string'||!device.host||/[\s\x00-\x1f]/.test(device.host)||!/^\w[\w.-]*$/.test(device.user||'')
    ||!Number.isInteger(device.port)||device.port<1||device.port>65535||typeof keyPath!=='string'||!keyPath.startsWith('/')||/[\x00-\x1f]/.test(keyPath)
    ||proxyPort!==null&&(!Number.isInteger(proxyPort)||proxyPort<1||proxyPort>65535))throw new Error('invalid_transport_probe');
  const script=`import{randomBytes}from'node:crypto';let count=0;const start=performance.now();process.stdout.write('WB-PROBE\\n');process.stdin.on('data',chunk=>{count+=chunk.length;if(count>${bytes})process.exit(1);});process.stdin.on('end',()=>{if(count!==${bytes})process.exit(1);process.stdout.write('UP '+((performance.now()-start)/1000)+'\\n');process.stdout.write(randomBytes(${bytes}));});`;
  const encoded=Buffer.from(script).toString('base64');
  const args=['-T','-p',String(device.port),'-i',keyPath,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=5',
    '-o','Compression=no','-o','ControlMaster=no','-o','ControlPath=none',...(proxyPort===null?[]:['-o',`ProxyCommand=/usr/bin/nc -X 5 -x 127.0.0.1:${proxyPort} %h %p`]),`${device.user}@${device.host}`,`node --input-type=module -e "import('data:text/javascript;base64,${encoded}')"`];
  return new Promise((resolve,reject)=>{
    const child=spawnProcess('ssh',args,{stdio:['pipe','pipe','ignore']});let header=Buffer.alloc(0),received=0,start=null,uploadSeconds=null,ready=false,done=false,timer,killTimer;
    const stop=()=>{try{child.kill('SIGTERM');}catch{}killTimer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},1000);killTimer.unref?.();};
    const finish=(error=null)=>{if(done)return;done=true;clearTimeout(timer);if(error){stop();reject(new Error(error));return;}const downloadSeconds=Math.max(.001,(clock()-start)/1000);resolve({bytes:received,seconds:Math.max(uploadSeconds,downloadSeconds),uploadSeconds,downloadSeconds,complete:received===bytes});};
    timer=setTimeout(()=>finish('transport_probe_timeout'),timeoutMs);timer.unref?.();
    child.on('error',()=>finish('transport_probe_failed'));child.on('close',code=>{clearTimeout(killTimer);if(!done)code===0&&start!==null&&received===bytes?finish():finish('transport_probe_incomplete');});
    child.stdout.on('data',chunk=>{
      if(done)return;
      if(start===null){
        header=Buffer.concat([header,chunk]);
        while(start===null){const at=header.indexOf(10);if(at<0){if(header.length>128)finish('transport_probe_header');return;}
          const line=header.subarray(0,at).toString();header=header.subarray(at+1);
          if(!ready){if(line!=='WB-PROBE'){finish('transport_probe_header');return;}ready=true;child.stdin.end(randomBytes(bytes));}
          else{uploadSeconds=Number(line.slice(3));if(!line.startsWith('UP ')||!Number.isFinite(uploadSeconds)||uploadSeconds<=0){finish('transport_probe_header');return;}start=clock();}
        }
        chunk=header;header=null;
      }
      received+=chunk.length;if(received>bytes)finish('transport_probe_overflow');
    });
    child.stdin.on('error',()=>{});
  });
}
