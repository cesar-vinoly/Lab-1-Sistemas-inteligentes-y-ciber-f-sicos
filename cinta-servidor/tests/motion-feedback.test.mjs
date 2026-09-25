import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from '../vendor/ws/wrapper.mjs';
import {ConveyorController} from '../control/pid.mjs';
import {attachControlSocket} from '../control/websocket.mjs';
import {LabState} from '../app/lab-state.ts';
import {createTransmission} from '../app/transmission.ts';
import {CONTROL,GEAR_RATIO,ROLLER_CM_PER_REV} from '../shared/control-protocol.mjs';

const reading=(changes={})=>({dir:'STOP',v:50,m:8,rpm_m:0,rpm_r:0,vel_r:0,dist:null,pos:null,state:'OK',rpm_t:0,vel_t:0,err:0,...changes});
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('estado nativo arranca antes de la ventana del encoder; no hay segunda rampa al frenar',()=>{
  const c=new ConveyorController();c.reset(0);c.observe(reading(),0);
  c.manual('F',0);c.advance(49);assert.equal(c.snapshot().feedback.driveRpm,0);
  c.observe(reading({dir:'FWD',rpm_m:6,state:'RAMP'}),50);
  assert.equal(c.feedback.driveRpm,6); // Encoder still zero; native motor has started.
  for(let at=100;at<=2000;at+=50)c.observe(reading({dir:'FWD',rpm_m:75,rpm_r:28.5,vel_r:4.4}),at);
  close(c.feedback.driveRpm,60); // Real encoder gain is 0.8, not nominal 1.
  c.applied(5,2000);assert.equal(c.feedback.driveRpm,60); // New target alone changes nothing.
  for(const [at,rpm] of [[2050,60],[2100,30],[2150,6]]){
    c.observe(reading({dir:'FWD',rpm_m:rpm,rpm_r:28.5,vel_r:4.4,state:'RAMP'}),at);
    close(c.feedback.driveRpm,rpm*.8); // Held encoder does not retain the old speed.
  }
  c.observe(reading({rpm_r:28.5,vel_r:4.4}),2200);assert.equal(c.feedback.driveRpm,0);
  c.observe(reading({dir:'REV',rpm_m:6,rpm_r:28.5,vel_r:4.4,state:'RAMP'}),2250);
  close(c.feedback.driveRpm,4.8); // Restart uses the last measured gain immediately.
});

test('encoder en cero, datos inválidos y pérdida de enlace no generan movimiento indefinido',()=>{
  const c=new ConveyorController();c.reset(0);c.observe(reading(),0);
  for(let at=50;at<=2700;at+=50){
    c.observe(reading({dir:'FWD',rpm_m:75}),at);
    assert.equal(c.feedback.driveRpm,at<2550?75:0);
  }
  c.observe(reading({dir:'FWD',rpm_m:75,rpm_r:28.5,vel_r:4.4}),2750);close(c.feedback.driveRpm,60);
  c.observe(reading({dir:'FWD',rpm_m:75}),2800);assert.equal(c.feedback.driveRpm,0);
  c.observe(reading({dir:'FWD',rpm_m:75,rpm_r:NaN}),2850);assert.equal(c.feedback.driveRpm,0);
  c.reset(2900);assert.equal(c.feedback.driveRpm,0);assert.equal(c.enabled,false);
});

test('PID: VEL_R o RPM_R cero detienen el gemelo sin rampa ni último giro, conservando los datos',()=>{
  for(const zero of [{vel_r:0,rpm_r:35.6},{vel_r:5.5,rpm_r:0},{vel_r:0,rpm_r:0}]){
    for(const direction of ['FWD','REV']){
      let now=0;
      const c=new ConveyorController();c.reset(now);c.observe(reading(),now);c.enable(now);
      const state=new LabState(()=>now),twin=createTransmission();state.setLink(true,'pid');
      const updates=[];twin.onRotate('roller1',angle=>updates.push(angle));
      const ingest=raw=>{
        const before=structuredClone(raw);
        c.observe(raw,now);state.setController(c.snapshot());state.ingest(raw,now,c.lastModel);
        twin.setMotion(state.snapshot().control,now);assert.deepEqual(raw,before);
      };
      now=50;ingest(reading({dir:direction,rpm_m:75,rpm_r:35.6,vel_r:5.5}));twin.update(100);
      const phase=twin.getState().phase,count=updates.length;
      // Keep native RPM high to verify encoder zero, not a command/model stop.
      now=500;const raw=reading({dir:direction,rpm_m:75,...zero,state:'RAMP'});ingest(raw);
      assert.equal(c.enabled,true);assert.equal(state.history.at(-1).speed,zero.vel_r);
      assert.equal(c.latest.rpm_r,zero.rpm_r);assert.equal(state.raw.rpm_m,75);
      assert.equal(state.history.at(-1).modelSpeed,c.lastModel.speedCmS);
      for(const at of [499,500,516,1000,3000,100000]){
        assert.equal(twin.update(at),false);assert.equal(twin.getState().phase,phase);
        assert.equal(twin.getState().driveRpm,0);assert.equal(updates.length,count);
      }
      // Controller/ACK changes retain zero feedback and cannot reanimate it.
      now=100100;c.applied(100,now);state.setController(c.snapshot());
      twin.setMotion(state.snapshot().control,now);assert.equal(twin.getState().phase,phase);
      now=100150;ingest(reading({dir:direction,rpm_m:30,rpm_r:14.25,vel_r:2.2}));
      twin.update(now+20);assert.ok(twin.getState().driveRpm!==0);
      assert.ok(Math.abs(twin.getState().phase-phase)<.1,'restart does not replay stopped time');
    }
  }
});

