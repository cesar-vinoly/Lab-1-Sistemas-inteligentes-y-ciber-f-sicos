import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from '../vendor/ws/wrapper.mjs';
import {CONTROL,parseTelemetry,normalizeCommand,canChangeMicrostep,matchReply} from '../shared/control-protocol.mjs';
import {LabState,EMPTY_MODEL} from '../app/lab-state.ts';
import {attachControlSocket} from '../control/websocket.mjs';
import {clientId} from '../app/client-id.ts';
import {createTransmission} from '../app/transmission.ts';

const line='DIR=FWD,V=50,M=8,RPM_M=75,RPM_T=35.6,RPM_R=35.5,VEL_T=5.50,VEL_R=5.48,DIST=14.0,POS=10.0,ERR=0.3,STATE=OK';
const telemetry=()=>parseTelemetry(line);
const stopped=()=>({...telemetry(),dir:'STOP',rpm_m:0,rpm_t:0,rpm_r:0,vel_t:0,vel_r:0,err:0});

test('identificadores funcionan en HTTP de red local sin crypto.randomUUID',()=>{
  const original=crypto.randomUUID;
  try{
    crypto.randomUUID=undefined;
    const a=clientId(),b=clientId();assert.match(a,/^[a-f0-9-]{35}$/);assert.notEqual(a,b);
  }finally{crypto.randomUUID=original;}
});

test('protocolo original y JSON equivalentes; rechaza datos corruptos y no inventa referencias',()=>{
  const value=telemetry();assert.equal(value.pos,10);assert.equal(value.vel_r,5.48);
  assert.deepEqual(parseTelemetry(JSON.stringify({type:'telemetry',data:value})),value);
  assert.equal(parseTelemetry(line.replace('POS=10.0','POS=NA')).pos,null);
  for(const corrupt of [line.replace('VEL_R=5.48','VEL_R=NaN'),line.replace('DIR=FWD','DIR=???'),line.replace('M=8','M=32'),line.replace('RPM_R=35.5,',''),line.replace('POS=10.0','POS=invalid')])assert.equal(parseTelemetry(corrupt),null);
  const noReference={...value};delete noReference.rpm_t;delete noReference.vel_t;delete noReference.err;
  const parsed=parseTelemetry(noReference);assert.equal(parsed.rpm_t,null);assert.equal(parsed.vel_t,null);assert.equal(parsed.err,null);
});

test('comandos acotados, micropaso solo detenido y respuestas vinculadas a la orden',()=>{
  for(const cmd of ['F','R','S','E','V0','V100','M2','M4','M8','M16','STATUS'])assert.equal(normalizeCommand(cmd),cmd);
  for(const cmd of ['F\nE','V101','V-1','M32','garbage',null])assert.equal(normalizeCommand(cmd),null);
  assert.ok(canChangeMicrostep(stopped(),100));assert.ok(!canChangeMicrostep(telemetry(),100));assert.ok(!canChangeMicrostep(stopped(),3001));
  assert.equal(matchReply('F','Direccion: ADELANTE'),'ack');assert.equal(matchReply('M8','Detener (S) antes de cambiar M'),'rejected');
  assert.equal(matchReply('V50','Velocidad: 50%'),'ack');assert.equal(matchReply('V50','Velocidad: 75%'),null);
  assert.equal(matchReply('E','menu de arranque'),null);assert.equal(matchReply('E',line),null);
});

test('divergencia respeta régimen 1,5 s, persistencia 1 s, rampa, sentido y datos vencidos',()=>{
  let now=0;const state=new LabState(()=>now);state.setLink(true,'first');
  const wrong={...telemetry(),err:30};
  for(const ms of [0,1000,1499,1500,2000,2499]){now=ms;state.ingest(wrong);assert.equal(state.snapshot().divergence,false);}
  now=2500;state.ingest(wrong);assert.equal(state.snapshot().divergence,true);
  now=2600;state.ingest({...wrong,state:'RAMP'});assert.equal(state.snapshot().divergence,false);
  now=2700;state.ingest({...wrong,state:'DIVERG'});assert.equal(state.snapshot().divergence,true);
  now=6001;assert.equal(state.snapshot().fresh,false);assert.equal(state.snapshot().divergence,false);
  state.ingest(wrong);assert.equal(state.snapshot().divergence,false);
  now=6500;state.ingest({...wrong,dir:'REV'});assert.equal(state.snapshot().divergence,false);
});

