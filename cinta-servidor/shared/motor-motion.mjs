/**
 * Seguimiento cinemático del mando: RPM con signo y rampas de aceleración
 * y frenado equivalentes a las configuradas en la ESP32. Este estado permite
 * conciliar órdenes pendientes con la telemetría; no constituye una medición.
 * La animación normal utiliza EncoderMotion, no esta trayectoria como sensor.
 */
import {CONTROL} from './control-protocol.mjs';

// Same motor ramps as the existing ESP-IDF firmware (RPM/s). No sensor data
// is generated here: this trajectory preserves command state and protocol
// compatibility. The 3D viewer uses the independent encoder/native observer.
export const MOTOR_RAMP=Object.freeze({accel:120,decel:300});
/** Exact integral of a ramp, including braking to zero before reversing.
 * @param {number} rpm @param {number} target @param {number} seconds */
/* Integra exactamente hasta tres tramos: frenado, aceleración y régimen.
 * Devuelve RPM final y área RPM·s, útil para convertir a desplazamiento angular. */
export function advanceMotor(rpm,target,seconds){
  if(![rpm,target,seconds].every(Number.isFinite)||seconds<0)throw Error('Trayectoria de motor inválida.');
  let remaining=seconds,area=0;
  // At most three segments: brake, accelerate, constant speed.
  for(let segment=0;remaining>0&&segment<3;segment++){
    const opposite=rpm*target<0;
    const end=opposite?0:target;
    const rate=Math.abs(end)>Math.abs(rpm)?MOTOR_RAMP.accel:MOTOR_RAMP.decel;
    const duration=Math.min(remaining,Math.abs(end-rpm)/rate);
    const next=duration===Math.abs(end-rpm)/rate?end:rpm+Math.sign(end-rpm)*rate*duration;
    area+=(rpm+next)*duration/2;rpm=next;remaining-=duration;
    if(rpm===target){area+=rpm*remaining;remaining=0;}
  }
  return {rpm,rpmSeconds:area};
}

export class MotorMotion {
  rpm=0;targetRpm=0;requestedDirection=0;timeMs=0;commandAt=-Infinity;initialized=false;
  advance(now){
    if(this.initialized)this.rpm=advanceMotor(this.rpm,this.targetRpm,Math.max(0,now-this.timeMs)/1000).rpm;
    this.timeMs=now;this.initialized=true;
  }
  /* Fija una consigna porcentual firmada; immediate representa paro inmediato. */
  target(percent,now,immediate=false,requestedDirection=Math.sign(percent)){
    this.advance(now);this.targetRpm=percent*CONTROL.maxMotorRpm/100;this.commandAt=now;
    this.requestedDirection=requestedDirection;
    if(immediate)this.rpm=0;
  }
  // Reconcile with native motor state, NEVER with the slow encoder sample.
  /* Corrige el estado con RPM_M nativa preservando, cuando corresponde,
   * una orden pendiente que aún no aparece en la telemetría. */
  observe(raw,now,preserveTarget=false){
    this.advance(now);
    const actual=(raw.dir==='FWD'?1:raw.dir==='REV'?-1:0)*raw.rpm_m;
    // A frame queued before a start must not erase the command immediately.
    if(this.targetRpm!==0&&actual===0&&raw.dir==='STOP'&&now-this.commandAt<500)return;
    this.rpm=actual;
    if(!preserveTarget){
      this.requestedDirection=raw.dir==='FWD'?1:raw.dir==='REV'?-1:0;
      this.targetRpm=this.requestedDirection*raw.v*CONTROL.maxMotorRpm/100;
    }
  }
  load(value,now){
    this.rpm=value.rpm;this.targetRpm=value.targetRpm;this.timeMs=value.timeMs;this.initialized=true;
    this.requestedDirection=value.requestedDirection??Math.sign(value.targetRpm);
    this.advance(now);
  }
  snapshot(now){this.advance(now);return {rpm:this.rpm,targetRpm:this.targetRpm,requestedDirection:this.requestedDirection,timeMs:now};}
}