test('parada medida cancela la gracia inicial; muestras en cero y ACK no rearman el observador',()=>{
  const c=new ConveyorController();c.reset(0);
  c.observe(reading({dir:'FWD',rpm_m:75,rpm_r:35.6,vel_r:0}),50);
  assert.equal(c.feedback.driveRpm,0);
  for(const now of [100,250,500,1000]){
    c.observe(reading({dir:'FWD',rpm_m:75}),now);assert.equal(c.feedback.driveRpm,0);
  }
  // An actual native stop/start still gets the existing fast startup behavior.
  c.observe(reading(),1050);c.observe(reading({dir:'FWD',rpm_m:6,state:'RAMP'}),1100);
  assert.equal(c.feedback.driveRpm,6);
});

// Independent firmware fixture: 20 ms motor ticks; actual optical edges (20
// per roller revolution); the original one-second count/last-edge estimator,
// including its first empty measurement and two-second no-edge timeout.
function physicalTrace(load=1){
  let motor=0,dir=0,requested=0,percent=50,encoder=0,pulses=0,lastPulse=0,encoderRef=0,phase=0;
  const samples=[];
  for(let at=0;at<=14000;at+=10){
    if(at===0||at===8000){requested=1;percent=50;}
    if(at>=4000&&at<6000&&at%250===0)percent=50-(at-3750)/50;
    if(at===6000)requested=0;
    if(at===11000)requested=-1;
    if(at===13000){requested=0;dir=0;motor=0;}
    if(at&&at%20===0){
      if(!dir&&requested)dir=requested;
      const target=dir!==requested&&dir!==0?0:percent*1.5;
      motor=motor<target?Math.min(target,motor+2.4):Math.max(target,motor-6);
      if(motor<.1&&dir!==requested){motor=0;dir=requested;}
    }
    if(!requested&&!dir)motor=0;
    const real=motor*load;
    if(at){
      const increment=real*GEAR_RATIO*20/6000;
      let edge=Math.floor(phase)+1;
      while(edge<=phase+increment){pulses++;lastPulse=at-10+(edge-phase)/increment*10;edge++;}
      phase+=increment;
    }
    if(at&&at%1000===0){
      if(pulses){if(encoderRef)encoder=pulses/20*60000/(lastPulse-encoderRef);encoderRef=lastPulse;}
      else if(at-lastPulse>2000){encoder=0;encoderRef=0;}
      pulses=0;
    }
    if(at%50===0)samples.push({at,real,dir,data:reading({dir:dir>0?'FWD':dir<0?'REV':'STOP',v:percent,
      rpm_m:Number(motor.toFixed(1)),rpm_r:Number(encoder.toFixed(1)),vel_r:Number((encoder*ROLLER_CM_PER_REV/60).toFixed(2)),
      state:Math.abs(motor-(requested?percent*1.5:0))>2?'RAMP':'OK'})});
  }
  return samples;
}