test('fallas alteran copias y no generan predicciones en el navegador',()=>{
  let now=0;const state=new LabState(()=>now);state.setLink(true,'first');
  state.setFault('perdida_vel',true);const original=telemetry();state.ingest(original);
  assert.equal(original.rpm_r,35.5);assert.equal(state.raw.rpm_r,35.5);assert.equal(state.latest.rpm_r,35.5*.75);
  state.setFault('sobrecarga',true);now=20000;state.ingest(original);assert.equal(state.latest.rpm_r,35.5*.75*.45);
  state.setFault('deslizamiento',true);state.ingest({...original,pos:10});state.ingest({...original,pos:20});assert.equal(state.latest.pos,14);
  state.ingest({...original,pos:null});state.ingest({...original,pos:30});assert.equal(state.latest.pos,30);
  for(let i=0;i<20;i++){now+=200;state.ingest(original);assert.equal(state.snapshot().model,EMPTY_MODEL);assert.ok(Object.values(state.snapshot().model).every(value=>value===null));}
});

test('historial limitado; desconexión y reconexión limpian estado y órdenes pendientes',()=>{
  let now=0;const state=new LabState(()=>now);state.setBridge(true);state.setLink(true,'first');
  for(let i=0;i<1000;i++){now+=100;state.ingest(telemetry());}
  assert.ok(state.snapshot().history.length<=601);
  state.command({id:'pending',command:'F',status:'sent',response:'Enviado F',latencyMs:null});assert.equal(state.pending.size,1);
  state.setBridge(false);assert.equal(state.pending.size,0);assert.equal(state.snapshot().latest,null);
  state.setBridge(true);state.setLink(true,'second');assert.equal(state.snapshot().latest,null);assert.equal(state.snapshot().canMicro,false);
});

test('tras un mando de movimiento exige nueva telemetría de parada para habilitar micropaso',()=>{
  let now=0;const state=new LabState(()=>now);state.setLink(true,'one');state.ingest(stopped());assert.equal(state.snapshot().canMicro,true);
  now=100;state.command({id:'F',command:'F',status:'sent',response:'F',latencyMs:null});
  now=120;state.command({id:'F',command:'F',status:'ack',response:'F',latencyMs:20});assert.equal(state.snapshot().canMicro,false);
  now=150;state.ingest(telemetry());assert.equal(state.snapshot().canMicro,false);
  now=200;state.ingest(stopped());assert.equal(state.snapshot().canMicro,true);
});

function collector(socket){
  const messages=[];socket.on('message',bytes=>{const text=bytes.toString();try{messages.push(JSON.parse(text));}catch{messages.push(text);}});
  return {messages,async wait(predicate){
    const deadline=Date.now()+2000;
    while(Date.now()<deadline){const found=messages.find(predicate);if(found!==undefined)return found;await delay(10);}
    throw Error('Mensaje esperado no recibido: '+JSON.stringify(messages));
  }};
}

