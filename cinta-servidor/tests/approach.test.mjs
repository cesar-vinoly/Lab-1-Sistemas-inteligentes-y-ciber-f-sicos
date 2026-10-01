/**
 * Pruebas automatizadas de perfil de aproximación, despeje y rearranque automático.
 * Los relojes/dispositivos simulados permiten reproducir transiciones sin hardware.
 * Estas verificaciones no sustituyen un ensayo físico de la cinta.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {ConveyorController} from '../control/pid.mjs';
import {MAX_BELT_CM_S,PID_DEFAULTS,APPROACH,validatePidConfig} from '../shared/control-protocol.mjs';
import {advanceMotor} from '../shared/motor-motion.mjs';
import {createTransmission,ROTORS} from '../app/transmission.ts';
import {Group,Quaternion,Vector3} from 'three';

const reading=(changes={})=>({dir:'STOP',v:50,m:8,rpm_m:0,rpm_r:0,vel_r:0,dist:45,pos:41,state:'OK',...changes});
const close=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<eps,`${a} != ${b}`);

// Independent discrete motor fixture: 20 ms hardware updates, 100 ms range
// sampling, 250 ms telemetry and a held 1 s encoder measurement. It never
// calls advanceMotor or the controller's plant to generate physical feedback.
function journey(config={},noise=0,load=1,detectAfter=0){
  const c=new ConveyorController();c.reset(0);c.configure({forwardIncreasesDistance:false,...config},0);
  let distance=45,rpm=0,actual=0,command=0,range=distance,encoder=0,windowDistance=0;
  const sign=c.config.forwardIncreasesDistance?-1:1,commands=[],samples=[];
  let stoppedAt=null;
  for(let now=0;now<=120000;now+=10){
    // The object enters the belt when detection starts; don't let an invisible
    // preexisting object pass the goal before the first observation at 100%.
    if(detectAfter&&now===detectAfter)distance=45;
    if(now&&now%20===0){
      const requested=Math.sign(command);
      if(!actual&&requested&&rpm<.1)actual=requested;
      const target=actual!==requested&&actual!==0?0:Math.abs(command)*1.5;
      rpm=rpm<target?Math.min(target,rpm+120*.02):Math.max(target,rpm-300*.02);
      if(rpm<.1&&actual!==requested){rpm=0;actual=requested;}
    }
    if(now){
      const speed=rpm/150*MAX_BELT_CM_S*load;
      distance-=actual*sign*speed*.01;windowDistance+=speed*.01;
    }
    if(now&&now%1000===0){encoder=now===1000?0:windowDistance;windowDistance=0;}
    if(now%100===0)range=distance+noise*Math.sin(now/71);
    if(now%250===0){
      const data=reading({dir:actual>0?'FWD':actual<0?'REV':'STOP',v:Math.abs(command)||c.config.initialPercent,
        rpm_m:rpm,vel_r:encoder,rpm_r:encoder/(Math.PI*2.95)*60,
        dist:now<detectAfter?5:range,pos:now<detectAfter?null:Math.max(0,range-4),
        state:Math.abs(rpm-Math.abs(command)*1.5)>2?'RAMP':'OK'});
      c.observe(data,now);samples.push({now,...data});if(!now)c.enable(now);
    }
    const next=c.tick(now);assert.ok(!next?.fault,next?.fault);
    if(next&&Object.hasOwn(next,'output')){
      command=next.output;c.applied(command,now);
      commands.push({now,value:Math.abs(command),braking:c.braking,distance});
      assert.ok(command===0||Math.sign(command)===sign,'no automatic reversal');
    }
    if(c.goalLatched&&rpm===0){stoppedAt=now;break;}
  }
  assert.notEqual(stoppedAt,null,'must reach the target, not stop and stall short');
  assert.ok(distance>=c.config.targetCm,`overshoot: ${distance}`);
  assert.ok(distance<=c.config.targetCm+c.config.toleranceCm+noise+.03,`stopped early: ${distance}`);
  assert.ok(commands.every(p=>p.value<=c.config.maxPercent),'physical command saturation');
  const braking=commands.filter(p=>p.braking);
  for(let i=1;i<braking.length;i++)assert.ok(braking[i].value<=braking[i-1].value,'no stop/start chatter');
  assert.ok(commands.some(p=>p.value>0&&p.value<commands[0].value),'progressive braking');
  assert.equal(commands.filter(p=>p.value===0).length,1,'single retained stop');
  return {c,commands,samples,distance};
}

test('aproximación: rampas físicas, encoder retenido, ruido y ambos sentidos',()=>{
  for(const sampleMs of [50,250,500,1000,2000]){
    for(const forwardIncreasesDistance of [false,true])journey({sampleMs,forwardIncreasesDistance},.05);
  }
  for(const [initialPercent,maxPercent,minPercent,load] of [[25,100,0,.8],[100,100,0,1],[80,40,20,1],[50,100,30,1.1]]){
    const {c,commands}=journey({initialPercent,maxPercent,minPercent},.05,load);
    assert.equal(c.config.initialPercent,100);assert.equal(c.config.maxPercent,100);assert.equal(c.config.minPercent,0);
    assert.ok(commands[0].value>80&&commands[0].value<=100,'only distance may reduce the initial command');
    assert.ok(commands.some(p=>p.value>0&&p.value<20),'approach remains possible below an old minimum');
  }
});

test('sin objeto al arrancar; detección posterior frena y retiene la parada',()=>{
  for(const forwardIncreasesDistance of [false,true]){
    const {commands}=journey({forwardIncreasesDistance},.05,1,3000);
    assert.equal(commands[0].value,100);
    assert.ok(commands.filter(p=>p.now<3000).every(p=>!p.braking));
    assert.ok(commands.some(p=>p.now>=3000&&p.braking));
  }
});

test('sin eco o DIST retenida: marcha estable sin usar la distancia antigua',()=>{
  for(const absence of [{dist:null,pos:null},{dist:5,pos:null},{dist:20,pos:null},{dist:null,pos:10},{dist:450,pos:45}]){
    const c=new ConveyorController();c.reset(0);c.configure({initialPercent:40,forwardIncreasesDistance:false},0);
    c.observe(reading(absence),0);c.enable(0);assert.deepEqual(c.tick(0),{output:100});c.applied(100,0);
    for(let now=250;now<=10000;now+=250){
      c.observe(reading({...absence,dir:'FWD',v:100,rpm_m:150,rpm_r:71.25,vel_r:MAX_BELT_CM_S}),now);
      const next=c.tick(now);assert.ok(!next.fault,next.fault);c.applied(next.output,now);
      assert.equal(c.enabled,true);assert.equal(c.remainingCm,null);assert.equal(c.errorCm,null);
      assert.equal(c.status,'running');assert.ok(c.outputPercent>=99&&c.outputPercent<=100);assert.equal(c.goalLatched,false);
    }
  }
});

test('sin objeto el encoder sigue corrigiendo y recupera la velocidad de crucero',()=>{
  const c=new ConveyorController();c.reset(0);c.configure({forwardIncreasesDistance:false},0);
  c.observe(reading({dist:null,pos:null}),0);c.enable(0);c.applied(c.tick(0).output,0);
  const step=(now,velocity)=>{
    const previous=c.outputPercent;
    c.observe(reading({dir:'FWD',dist:5,pos:null,rpm_m:previous*1.5,rpm_r:velocity/(Math.PI*2.95)*60,vel_r:velocity}),now);
    const next=c.tick(now);assert.ok(!next.fault,next.fault);c.applied(next.output,now);
    assert.ok(c.outputPercent<=100);assert.ok(c.outputPercent-previous<=APPROACH.slewPercentS*.25);
  };
  for(let now=250;now<=1500;now+=250)step(now,MAX_BELT_CM_S*1.3);
  assert.ok(c.outputPercent<100,'must respond to overspeed even with no object');
  for(let now=1750;now<=6000;now+=250)step(now,MAX_BELT_CM_S*.8);
  assert.equal(c.outputPercent,100);
});

test('si desaparece el objeto antes de llegar, confirma despeje y recupera la consigna de crucero',()=>{
  const c=new ConveyorController();c.reset(0);c.configure({forwardIncreasesDistance:false},0);
  c.observe(reading(),0);c.enable(0);c.applied(c.tick(0).output,0);
  c.observe(reading({dir:'FWD',rpm_m:75,vel_r:5,dist:23,pos:19}),250);c.applied(c.tick(250).output,250);
  const slow=c.outputPercent;assert.ok(slow<50);assert.equal(c.braking,true);
  for(let now=500;now<=1250;now+=250){
    const previous=c.outputPercent;
    c.observe(reading({dir:'FWD',rpm_m:previous*1.5,rpm_r:6.5,vel_r:1,dist:23,pos:null}),now);c.applied(c.tick(now).output,now);
    assert.equal(c.braking,now<750);assert.equal(c.remainingCm,null);
    if(now<750)assert.ok(c.outputPercent<=previous);
    else assert.equal(c.outputPercent,100);
  }
  close(c.speedReferenceCmS,MAX_BELT_CM_S);
});

test('rearranque repetido: ausencia confirmada o salida de la zona; sin bloqueo ni salto de integral',()=>{
  for(const forwardIncreasesDistance of [false,true]){
    for(const clear of [{dist:20,pos:null},{dist:45,pos:41}]){
      const c=new ConveyorController();c.reset(0);c.configure({forwardIncreasesDistance},0);
      c.observe(reading(),0);c.enable(0);c.applied(c.tick(0).output,0);
      let now=250;
      for(let cycle=0;cycle<8;cycle++){
        c.observe(reading({dist:20,pos:16}),now);
        assert.deepEqual(c.tick(now,false),{output:0});c.applied(0,now);assert.equal(c.status,'target');
        // Hold for several seconds: that time must not become a large PID dt.
        for(let i=0;i<20;i++){
          now+=250;c.observe(reading({dist:20,pos:16}),now);assert.equal(c.tick(now),null);
        }
        const clearedAt=now+250;
        for(let i=0;i<2;i++){
          now+=250;c.observe(reading(clear),now);
          const next=c.tick(now);
          if(i<1){assert.equal(next,null);assert.equal(c.outputPercent,0);}
          else{
            assert.equal(now-clearedAt,250);
            if(clear.pos===null)assert.equal(Math.abs(next.output),100);
            else assert.ok(Math.abs(next.output)>=90&&Math.abs(next.output)<100,'far object retains the distance braking envelope');
            assert.equal(Math.sign(next.output),forwardIncreasesDistance?-1:1);
            c.applied(next.output,now);assert.equal(c.goalLatched,false);assert.equal(c.braking,clear.pos!==null);
            assert.equal(c.effectiveSampleMs,250);assert.equal(c.pid.integral,0);
          }
        }
        now+=250;
      }
    }
  }
});

test('ecos intermitentes, ruido en la meta y muestras repetidas no rearman una parada',()=>{
  const c=new ConveyorController();c.reset(0);c.observe(reading({dist:20,pos:16}),0);c.enable(0);
  c.applied(c.tick(0).output,0);
  for(let now=50;now<=4000;now+=50){
    // A short dropout (<200 ms) cannot restart; a close echo cancels release.
    const absence=now%200!==0;
    c.observe(reading({dist:absence?45:20.6,pos:absence?null:16.6}),now);
    assert.equal(c.tick(now),null);assert.equal(c.outputPercent,0);assert.equal(c.enabled,true);
  }
  c.observe(reading({dist:20,pos:null}),4050);
  for(let now=4075;now<=4950;now+=25)assert.equal(c.tick(now),null); // No new sensor frames.
  assert.equal(c.goalLatched,true);
});

test('rearme no necesita eco numérico, respeta ACK pendiente y Detener pausa sin desactivar',()=>{
  for(const stop of [false,true]){
    const c=new ConveyorController();c.reset(0);c.observe(reading({dist:20,pos:16}),0);c.enable(0);c.applied(c.tick(0).output,0);
    for(let now=250;now<=1000;now+=250){
      c.observe(reading({dist:null,pos:null}),now);assert.equal(c.tick(now,false),null);
    }
    if(stop){c.manual('S',1000);}
    c.observe(reading({dist:null,pos:null}),1250);
    const next=c.tick(1250);
    if(stop){assert.equal(next,null);assert.equal(c.enabled,true);assert.equal(c.status,'paused');}
    else assert.ok(next.output<0,'restarts after the pending ACK clears');
  }
});

test('misma distancia, distinto encoder: cambia la corrección de velocidad',()=>{
  const run=velocity=>{
    const c=new ConveyorController();c.reset(0);c.configure({forwardIncreasesDistance:false},0);
    c.observe(reading(),0);c.enable(0);c.applied(c.tick(0).output,0);
    for(let now=250;now<=1500;now+=250){
      c.observe(reading({dir:'FWD',rpm_m:75,vel_r:velocity}),now);
      c.applied(c.tick(now).output,now);
    }
    return c;
  };
  const slow=run(4),fast=run(MAX_BELT_CM_S*1.2);
  assert.ok(fast.outputPercent<slow.outputPercent);
  assert.equal(fast.speedReferenceCmS,slow.speedReferenceCmS);
  assert.notEqual(fast.pid.terms.p,slow.pid.terms.p);
});

test('objetivo retenido: parada aun con ACK pendiente; no arranca dentro ni detrás del objetivo',()=>{
  for(const distance of [20.4,20,19]){
    const c=new ConveyorController();c.reset(0);c.observe(reading(),0);c.enable(0);c.applied(c.tick(0).output,0);
    c.observe(reading({dist:distance,pos:distance-4}),50);
    assert.deepEqual(c.tick(50,false),{output:0});c.applied(0,50);
    for(const [now,dist] of [[250,21],[500,19.8],[750,21.2]]){
      c.observe(reading({dist,pos:dist-4}),now);assert.equal(c.tick(now),null);assert.equal(c.outputPercent,0);
    }
    c.disable(750);c.observe(reading({dist:distance,pos:distance-4}),750);c.enable(750);
    assert.deepEqual(c.tick(750),{output:0});
  }
});

test('encoder sin pulsos pese al mando: falla sin acumular integral de arranque',()=>{
  const c=new ConveyorController();c.reset(0);c.observe(reading(),0);c.enable(0);c.applied(c.tick(0).output,0);
  let fault=null;
  for(let now=250;now<=3250;now+=250){
    c.observe(reading({dir:'REV',rpm_m:75,state:now<1000?'RAMP':'OK'}),now);
    const next=c.tick(now);
    if(next?.fault){fault=next.fault;break;}
    c.applied(next.output,now);assert.equal(c.pid.integral,0);assert.ok(Math.abs(next.output)<=100);
  }
  assert.match(fault,/encoder/);
  c.reset(3500);assert.equal(c.remainingCm,null);assert.equal(c.snapshot().motion.targetRpm,0);
});

test('configuración conserva ganancias y muestreo, pero fija el crucero automático en 100 %',()=>{
  const config=validatePidConfig({initialPercent:60,kp:22,ki:10,kd:.5,sampleMs:100});
  assert.equal(config.initialPercent,100);assert.equal(config.maxPercent,100);assert.equal(config.minPercent,0);
  assert.equal(config.kp,22);assert.equal(config.sampleMs,100);
  for(const input of [{initialPercent:0},{initialPercent:101},{initialPercent:2.5},{kp:-1},{ki:Infinity},{kd:10001},{kp:'113.8'}]){
    assert.throws(()=>validatePidConfig(input));
  }
  assert.equal(PID_DEFAULTS.kp,113.8);
});

test('rampa analítica: áreas conocidas, inversión con frenado y paro inmediato',()=>{
  let value=advanceMotor(0,75,.5);close(value.rpm,60);close(value.rpmSeconds,15);
  value=advanceMotor(75,0,.5);close(value.rpm,0);close(value.rpmSeconds,9.375);
  value=advanceMotor(75,-75,1);close(value.rpm,-75);close(value.rpmSeconds,-23.4375);
  assert.throws(()=>advanceMotor(0,1,-1));
});

test('rampas, reversa, rodillos y correa conservan la misma fase a 15/30/60/144 FPS',()=>{
  let reference=null;
  for(const fps of [15,30,60,144]){
    const twin=createTransmission(),rotors=ROTORS.map(spec=>({spec,pivot:twin.add(new Group(),spec)}));
    let beltAngle=0;twin.onRotate('roller1',angle=>{beltAngle+=angle;});
    let start=0;
    // Full speed, lower speed, reversal through zero, normal stop, new start.
    for(const [target,duration] of [[-75,1],[-45,.7],[90,1.3],[0,.5],[-30,.7]]){
      const rpm=twin.getState().driveRpm;
      twin.setMotion({direction:Math.sign(rpm),driveRpm:Math.abs(rpm),targetRpm:target,sampledAt:start},start);
      for(let time=start+1000/fps;time<start+duration*1000;time+=1000/fps)twin.update(time);
      start+=duration*1000;twin.update(start);
    }
    const state=twin.getState();reference??=state;
    close(state.phase,reference.phase);close(state.driveRpm,reference.driveRpm);
    close(beltAngle,state.phase*19/40);
    for(const {spec,pivot} of rotors){
      const q=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),state.phase*spec.ratio);
      assert.ok(1-Math.abs(q.dot(pivot.quaternion))<1e-12);
    }
  }
});

test('ciclos a 100 %: POS=NA libera en 250 ms, descarta integral/derivada y no acumula tiempo detenido',()=>{
  for(const sampleMs of [50,250,1000,2000])for(const forwardIncreasesDistance of [false,true]){
    const c=new ConveyorController();c.reset(0);c.configure({initialPercent:100,maxPercent:100,sampleMs,forwardIncreasesDistance},0);
    c.observe(reading(),0);c.enable(0);c.applied(c.tick(0).output,0);
    let now=0;
    for(let cycle=0;cycle<5;cycle++){
      now+=250;c.observe(reading({dist:20,pos:16}),now);c.applied(c.tick(now).output,now);
      for(let hold=0;hold<12;hold++){
        now+=250;c.observe(reading({dist:20,pos:16}),now);assert.equal(c.tick(now),null);
      }
      c.pid.integral=-80;c.pid.derivative=-15;c.pid.filtered=9; // Previous control history must not leak across objects.
      now+=250;c.observe(reading({dist:20,pos:null}),now);assert.equal(c.tick(now),null);
      assert.equal(c.pid.integral,0);assert.equal(c.pid.derivative,0);assert.equal(c.pid.filtered,null);
      const stoppedPlant=c.plant.x1;
      now+=250;c.observe(reading({dist:20,pos:null}),now);const next=c.tick(now);
      assert.equal(Math.abs(next.output),100);assert.equal(Math.sign(next.output),forwardIncreasesDistance?-1:1);
      assert.equal(c.effectiveSampleMs,sampleMs);assert.equal(c.pid.terms.i,0);assert.equal(c.pid.terms.d,0);
      assert.equal(c.goalLatched,false);assert.equal(c.braking,false);assert.equal(c.enabled,true);
      assert.equal(c.errorCm,null);assert.equal(c.remainingCm,null);assert.equal(c.latest.dist,20);
      if(stoppedPlant!==0)assert.notEqual(c.plant.x1,0,'G(s) must not reset with the object');
      c.applied(next.output,now);
    }
  }
});

test('objeto nuevo lejano no hereda el techo lento, incluso antes de confirmar la ausencia',()=>{
  for(const distance of [20.3,25,35,45]){
    const c=new ConveyorController();c.reset(0);c.configure({initialPercent:100,maxPercent:100,forwardIncreasesDistance:false},0);
    c.observe(reading({dist:20.8,pos:16.8}),0);c.enable(0);c.applied(c.tick(0).output,0);
    const slow=c.outputPercent;assert.ok(slow<10);assert.equal(c.braking,true);
    c.observe(reading({dist:20.8,pos:null}),50);assert.equal(c.tick(50),null);
    c.pid.integral=-75;c.pid.derivative=-10;c.pid.filtered=10;
    c.observe(reading({dist:distance,pos:distance-4}),100);const next=c.tick(100);
    if(distance<=20.5)assert.equal(next.output,0);
    else{
      assert.ok(next.output>slow+20,`${distance} cm: ${next.output} % still uses old ${slow} %`);
      assert.ok(next.output<=100);assert.ok(c.speedReferenceCmS>0);
    }
    assert.equal(c.pid.terms.i,0);assert.equal(c.pid.terms.d,0);assert.equal(c.enabled,true);
    assert.equal(c.latest.pos,distance-4);assert.equal(c.latest.dist,distance);
  }
});

test('reemplazo sin trama NA: salto lejano confirmado recupera velocidad; pico aislado no rearma',()=>{
  const c=new ConveyorController();c.reset(0);c.configure({initialPercent:100,maxPercent:100,forwardIncreasesDistance:false},0);
  c.observe(reading({dist:20,pos:16}),0);c.enable(0);c.applied(c.tick(0).output,0);
  for(const [now,dist] of [[50,45],[100,20],[200,21.2],[250,45],[400,20.9],[500,45]]){
    c.observe(reading({dist,pos:dist-4}),now);assert.equal(c.tick(now),null);
    assert.equal(c.goalLatched,true);assert.equal(c.outputPercent,0);
  }
  c.observe(reading({dist:45,pos:41}),750);const next=c.tick(750);
  assert.ok(next.output>=90&&next.output<=100);assert.equal(c.goalLatched,false);
  assert.equal(c.enabled,true);assert.equal(c.effectiveSampleMs,250);
});

test('rearranque calcula con el encoder actual, no fuerza 100 % con sobrevelocidad ni windup',()=>{
  const run=velocity=>{
    const c=new ConveyorController();c.reset(0);c.configure({initialPercent:100,maxPercent:100,forwardIncreasesDistance:false},0);
    c.observe(reading({dist:20,pos:16}),0);c.enable(0);c.applied(c.tick(0).output,0);
    for(const now of [250,500]){
      c.observe(reading({dist:null,pos:null,vel_r:velocity,rpm_r:velocity*60/(Math.PI*2.95)}),now);
      const next=c.tick(now);if(next)c.applied(next.output,now);
    }
    return c;
  };
  const rest=run(0),overspeed=run(MAX_BELT_CM_S*1.4);
  assert.equal(rest.outputPercent,100);assert.ok(overspeed.outputPercent<rest.outputPercent);
  assert.ok(overspeed.outputPercent>=0);assert.ok(overspeed.pid.integral>=-100&&overspeed.pid.integral<=100);
});