test('traza física: arranque rápido, frenado, reversa y rearranque con encoder promediado real',t=>{
  for(const load of [1,.8]){
    const c=new ConveyorController();c.reset(0);
    let now=0,visualError=0,heldError=0,firstVisual=null,firstEncoder=null;
    const state=new LabState(()=>now);state.setLink(true,'trace');
    for(const sample of physicalTrace(load)){
      now=sample.at;c.observe(sample.data,now);state.setController(c.snapshot());state.ingest(sample.data,now,c.lastModel);
      const control=state.snapshot().control;
      if(control.driveRpm>0)firstVisual??=now;
      if(sample.data.rpm_r>0)firstEncoder??=now;
      if(sample.real===0)assert.equal(control.driveRpm,0);
      if(control.driveRpm>0)assert.equal(control.direction,-sample.dir);
      if(now>=4000&&now<6000){
        visualError+=Math.abs(control.driveRpm-sample.real);
        heldError+=Math.abs(sample.data.rpm_r/GEAR_RATIO-sample.real);
      }
      assert.equal(state.history.at(-1).speed,sample.data.vel_r);
      close(state.history.at(-1).speedError,sample.data.vel_r-c.lastModel.speedCmS);
    }
    assert.equal(firstVisual,50);assert.equal(firstEncoder,2000);
    assert.ok(visualError<heldError*.4,`deceleration error ${visualError} / ${heldError}`);
    t.diagnostic(`Carga ${load}: primer movimiento 50 ms frente a encoder 2000 ms; error de frenado ${Math.round(100*visualError/heldError)} % del anterior (simulación).`);
  }
});

test('todos los navegadores, incluso nuevos, comparten feedback y conservan encoder/modelo separados',()=>{
  let now=0;const c=new ConveyorController();c.reset(0);
  const clients=[new LabState(()=>now),new LabState(()=>now)],twins=clients.map(()=>createTransmission());
  for(const client of clients)client.setLink(true,'session');
  for(const sample of physicalTrace(.8)){
    now=sample.at;c.observe(sample.data,now);
    if(now===850){const client=new LabState(()=>now);client.setLink(true,'session');clients.push(client);twins.push(createTransmission());}
    for(let i=0;i<clients.length;i++){
      clients[i].setController(c.snapshot());clients[i].ingest(sample.data,now,c.lastModel);twins[i].setMotion(clients[i].snapshot().control,now);
      close(twins[i].getState().driveRpm,twins[0].getState().driveRpm);
    }
  }
});

test('STATUS rápido conserva protocolo, limita consultas y transmite arranque sin esperar el encoder',async t=>{
  let now=0,moving=false;const server=http.createServer((req,res)=>res.end());
  const bridge=attachControlSocket(server,{clock:()=>now});server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='ws://127.0.0.1:'+server.address().port,sockets=[];
  const connect=async path=>{const ws=new WebSocket(base+path);sockets.push(ws);await once(ws,'open');return ws;};
  t.after(async()=>{for(const ws of sockets)ws.terminate();bridge.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const ui=new WebSocket(base+'/ws/ui');sockets.push(ui);const frames=[];
  ui.on('message',b=>frames.push(JSON.parse(b)));await once(ui,'open');
  const esp=await connect('/ws/esp32'),polls=[];
  esp.on('message',b=>{
    const command=b.toString().trim();
    if(command==='F'){moving=true;esp.send('Direccion: ADELANTE');}
    if(command==='STATUS'){
      polls.push(now);
      esp.send(JSON.stringify(reading(moving&&now>0?{dir:'FWD',rpm_m:6,state:'RAMP'}:{})));
    }
  });
  const wait=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await delay(5);}assert.fail('no llegó la respuesta');};
  esp.send(JSON.stringify(reading()));await wait(()=>frames.some(m=>m.type==='telemetry'));
  ui.send(JSON.stringify({type:'command',id:'start',command:'F'}));await wait(()=>moving);
  assert.ok(!frames.some(m=>m.type==='telemetry'&&m.controller.feedback.driveRpm>0));
  now=50;await wait(()=>frames.some(m=>m.type==='telemetry'&&m.controller.feedback.driveRpm===6));
  assert.equal(frames.find(m=>m.type==='telemetry'&&m.controller.feedback.driveRpm===6).data.rpm_r,0);
  for(const at of [75,100,125,150,200]){now=at;await delay(30);}
  for(let i=1;i<polls.length;i++)assert.ok(polls[i]-polls[i-1]>=CONTROL.motionPollMs);
  // A slow/nonresponsive ESP must not accumulate twenty unanswered polls/s.
  esp.removeAllListeners('message');const unanswered=[];esp.on('message',b=>unanswered.push(b.toString()));
  for(let at=250;at<=700;at+=50){now=at;await delay(28);}
  assert.ok(unanswered.filter(m=>m==='STATUS\n').length<=3);
  assert.ok(!frames.some(m=>m.type==='command'&&m.command==='STATUS'));
});