test('WebSocket completo: enlace, telemetría, mandos, ACK, paro, timeout, reconexión y rechazo de otro dispositivo',async()=>{
  const server=http.createServer((req,res)=>res.end('servidor existente'));
  const bridge=attachControlSocket(server,{commandTimeoutMs:250});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='ws://127.0.0.1:'+server.address().port;const sockets=[];
  const connect=async(path)=>{const socket=new WebSocket(base+path);sockets.push(socket);const messages=collector(socket);await once(socket,'open');return {socket,...messages};};
  try{
    assert.equal(await(await fetch(base.replace('ws:','http:'))).text(),'servidor existente');
    const ui=await connect('/ws/ui');const snapshot=await ui.wait(m=>m.type==='snapshot');assert.equal(snapshot.link.connected,false);
    ui.socket.send(JSON.stringify({type:'command',id:'no-device',command:'F'}));assert.equal((await ui.wait(m=>m.id==='no-device')).status,'rejected');
    const esp=await connect('/ws/esp32');assert.equal(await esp.wait(m=>m==='STATUS\n'),'STATUS\n');
    await ui.wait(m=>m.type==='link'&&m.connected);
    esp.socket.send(line);await ui.wait(m=>m.type==='telemetry');
    ui.socket.send(JSON.stringify({type:'command',id:'micro-running',command:'M16'}));assert.equal((await ui.wait(m=>m.id==='micro-running')).status,'rejected');
    esp.socket.send(JSON.stringify({type:'telemetry',data:stopped()}));await ui.wait(m=>m.type==='telemetry'&&m.data.dir==='STOP');
    ui.socket.send(JSON.stringify({type:'command',id:'micro-stopped',command:'M16'}));await esp.wait(m=>m==='M16\n');esp.socket.send('Microstep: 1/16');
    assert.ok((await ui.wait(m=>m.id==='micro-stopped'&&m.status==='ack')).latencyMs>=0);
    ui.socket.send(JSON.stringify({type:'command',id:'forward',command:'F'}));await esp.wait(m=>m==='F\n');
    esp.socket.send('ESP32 iniciada');await delay(30);assert.ok(!ui.messages.some(m=>m.id==='forward'&&m.status==='ack'));
    esp.socket.send('Direccion: ADELANTE');await ui.wait(m=>m.id==='forward'&&m.status==='ack');
    ui.socket.send(JSON.stringify({type:'command',id:'velocity',command:'V65'}));await esp.wait(m=>m==='V65\n');
    ui.socket.send(JSON.stringify({type:'command',id:'emergency',command:'E'}));await esp.wait(m=>m==='E\n');
    assert.equal((await ui.wait(m=>m.id==='velocity'&&m.status==='cancelled')).status,'cancelled');
    esp.socket.send('STOP INMEDIATO');await ui.wait(m=>m.id==='emergency'&&m.status==='ack');
    ui.socket.send(JSON.stringify({type:'command',id:'timeout',command:'V70'}));await ui.wait(m=>m.id==='timeout'&&m.status==='timeout');
    assert.equal(esp.messages.filter(m=>m==='V70\n').length,1);
    const intruder=new WebSocket(base+'/ws/esp32');sockets.push(intruder);
    const error=await new Promise(resolve=>intruder.once('error',resolve));assert.match(error.message,/409/);
    const closed=once(esp.socket,'close');esp.socket.close();await closed;await ui.wait(m=>m.type==='link'&&!m.connected);
    const fresh=await connect('/ws/esp32');await fresh.wait(m=>m==='STATUS\n');await delay(50);
    assert.deepEqual(fresh.messages,['STATUS\n']); // No replay of earlier motion/setpoints.
    const sameOriginBlocked=new WebSocket(base+'/ws/ui',{origin:'https://another.example'});sockets.push(sameOriginBlocked);
    const blocked=await new Promise(resolve=>sameOriginBlocked.once('error',resolve));assert.match(blocked.message,/403/);
  }finally{
    for(const socket of sockets)socket.terminate();bridge.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});

test('compatibilidad sin feedback visual: encoder confirma arranque, nunca mando ni ACK',()=>{
  let now=0;const state=new LabState(()=>now);state.setBridge(true);state.setLink(true,'one');state.ingest(stopped());
  const before=structuredClone(state.raw),twin=createTransmission();
  const command=(id,command,status='queued')=>state.command({type:'command',id,command,status,response:command,latencyMs:null});
  command('F1','F');twin.setMotion(state.snapshot().control,now);
  assert.equal(state.snapshot().control.dir,'FWD');assert.equal(state.snapshot().control.driveRpm,0);
  twin.update(16);assert.equal(twin.getState().driveRpm,0);assert.equal(twin.getState().phase,0);
  assert.deepEqual(state.raw,before);
  now=250;state.ingest({...telemetry(),state:'RAMP',rpm_m:30,rpm_r:0,vel_r:0});
  twin.setMotion(state.snapshot().control,now);assert.equal(twin.getState().driveRpm,0);
  command('F1','F','sent');command('F1','F','ack');assert.equal(state.snapshot().control.driveRpm,0);
  now=1000;state.ingest({...telemetry(),rpm_m:75,rpm_r:9.5,vel_r:1.47});
  twin.setMotion(state.snapshot().control,now);assert.equal(twin.getState().driveRpm,-20);
  twin.update(1016);assert.ok(twin.getState().phase<0); // First frame after measurement, no extra wait.
  now=1250;state.ingest(stopped());assert.equal(state.snapshot().control.dir,'STOP');
  command('F1','F','ack');assert.equal(state.snapshot().control.driveRpm,0);assert.equal(state.snapshot().control.dir,'STOP');
});

test('compatibilidad sin feedback visual: aceleración, reversa y parada usan encoder y DIR',()=>{
  let now=0;const state=new LabState(()=>now);state.setLink(true,'one');state.ingest({...telemetry(),rpm_r:19});
  const command=(id,command)=>state.command({type:'command',id,command,status:'sent',response:command,latencyMs:null});
  command('R','R');const twin=createTransmission();twin.setMotion(state.snapshot().control,now);
  assert.equal(state.snapshot().control.dir,'REV');assert.equal(twin.getState().driveRpm,-40);
  // Before physical reversal the model keeps the measured forward movement.
  for(const [at,dir,rpm_m,rpm_r,expected] of [[250,'FWD',50,9.5,-20],[500,'STOP',0,9.5,0],[750,'REV',20,4.75,10],[1000,'REV',70,19,40],[1250,'REV',50,9.5,20]]){
    now=at;state.ingest({...telemetry(),dir,rpm_m,rpm_r,state:'RAMP'});twin.setMotion(state.snapshot().control,now);
    assert.equal(twin.getState().driveRpm,expected);
  }
  command('S','S');twin.setMotion(state.snapshot().control,now);assert.equal(state.snapshot().control.dir,'STOP');
  assert.equal(twin.getState().driveRpm,20); // Still physically moving while braking.
  now=1500;state.ingest({...telemetry(),dir:'REV',rpm_m:10,rpm_r:0,vel_r:0});twin.setMotion(state.snapshot().control,now);
  assert.equal(twin.getState().driveRpm,0);
  command('F','F');assert.equal(state.snapshot().control.driveRpm,0);
  now=1750;state.ingest({...telemetry(),rpm_r:9.5});command('E','E');twin.setMotion(state.snapshot().control,now);
  assert.equal(twin.getState().driveRpm,-20);
  now=1800;state.ingest({...stopped(),rpm_r:9.5,vel_r:1.47});twin.setMotion(state.snapshot().control,now);
  assert.equal(twin.getState().driveRpm,0); // Native stop wins over a held encoder value.
});

test('rechazo y timeout restauran el mando; datos vencidos congelan el gemelo',()=>{
  let now=0;const state=new LabState(()=>now);state.setLink(true,'one');state.ingest(telemetry());
  const command=(id,command,status='queued')=>state.command({type:'command',id,command,status,response:command,latencyMs:null});
  command('V1','V25');assert.equal(state.snapshot().control.v,25);
  command('V2','V80');command('V1','V25','rejected');assert.equal(state.snapshot().control.v,80);
  command('V2','V80','timeout');assert.equal(state.snapshot().control.v,50);
  assert.equal(state.snapshot().control.driveRpm,telemetry().rpm_r/(19/40));
  now=1000;state.ingest(stopped());command('F','F');assert.equal(state.snapshot().control.dir,'FWD');
  assert.equal(state.snapshot().control.driveRpm,0);
  now=3001;assert.equal(state.snapshot().control.dir,'STOP');
  now=4001;assert.equal(state.snapshot().control.source,'unavailable');assert.equal(state.snapshot().control.driveRpm,0);
  state.setBridge(false);assert.equal(state.snapshot().control.dir,null);
});

test('dos webs y sus transmisiones siguen el mismo mando y los cambios locales de la ESP32',async()=>{
  const server=http.createServer((req,res)=>res.end());
  let now=0;
  const bridge=attachControlSocket(server,{clock:()=>now});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='ws://127.0.0.1:'+server.address().port,sockets=[];
  const connect=async(path)=>{
    const socket=new WebSocket(base+path);sockets.push(socket);
    const messages=collector(socket);
    const state=new LabState(()=>now),twin=createTransmission();
    const sync=()=>twin.setMotion(state.snapshot().control,now);
    if(path==='/ws/ui'){
      state.setBridge(true);
      socket.on('message',bytes=>{
        const message=JSON.parse(bytes.toString());
        if(message.type==='snapshot'){
          state.setLink(message.link.connected,message.link.session);
          if(message.controller)state.setController(message.controller);
          if(message.last)state.ingest(message.last.data,now-message.last.ageMs);
        }else if(message.type==='link')state.setLink(message.connected,message.session);
        else if(message.type==='telemetry'){if(message.controller)state.setController(message.controller);state.ingest(message.data);}
        else if(message.type==='controller')state.setController(message.state);
        else if(message.type==='command')state.command(message);
        sync();
      });
    }
    await once(socket,'open');
    return {socket,state,twin,...messages,send(id,command){
      socket.send(JSON.stringify({type:'command',id,command}));
      state.command({type:'command',id,command,status:'queued',response:command,latencyMs:null});sync();
    }};
  };
  try{
    const a=await connect('/ws/ui'),b=await connect('/ws/ui'),esp=await connect('/ws/esp32');
    await esp.wait(m=>m==='STATUS\n');
    esp.socket.send(JSON.stringify({type:'telemetry',data:stopped()}));
    for(const client of [a,b])await client.wait(m=>m.type==='telemetry');
    now=100;a.send('forward','F');
    now=116;a.twin.update(now);assert.equal(a.twin.getState().driveRpm,0); // No encoder-confirmed motion yet.
    await esp.wait(m=>m==='F\n');
    for(const client of [a,b])await client.wait(m=>m.id==='forward'&&m.status==='sent');
    now=132;for(const client of [a,b])client.twin.update(now);
    assert.equal(b.twin.getState().driveRpm,a.twin.getState().driveRpm);
    assert.equal(esp.messages.filter(m=>m==='F\n').length,1);
    now=250;esp.socket.send(JSON.stringify({...telemetry(),state:'RAMP',rpm_m:40,rpm_r:0,vel_r:0}));
    for(const client of [a,b])await client.wait(m=>m.type==='telemetry'&&m.data.rpm_m===40);
    esp.socket.send('Direccion: ADELANTE');
    for(const client of [a,b])await client.wait(m=>m.id==='forward'&&m.status==='ack');
    for(const client of [a,b])assert.equal(client.twin.getState().driveRpm,-40); // Native motion arrives before encoder window.
    now=500;esp.socket.send(JSON.stringify({...telemetry(),rpm_m:40,rpm_r:9.5}));
    for(const client of [a,b]){
      await client.wait(m=>m.type==='telemetry'&&m.timeMs===500);
      assert.equal(client.twin.getState().driveRpm,-40);
    }
    // A local hardware reversal is reflected without sending anything back.
    now=800;esp.socket.send(JSON.stringify({...telemetry(),dir:'REV',rpm_m:20,rpm_r:4.75,v:25,m:4}));
    for(const client of [a,b]){
      await client.wait(m=>m.type==='telemetry'&&m.data.dir==='REV');
      assert.equal(client.state.snapshot().control.v,25);
      assert.equal(client.state.snapshot().control.m,4);
      assert.equal(client.twin.getState().driveRpm,20);
    }
    const late=await connect('/ws/ui');await late.wait(m=>m.type==='snapshot');
    assert.equal(late.twin.getState().driveRpm,a.twin.getState().driveRpm);
    assert.deepEqual(esp.messages.filter(m=>m!=='STATUS\n'),['F\n']);
    now=900;b.send('emergency','E');assert.equal(b.twin.getState().driveRpm,20);
    await esp.wait(m=>m==='E\n');
    for(const client of [a,b])await client.wait(m=>m.id==='emergency'&&m.status==='sent');
    assert.equal(a.twin.getState().driveRpm,20);
    esp.socket.send('STOP INMEDIATO');
    for(const client of [a,b])await client.wait(m=>m.id==='emergency'&&m.status==='ack');
    now=1000;esp.socket.send(JSON.stringify({...stopped(),rpm_r:4.75}));
    for(const client of [a,b]){
      await client.wait(m=>m.type==='telemetry'&&m.timeMs===1000);
      assert.equal(client.twin.getState().driveRpm,0);
    }
    const closed=once(esp.socket,'close');esp.socket.close();await closed;
    for(const client of [a,b]){
      await client.wait(m=>m.type==='link'&&!m.connected);
      assert.equal(client.state.snapshot().control.dir,null);
      assert.equal(client.twin.getState().driveRpm,0);
    }
  }finally{
    for(const socket of sockets)socket.terminate();bridge.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});
