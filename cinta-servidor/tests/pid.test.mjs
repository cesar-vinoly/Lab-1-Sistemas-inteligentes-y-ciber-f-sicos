/**
 * Pruebas automatizadas de controlador, planta dinámica, estados y compatibilidad de comunicación.
 * Los relojes/dispositivos simulados permiten reproducir transiciones sin hardware.
 * Estas verificaciones no sustituyen un ensayo físico de la cinta.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {PlantModel,VelocityPid,ConveyorController,validFeedback} from '../control/pid.mjs';
import {PID_DEFAULTS,PID_GAINS,MAX_BELT_CM_S,APPROACH,validatePidConfig,parseTelemetry,ROLLER_CM_PER_REV} from '../shared/control-protocol.mjs';
import {calibrateTelemetry} from '../control/telemetry.mjs';
import {attachControlSocket} from '../control/websocket.mjs';
import {WebSocket} from '../vendor/ws/wrapper.mjs';
import {LabState} from '../app/lab-state.ts';
import {createTransmission} from '../app/transmission.ts';

const close=(a,b,tolerance=1e-10)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} ≠ ${b}`);
const raw=(changes={})=>({...parseTelemetry('DIR=STOP,V=50,M=8,RPM_M=0,RPM_T=0,RPM_R=0,VEL_T=0,VEL_R=0,DIST=40,POS=36,ERR=0,STATE=OK'),...changes});

test('G(s): respuesta exacta ZOH, inversión, parada y tiempo variable',()=>{
  const model=new PlantModel();
  // Independently calculated with a matrix exponential of the augmented
  // continuous state matrix (scipy.linalg.expm), including held-input steps.
  for(const [u,dt,y] of [[40,.25,.14983403066989015],[40,.75,.6508965213129001],[-25,.13,.5903242963502899],[-25,1.4,-.46775426996635383],[0,5,.000009013730256618223]])close(model.advance(u,dt),y);
  model.reset();close(model.advance(80,100),80*.1425/8.058);
  const divided=new PlantModel(),whole=new PlantModel();
  for(let i=0;i<1000;i++)divided.advance(35,.001);
  close(divided.output,whole.advance(35,1));
  assert.throws(()=>model.advance(1,NaN));assert.throws(()=>model.advance(1,-1));
});

test('configuración: límites físicos, tipos y realimentación inválida',()=>{
  assert.deepEqual(validatePidConfig({}),PID_DEFAULTS);
  for(const input of [{maxPercent:101},{minPercent:51,maxPercent:50},{minPercent:-1},{maxPercent:0},{sampleMs:0},{sampleMs:250.5},{inputScale:0},{outputScale:Infinity},{targetCm:NaN},{forwardIncreasesDistance:1},{extra:1},JSON.parse('{"constructor":5}')])assert.throws(()=>validatePidConfig(input));
  assert.ok(validFeedback(raw()));
  for(const invalid of [{dist:null},{dist:0},{pos:null},{pos:-1},{pos:46}])assert.ok(!validFeedback(raw(invalid)));
});

test('PID de velocidad: ganancias configurables, encoder, filtro y anti-windup',()=>{
  assert.deepEqual(PID_GAINS,{kp:113.8,ki:235.7,kd:10.35});
  const pid=new VelocityPid(),config={...PID_DEFAULTS};
  const output=pid.update(MAX_BELT_CM_S*.1,MAX_BELT_CM_S*.08,.25,config,0,100);
  close(pid.terms.p,2.276);close(pid.terms.i,1.1785);close(output,13.4545);
  pid.update(MAX_BELT_CM_S*.1,MAX_BELT_CM_S*.09,.25,config,0,100);assert.ok(pid.terms.d<0);
  pid.reset();for(let i=0;i<1000;i++)assert.equal(pid.update(MAX_BELT_CM_S,0,.25,config,0,35),35);
  assert.equal(pid.integral,0);assert.equal(pid.update(0,MAX_BELT_CM_S,.25,config,0,35),0);
  pid.reset();close(pid.update(1,0,.25,{...config,kp:0,ki:0,kd:0},0,100),100/MAX_BELT_CM_S);
  assert.throws(()=>pid.update(1,NaN,.25,config,0,100));assert.throws(()=>pid.update(1,0,0,config,0,100));
});

test('controlador: tiempo real, muestra nueva única y encoder independiente',()=>{
  const c=new ConveyorController();c.reset(0);c.configure({maxPercent:35,forwardIncreasesDistance:false},0);c.observe(raw({vel_r:8}),0);c.enable(0);
  assert.deepEqual(c.tick(0),{output:83});c.applied(83,0); // Distance profile, not the old 35% maximum.
  assert.equal(c.tick(100),null);assert.equal(c.tick(250),null);
  c.observe(raw({dist:30,pos:26,vel_r:9}),350);
  const next=c.tick(350);assert.ok(next.output>0&&next.output<100); // Approaching the target decelerates.
  assert.equal(c.effectiveSampleMs,350);close(c.lastModel.errorCmS,9-c.lastModel.speedCmS);
  assert.notEqual(c.lastModel.speedCmS,9);assert.equal(c.latest.vel_r,9);
  const paired={...c.lastModel};c.tick(400);assert.deepEqual(c.snapshot().model,paired);
  assert.throws(()=>c.configure({maxPercent:40},400));
  c.disable(400);c.configure({forwardIncreasesDistance:true},400);c.observe(raw({pos:null}),400);c.enable(400);assert.equal(c.tick(400).output,-100);
});

test('controlador: encoder inválido, telemetría vencida e interrupción',()=>{
  for(const changes of [{vel_r:null},{vel_r:NaN},{vel_r:-1},{rpm_r:null},{rpm_r:-1}]){
    const c=new ConveyorController();c.reset(0);c.observe(raw(changes),0);assert.throws(()=>c.enable(0));
    c.observe(raw(),0);c.enable(0);c.tick(0);c.observe(raw(changes),250);assert.match(c.tick(250).fault,/encoder/);
  }
  const stale=new ConveyorController();stale.reset(0);stale.observe(raw(),0);stale.enable(0);
  for(let t=0;t<=3000;t+=250)stale.tick(t);
  assert.match(stale.tick(3250).fault,/vencida/);
  const delayed=new ConveyorController();delayed.reset(0);delayed.observe(raw(),0);delayed.enable(0);
  assert.match(delayed.tick(1500).fault,/interrupción/i);
  delayed.reset(1600);assert.equal(delayed.enabled,true);assert.equal(delayed.outputPercent,0);assert.equal(delayed.lastModel.speedCmS,null);
});

test('gemelo y gráfica usan encoder físico; el mando, G(s) y fallas no reemplazan su medición',()=>{
  let now=0;const c=new ConveyorController();c.reset(now);c.configure({forwardIncreasesDistance:false},now);c.observe(raw({vel_r:4,rpm_r:19}),now);c.enable(now);c.tick(now);c.applied(35,now);
  const state=new LabState(()=>now);state.setBridge(true);state.setLink(true,'esp');state.setController(c.snapshot());state.ingest(c.latest,now,c.lastModel);
  const twin=createTransmission();twin.setMotion(state.snapshot().control,now);twin.update(16);
  assert.equal(twin.getState().driveRpm,0); // DIR=STOP despite the server command.
  state.setFault('perdida_vel',true);now=250;c.observe(raw({dir:'FWD',v:35,state:'RAMP',vel_r:4,rpm_r:19,rpm_m:30}),now);state.setController(c.snapshot());state.ingest(c.latest,now,c.lastModel);
  assert.equal(state.latest.vel_r,4);assert.equal(state.raw.vel_r,4);
  const sample=state.history.at(-1);assert.equal(sample.speed,4);assert.equal(sample.simulatedSpeed,null);assert.equal(sample.at,250);assert.equal(sample.modelSpeed,c.lastModel.speedCmS);
  c.applied(-35,now);state.setController(c.snapshot());assert.equal(state.snapshot().control.direction,-1);close(state.snapshot().control.driveRpm,30);
  state.command({type:'command',id:'stop',command:'E',status:'queued',response:'E',latencyMs:null});close(state.snapshot().control.driveRpm,30);
  now=500;state.ingest(raw(),now);assert.equal(state.snapshot().control.driveRpm,0);
});

test('mando con V0 y después del PID conserva el sentido y la última consigna enviada',()=>{
  let now=0;const c=new ConveyorController();c.reset(0);c.observe(raw({v:0}),0);c.manual('F',0);
  const state=new LabState(()=>now);state.setLink(true,'esp');state.setController(c.snapshot());state.ingest(c.latest);
  assert.equal(state.snapshot().control.dir,'FWD');assert.equal(state.snapshot().control.driveRpm,0);
  state.command({type:'command',id:'speed',command:'V50',status:'queued',response:'V50',latencyMs:null});
  assert.equal(state.snapshot().control.dir,'FWD');assert.equal(state.snapshot().control.v,50);
  c.manual('V50',0);now=16;assert.equal(state.snapshot().control.driveRpm,0);
  c.applied(12,now);c.disable(now);c.manual('F',now);
  assert.equal(c.outputPercent,12);assert.equal(c.snapshot().commandPercent,12);
});

function collector(socket){
  const messages=[];socket.on('message',bytes=>{try{messages.push(JSON.parse(bytes.toString()));}catch{messages.push(bytes.toString());}});
  return {messages,async wait(predicate){
    const deadline=Date.now()+2000;
    while(Date.now()<deadline){const found=messages.find(predicate);if(found!==undefined)return found;await delay(5);}
    throw Error('Mensaje esperado no recibido: '+JSON.stringify(messages));
  }};
}
function acknowledge(socket){
  socket.on('message',bytes=>{
    const cmd=bytes.toString().trim();const reply={F:'Direccion: ADELANTE',R:'Direccion: REVERSA',S:'STOP',E:'STOP INMEDIATO'}[cmd]??(/^V\d+$/.test(cmd)?'Velocidad: '+cmd.slice(1)+'%':null);
    if(reply)socket.send(reply);
  });
}
async function fixture(t,{ack=true}={}){
  let now=0;const server=http.createServer((request,response)=>response.end('existing'));
  const bridge=attachControlSocket(server,{clock:()=>now,commandTimeoutMs:500});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='ws://127.0.0.1:'+server.address().port,sockets=[];
  const connect=async path=>{
    const socket=new WebSocket(base+path);sockets.push(socket);const messages=collector(socket);await once(socket,'open');return {socket,...messages};
  };
  t.after(async()=>{for(const socket of sockets)socket.terminate();bridge.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const ui=await connect('/ws/ui'),esp=await connect('/ws/esp32');
  if(ack)acknowledge(esp.socket);
  let sequence=0;
  const request=async(action,config)=>{
    const id='pid-'+(++sequence);ui.socket.send(JSON.stringify({type:'pid',id,action,config}));return ui.wait(m=>m.type==='pid-result'&&m.id===id);
  };
  const telemetry=async(changes={},at=now)=>{now=at;esp.socket.send(JSON.stringify(raw(changes)));return ui.wait(m=>m.type==='telemetry'&&m.timeMs===at);};
  const ready=async()=>{
    await telemetry({dist:null,pos:null});assert.equal((await request('configure',{maxPercent:35,initialPercent:35,forwardIncreasesDistance:false})).status,'ack');assert.equal((await request('enable')).status,'ack');
    await esp.wait(m=>m==='F\n');
    if(ack)await ui.wait(m=>m.type==='command'&&m.command==='F'&&m.status==='ack');
  };
  return {ui,esp,connect,request,telemetry,ready,setTime:value=>{now=value;}};
}

test('WebSocket PID: protocolo existente, frenado, parada retenida y varios clientes',async t=>{
  const f=await fixture(t);await f.ready();assert.ok(f.esp.messages.includes('V100\n'));
  const frame=await f.telemetry({dir:'FWD',v:35,rpm_m:52.5,vel_r:4,dist:35,pos:31},250);
  assert.equal(frame.data.vel_r,4);close(frame.model.errorCmS,4-frame.model.speedCmS);
  const second=await f.connect('/ws/ui');const snap=await second.wait(m=>m.type==='snapshot');
  assert.equal(snap.controller.enabled,true);assert.equal(snap.last.timeMs,250);
  f.ui.socket.send(JSON.stringify({type:'command',id:'manual',command:'V80'}));assert.equal((await f.ui.wait(m=>m.id==='manual')).status,'rejected');
  await f.telemetry({dir:'FWD',v:35,state:'RAMP',rpm_m:45,vel_r:4,dist:24,pos:20},500);
  const braking=await second.wait(m=>m.type==='controller'&&m.state.status==='braking'&&m.state.remainingCm===4);assert.ok(braking.state.outputPercent<35);assert.ok(braking.state.outputPercent>0);
  await f.telemetry({dir:'FWD',v:braking.state.outputPercent,state:'RAMP',rpm_m:20,vel_r:1,dist:20.4,pos:16.4},750);await f.esp.wait(m=>m==='S\n');
  await f.ui.wait(m=>m.type==='controller'&&m.state.enabled&&m.state.status==='target'&&m.state.outputPercent===0);
  await f.telemetry({dist:21,pos:17},1000);await delay(30);assert.ok(!f.esp.messages.includes('R\n'));assert.equal(f.esp.messages.filter(m=>m==='F\n').length,1);
});

test('WebSocket PID: arranca sin objeto, ignora DIST retenida y espera telemetría nueva al reconectar',async t=>{
  const f=await fixture(t);
  await f.telemetry({dist:null,pos:null});
  assert.equal((await f.request('configure',{initialPercent:35,maxPercent:35,forwardIncreasesDistance:false})).status,'ack');
  assert.equal((await f.request('enable')).status,'ack');
  await f.esp.wait(m=>m==='F\n');await f.ui.wait(m=>m.type==='command'&&m.command==='F'&&m.status==='ack');
  for(const at of [250,500,750])await f.telemetry({dir:'FWD',v:100,rpm_m:150,vel_r:MAX_BELT_CM_S,rpm_r:71.25,dist:10,pos:null},at);
  await delay(30);assert.ok(!f.esp.messages.includes('E\n'));assert.ok(!f.esp.messages.includes('S\n'));
  const second=await f.connect('/ws/ui');const snapshot=await second.wait(m=>m.type==='snapshot');
  assert.equal(snapshot.controller.enabled,true);assert.equal(snapshot.controller.remainingCm,null);
  await f.telemetry({dir:'FWD',v:35,rpm_m:52.5,vel_r:3.85,rpm_r:24.9,dist:20.4,pos:16.4},1000);
  await f.esp.wait(m=>m==='S\n');await f.ui.wait(m=>m.type==='controller'&&m.state.status==='target');
  await f.telemetry({dist:null,pos:null},1250);await delay(30);assert.equal(f.esp.messages.filter(m=>m==='F\n').length,1);
  const closed=once(f.esp.socket,'close');f.esp.socket.close();await closed;await f.ui.wait(m=>m.type==='link'&&!m.connected);
  const reconnected=await f.connect('/ws/esp32');await reconnected.wait(m=>m==='STATUS\n');await delay(30);assert.deepEqual(reconnected.messages,['STATUS\n']);
});

test('WebSocket PID: despeje rápido recupera la consigna completa; Detener conserva pausa manual',async t=>{
  const f=await fixture(t);await f.ready();
  await f.telemetry({dir:'FWD',v:35,rpm_m:30,state:'RAMP',dist:20,pos:16},250);
  await f.ui.wait(m=>m.type==='command'&&m.command==='S'&&m.status==='ack');
  await f.telemetry({dist:20,pos:16},500);
  await f.telemetry({dist:20,pos:null},750);
  await f.telemetry({dist:20,pos:null},800); // STATUS must not count as another sensor period.
  await f.telemetry({dist:20.7,pos:16.7},850); // A near echo cancels this short dropout.
  await f.telemetry({dist:20,pos:null},1100);
  assert.equal(f.esp.messages.filter(m=>m==='F\n').length,1);
  await f.telemetry({dist:20,pos:null},1350);
  await delay(30);assert.equal(f.esp.messages.filter(m=>m==='F\n').length,2);
  assert.equal(f.esp.messages.filter(m=>m==='V100\n').length,2);
  const resume=f.ui.messages.filter(m=>m.type==='controller'&&m.state.status==='running').at(-1);
  assert.equal(resume.state.enabled,true);assert.equal(resume.state.outputPercent,100);
  await f.telemetry({dir:'FWD',v:35,rpm_m:9,state:'RAMP',dist:20,pos:16},1600);
  await delay(30);assert.equal(f.esp.messages.filter(m=>m==='S\n').length,2);
  for(const at of [1850,2100])await f.telemetry({v:35,dist:null,pos:null},at);
  await delay(30);assert.equal(f.esp.messages.filter(m=>m==='F\n').length,3);
  assert.equal(f.esp.messages.filter(m=>m==='V100\n').length,3);
  f.ui.socket.send(JSON.stringify({type:'command',id:'manual-stop',command:'S'}));
  await f.ui.wait(m=>m.id==='manual-stop'&&m.status==='ack');
  for(const at of [2350,2600,2850,3100])await f.telemetry({dist:null,pos:null},at);
  await delay(30);assert.equal(f.esp.messages.filter(m=>m==='F\n').length,3);
  const late=await f.connect('/ws/ui');const stopped=(await late.wait(m=>m.type==='snapshot')).controller;
  assert.equal(stopped.enabled,true);assert.equal(stopped.status,'paused');assert.equal(stopped.outputPercent,0);
});

test('WebSocket PID: ACK pendiente limita comandos y timeout envía E una sola vez',async t=>{
  const f=await fixture(t,{ack:false});await f.ready();
  await f.telemetry({dir:'FWD',v:35,dist:30,pos:26},250);await delay(30);assert.ok(!f.esp.messages.includes('R\n'));
  f.setTime(500);await f.esp.wait(m=>m==='E\n');await delay(40);assert.equal(f.esp.messages.filter(m=>m==='E\n').length,1);
  await f.ui.wait(m=>m.type==='controller'&&m.state.enabled&&m.state.status==='waiting');
});

test('WebSocket PID: Detener pausa, ambos sentidos reanudan y solo desmarcar desactiva',async t=>{
  const f=await fixture(t);await f.ready();
  f.ui.socket.send(JSON.stringify({type:'command',id:'stop',command:'S'}));await f.ui.wait(m=>m.id==='stop'&&m.status==='ack');
  // Establish absence before resuming. A held object would legitimately start
  // the braking profile if the 25 ms pump runs before the next telemetry.
  await f.telemetry({dist:null,pos:null},250);await delay(30);assert.equal(f.esp.messages.filter(m=>m==='F\n').length,1);
  const client=await f.connect('/ws/ui');const paused=(await client.wait(m=>m.type==='snapshot')).controller;
  assert.equal(paused.enabled,true);assert.equal(paused.status,'paused');assert.equal(paused.outputPercent,0);
  for(const [command,at] of [['R',500],['F',1000]]){
    f.ui.socket.send(JSON.stringify({type:'command',id:'resume-'+command,command}));
    await f.ui.wait(m=>m.id==='resume-'+command&&m.status==='ack');
    await f.telemetry({dist:null,pos:null,dir:command==='F'?'FWD':'REV',state:'RAMP',rpm_m:10},at);
    const other=await f.connect('/ws/ui');const current=(await other.wait(m=>m.type==='snapshot')).controller;
    assert.equal(current.enabled,true);assert.equal(current.status,'running');
    assert.equal(Math.sign(current.outputPercent),command==='F'?1:-1);
  }
  // A valid goal still stops after a direction change, without disabling PID.
  await f.telemetry({dir:'FWD',state:'RAMP',dist:20,pos:16},1250);
  await f.ui.wait(m=>m.type==='controller'&&m.state.status==='target'&&m.state.enabled);
  assert.equal((await f.request('disable')).status,'ack');
  await client.wait(m=>m.type==='controller'&&!m.state.enabled);
  for(const at of [1500,1750,2000,2250])await f.telemetry({dist:null,pos:null},at);
  const last=await f.connect('/ws/ui');assert.equal((await last.wait(m=>m.type==='snapshot')).controller.enabled,false);
});

test('PID activo durante pausas, fallos, POS ausente y reinicios de sesión; solo disable lo apaga',()=>{
  const c=new ConveyorController();c.reset(0);c.configure({forwardIncreasesDistance:false},0);
  c.observe(raw({pos:null,dist:null}),0);c.enable(0);c.applied(c.tick(0).output,0);
  let now=0;
  for(const reason of ['telemetry','encoder','manual']){
    now+=250;c.pause(now,'Esperando '+reason,reason);
    assert.equal(c.enabled,true);assert.equal(c.outputPercent,0);assert.equal(c.tick(now),null);
    now+=250;c.reset(now);assert.equal(c.enabled,true);assert.equal(c.waitFor,reason);
    assert.equal(c.tick(now),null);assert.equal(c.config.forwardIncreasesDistance,false);
    now+=250;c.observe(raw({pos:null,dist:null,vel_r:0,rpm_r:0}),now);
    const first=c.tick(now);
    if(reason==='telemetry')assert.ok(first.output>0);
    else assert.equal(first,null);
    now+=250;c.observe(raw({dir:'FWD',pos:null,vel_r:2,rpm_r:13}),now);
    const moving=c.tick(now);
    if(reason==='manual'){
      assert.equal(moving,null);c.manual('F',now);assert.ok(c.tick(now).output>0);
    }else assert.ok(moving.output>0);
    assert.equal(c.enabled,true);
  }
  c.disable(now);assert.equal(c.enabled,false);
  c.reset(now+10000);c.observe(raw(),now+10001);assert.equal(c.tick(now+10001),null);
  assert.equal(c.enabled,false);
});

test('WebSocket: PID conserva estado/configuración al reconectar y retoma solo con muestras nuevas',async t=>{
  const f=await fixture(t);await f.ready();
  const before=await f.connect('/ws/ui');const initial=(await before.wait(m=>m.type==='snapshot')).controller;
  const closed=once(f.esp.socket,'close');f.esp.socket.close();await closed;
  await f.ui.wait(m=>m.type==='controller'&&m.state.enabled&&m.state.status==='waiting');
  const offline=await f.connect('/ws/ui');const waiting=(await offline.wait(m=>m.type==='snapshot')).controller;
  assert.equal(waiting.enabled,true);assert.equal(waiting.outputPercent,0);assert.deepEqual(waiting.config,initial.config);
  const esp=await f.connect('/ws/esp32');acknowledge(esp.socket);
  await esp.wait(m=>m==='STATUS\n');await delay(30);assert.deepEqual(esp.messages,['STATUS\n']);
  f.setTime(250);esp.socket.send(JSON.stringify(raw({dist:null,pos:null})));
  await esp.wait(m=>m==='V6\n');await esp.wait(m=>m==='F\n');
  const recovered=await f.connect('/ws/ui');const snap=(await recovered.wait(m=>m.type==='snapshot')).controller;
  assert.equal(snap.enabled,true);assert.equal(snap.status,'running');assert.equal(snap.outputPercent,6);
  assert.deepEqual(snap.config,initial.config);
  // Every browser receives the same explicit user disable, including late joins.
  assert.equal((await f.request('disable')).status,'ack');
  await recovered.wait(m=>m.type==='controller'&&!m.state.enabled);
  const late=await f.connect('/ws/ui');assert.equal((await late.wait(m=>m.type==='snapshot')).controller.enabled,false);
});

test('WebSocket: parada manual permanece al reconectar; desactivar PID funciona con ESP ausente',async t=>{
  const f=await fixture(t);await f.ready();
  f.ui.socket.send(JSON.stringify({type:'command',id:'pause-e',command:'E'}));
  await f.ui.wait(m=>m.id==='pause-e'&&m.status==='ack');
  const closed=once(f.esp.socket,'close');f.esp.socket.close();await closed;
  const esp=await f.connect('/ws/esp32');acknowledge(esp.socket);await esp.wait(m=>m==='STATUS\n');
  for(const at of [250,500,750,1000]){
    f.setTime(at);esp.socket.send(JSON.stringify(raw({dist:null,pos:null})));
    await f.ui.wait(m=>m.type==='telemetry'&&m.timeMs===at);
  }
  await delay(30);assert.deepEqual(esp.messages,['STATUS\n']);
  const late=await f.connect('/ws/ui');const state=(await late.wait(m=>m.type==='snapshot')).controller;
  assert.equal(state.enabled,true);assert.equal(state.status,'paused');assert.equal(state.outputPercent,0);
  const closedAgain=once(esp.socket,'close');esp.socket.close();await closedAgain;
  assert.equal((await f.request('disable')).status,'ack');
  await late.wait(m=>m.type==='controller'&&!m.state.enabled);
  const another=await f.connect('/ws/esp32');await another.wait(m=>m==='STATUS\n');
  f.setTime(1250);another.socket.send(JSON.stringify(raw({dist:null,pos:null})));
  const frame=await f.ui.wait(m=>m.type==='telemetry'&&m.timeMs===1250);
  assert.equal(frame.controller.enabled,false);await delay(30);assert.deepEqual(another.messages,['STATUS\n']);
});

test('WebSocket: timeout de ACK o de E nunca desactiva PID; confirmaciones tardías no crean parada manual',async t=>{
  const f=await fixture(t,{ack:false});await f.ready();
  f.setTime(500);await f.esp.wait(m=>m==='E\n');
  const waiting=await f.connect('/ws/ui');const snapshot=(await waiting.wait(m=>m.type==='snapshot')).controller;
  assert.equal(snapshot.enabled,true);assert.equal(snapshot.status,'waiting');assert.equal(snapshot.outputPercent,0);
  f.esp.socket.send('STOP INMEDIATO');
  await f.ui.wait(m=>m.type==='command'&&m.command==='E'&&m.status==='ack');
  f.esp.socket.send('Direccion: ADELANTE\nSTOP INMEDIATO'); // replies to cancelled/confirmed commands
  acknowledge(f.esp.socket);
  await f.telemetry({dist:null,pos:null},750);await f.esp.wait(m=>m==='V6\n');
  const resumed=await f.connect('/ws/ui');assert.equal((await resumed.wait(m=>m.type==='snapshot')).controller.status,'running');

  // Repeat timeout with a device that never acknowledges even the stop.
  const g=await fixture(t,{ack:false});await g.ready();
  g.setTime(500);await g.esp.wait(m=>m==='E\n');g.setTime(1000);
  await g.ui.wait(m=>m.type==='link'&&!m.connected);
  const disconnected=await g.connect('/ws/ui');const inactiveLink=(await disconnected.wait(m=>m.type==='snapshot')).controller;
  assert.equal(inactiveLink.enabled,true);assert.equal(inactiveLink.status,'waiting');
});

test('WebSocket: fallos de telemetría y pausa del bucle conservan PID y recuperan con encoder válido',async t=>{
  for(const fault of ['gap','stale','encoder']){
    const f=await fixture(t);await f.ready();
    let at=250;
    if(fault==='gap'){at=1500;f.setTime(at);}
    else{
      if(fault==='encoder'){
        f.esp.socket.send(JSON.stringify(raw({rpm_r:-1})));
        await f.ui.wait(m=>m.type==='event'&&m.event.text==='Telemetría inválida descartada');
      }
      for(at=250;at<=3250;at+=250){f.setTime(at);await delay(30);}
      at=3250;
    }
    await f.esp.wait(m=>m==='E\n');await f.ui.wait(m=>m.type==='command'&&m.command==='E'&&m.status==='ack');
    const paused=await f.connect('/ws/ui');const snap=(await paused.wait(m=>m.type==='snapshot')).controller;
    assert.equal(snap.enabled,true);assert.equal(snap.status,'waiting');assert.equal(snap.outputPercent,0);
    await f.telemetry({dist:null,pos:null},at+250);await f.esp.wait(m=>m==='V6\n');
    const resumed=await f.connect('/ws/ui');const final=(await resumed.wait(m=>m.type==='snapshot')).controller;
    assert.equal(final.enabled,true);assert.equal(final.status,'running');
  }
});

test('WebSocket a 100 %: rearme rápido y nueva pieza usan salida nueva, encoder/modelo permanecen independientes',async t=>{
  const f=await fixture(t);
  await f.telemetry({dist:20,pos:16});
  await f.request('configure',{initialPercent:100,maxPercent:100,forwardIncreasesDistance:false});
  await f.request('enable');await f.ui.wait(m=>m.type==='command'&&m.command==='S'&&m.status==='ack');
  await f.telemetry({dist:20,pos:null},250);
  await f.telemetry({dist:20,pos:null},500);
  await f.esp.wait(m=>m==='V100\n');await f.esp.wait(m=>m==='F\n');
  await f.ui.wait(m=>m.type==='command'&&m.command==='F'&&m.status==='ack');
  const second=await f.connect('/ws/ui');const snap=await second.wait(m=>m.type==='snapshot');
  assert.equal(snap.controller.enabled,true);assert.equal(snap.controller.outputPercent,100);
  await f.telemetry({dir:'FWD',v:100,rpm_m:20,state:'RAMP',dist:20.8,pos:16.8,rpm_r:2,vel_r:.3},750);
  await f.ui.wait(m=>m.type==='controller'&&m.state.status==='braking'&&m.state.outputPercent<10);
  await f.telemetry({dir:'FWD',v:7,rpm_m:10,state:'RAMP',dist:20.8,pos:null,rpm_r:2,vel_r:.3},800);
  await f.telemetry({dir:'FWD',v:7,rpm_m:10,state:'RAMP',dist:45,pos:41,rpm_r:2,vel_r:.3},850);
  await second.wait(m=>m.type==='controller'&&m.state.outputPercent>=90&&m.state.outputPercent<100);
  const packet=await second.wait(m=>m.type==='telemetry'&&m.timeMs===850);
  assert.equal(packet.controller.enabled,true);assert.equal(packet.data.vel_r,.3);assert.equal(packet.data.pos,44.7);
  close(packet.model.errorCmS,.3-packet.model.speedCmS);
  const sends=f.ui.messages.filter(m=>m.type==='command'&&m.status==='sent'&&m.source==='pid');
  assert.ok(sends.some(m=>/^V9\d$/.test(m.command)));
  assert.ok(sends.every(m=>!m.command.startsWith('V')||Number(m.command.slice(1))<=100));
});

test('G(s): Hz del ensayo a RPM del rodillo y cm/s, misma dinámica y micropaso independiente',()=>{
  const inputScale=40,outputScale=Math.PI*2.95/60;
  close(PID_DEFAULTS.inputScale,inputScale);close(PID_DEFAULTS.outputScale,outputScale);
  for(const m of [2,4,8,16]){
    const c=new ConveyorController(),original=new PlantModel();c.reset(0);
    c.observe(raw({m,dir:'FWD',v:100,vel_r:MAX_BELT_CM_S,rpm_r:71.25}),0);
    let now=0;
    for(const [command,dt] of [[100,.25],[100,.75],[-65,.13],[-65,1.4],[0,2],[37.5,15]]){
      c.applied(command,now);now+=dt*1000;c.advance(now);
      close(c.modelSample().speedCmS,Math.abs(original.advance(command,dt))*inputScale*outputScale);
      close(c.modelSample().errorCmS,MAX_BELT_CM_S-c.modelSample().speedCmS);
    }
    c.applied(100,now);c.advance(now+100000);
    const expected=4000*.1425/8.058;
    close(c.modelSample().rollerRpm,expected);close(c.modelSample().speedCmS,expected*ROLLER_CM_PER_REV/60);
    assert.ok(Math.abs(c.modelSample().speedCmS/MAX_BELT_CM_S-1)<.01,'nominal model and encoder share cm/s, without forcing identical gain');
  }
});

test('POS calibrada llega a backend, varias webs, historial y PID sin corregir DIST ni encoder',async t=>{
  const f=await fixture(t);
  const frame=await f.telemetry({dist:10.3,pos:6.3,vel_r:2,rpm_r:13});
  assert.equal(frame.data.pos,10);assert.equal(frame.data.dist,10.3);assert.equal(frame.data.vel_r,2);
  assert.equal(frame.controller.remainingCm,10.3-20); // Existing PID distance feedback remains DIST.
  const other=await f.connect('/ws/ui');const snap=await other.wait(m=>m.type==='snapshot');
  assert.equal(snap.last.data.pos,10);assert.deepEqual(snap.last.data,frame.data);
  const state=new LabState(()=>0);state.setBridge(true);state.setLink(true,'esp');
  state.ingest(parseTelemetry(JSON.stringify({type:'telemetry',data:frame.data})),0,frame.model);
  assert.equal(state.raw.pos,10);assert.equal(state.history.at(-1).position,10);
  assert.equal(state.history.at(-1).speed,2);
  await f.request('configure',{targetCm:10,initialPercent:25,maxPercent:25,forwardIncreasesDistance:false});
  await f.request('enable');await f.esp.wait(m=>m==='S\n');
  const stopped=await f.ui.wait(m=>m.type==='controller'&&m.state.status==='target');
  assert.equal(stopped.state.config.initialPercent,100);assert.equal(stopped.state.config.maxPercent,100);
  assert.equal(stopped.state.enabled,true);assert.ok(stopped.state.remainingCm<.31);
  await f.telemetry({dist:10.3,pos:null},250);await f.telemetry({dist:10.3,pos:null},500);
  await f.esp.wait(m=>m==='V100\n');await f.esp.wait(m=>m==='F\n');
  const noObject=await other.wait(m=>m.type==='telemetry'&&m.timeMs===500);
  assert.equal(noObject.data.pos,null);assert.equal(noObject.controller.remainingCm,null);
  assert.equal(noObject.controller.enabled,true);
});

test('calibración POS: offset físico único, NA/null/missing y límites sin falsa detección',()=>{
  const source=raw({dist:10.3,pos:6.3}),copy=structuredClone(source);
  const calibrated=calibrateTelemetry(source);assert.equal(calibrated.pos,10);assert.deepEqual(source,copy);
  assert.deepEqual({...calibrated,pos:source.pos},source);
  for(const pos of [null,undefined,NaN,Infinity,-1])assert.equal(calibrateTelemetry({...source,pos}).pos,null);
  for(const pos of [44,45,46]){
    const result=calibrateTelemetry({...source,pos});assert.ok(result.pos>45);assert.equal(validFeedback(result),false);
  }
  assert.equal(calibrateTelemetry(null),null);
  assert.deepEqual(calibrated,calibrateTelemetry(parseTelemetry('DIR=STOP,V=50,M=8,RPM_M=0,RPM_T=0,RPM_R=0,VEL_T=0,VEL_R=0,DIST=10.3,POS=6.3,ERR=0,STATE=OK')));
  assert.equal(parseTelemetry(JSON.stringify(calibrated)).pos,10,'browser parsing must not apply the ingress offset again');
});
