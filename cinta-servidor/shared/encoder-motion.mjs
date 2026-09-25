import {CONTROL,GEAR_RATIO,validEncoder} from './control-protocol.mjs';

// Visual observer only. RPM_R is a held, roughly one-second measurement;
// RPM_M reports the ramp already executed by the ESP, not a web setpoint.
// Reconcile that average with the motor history over the same window, then
// apply its measured gain to the current native RPM. Never edit telemetry,
// feed this estimate into PID/G(s), or add another animation ramp/filter.
export class EncoderMotion {
  driveRpm=0;
  /** @type {{at:number,rpm:number}[]} */
  history=[];
  /** @type {number|null} */
  encoder=null;
  gain=1;
  /** @type {number|null} */
  startedAt=null;
  startupUntil=0;
  confirmed=false;

  window(at){
    const start=at-CONTROL.encoderSampleMs;
    while(this.history.length>1&&this.history[1].at<=start)this.history.shift();
    if(!this.history.length||this.history[0].at>start)return null;
    let area=0,min=Infinity,max=-Infinity;
    for(let i=1;i<this.history.length;i++){
      const a=this.history[i-1],b=this.history[i];
      if(b.at<=start||b.at===a.at)continue;
      // Do not calibrate across a missing telemetry interval.
      if(b.at-a.at>500)return null;
      const from=Math.max(start,a.at),rpm=a.rpm+(b.rpm-a.rpm)*(from-a.at)/(b.at-a.at);
      area+=(rpm+b.rpm)*(b.at-from)/2;min=Math.min(min,rpm,b.rpm);max=Math.max(max,rpm,b.rpm);
    }
    return {average:area/CONTROL.encoderSampleMs,stable:max-min<0.11};
  }

  /** @param {import('./control-protocol.mjs').Telemetry} raw @param {number} at */
  observe(raw,at){
    const previous=this.history.at(-1);
    if(previous&&at<previous.at)return;
    if(previous&&at-previous.at>CONTROL.staleMs){
      this.history=[];this.encoder=null;this.startedAt=null;this.confirmed=false;this.gain=1;
    }
    const moving=validEncoder(raw)&&raw.dir!=='STOP'&&Number.isFinite(raw.rpm_m)&&raw.rpm_m>0;
    const sample={at,rpm:moving?raw.rpm_m:0};
    if(this.history.at(-1)?.at===at)this.history[this.history.length-1]=sample;
    else this.history.push(sample);
    const window=this.window(at),first=this.encoder===null,changed=this.encoder!==raw.rpm_r;
    this.encoder=raw.rpm_r;
    if(!moving){this.driveRpm=0;this.startedAt=null;this.confirmed=false;return;}
    if(this.startedAt===null){
      this.startedAt=at;
      const nominal=Math.max(raw.rpm_m,raw.v*CONTROL.maxMotorRpm/100)*GEAR_RATIO;
      // At very low speeds, two physical pulses take longer than one second.
      this.startupUntil=at+Math.max(2500,CONTROL.encoderSampleMs+120000/(nominal*CONTROL.encoderPulsesPerRev));
    }
    if(raw.rpm_r>0&&raw.vel_r>0&&(changed||window?.stable))this.confirmed=true;
    const stoppedEncoder=raw.rpm_r===0||raw.vel_r===0;
    // Once measured motion exists, either encoder speed at zero must stop the
    // visual observer immediately, even if native RPM or the other field is
    // still held. Preserve only the existing bounded initial all-zero window
    // so a new physical start does not wait for the slow encoder estimator.
    if(stoppedEncoder&&(this.confirmed||raw.rpm_r>0||raw.vel_r>0||at>=this.startupUntil)){
      this.driveRpm=0;this.startupUntil=at;return;
    }

    const measured=raw.rpm_r/GEAR_RATIO;
    if(raw.rpm_r>0&&(window?.stable&&raw.state!=='RAMP'||first&&raw.state!=='RAMP')){
      // In settled operation, use the encoder exactly, with no smoothing.
      this.gain=measured/raw.rpm_m;this.driveRpm=measured;return;
    }
    if(changed&&raw.rpm_r>0&&window&&window.average>=5&&at-this.startedAt>=CONTROL.encoderSampleMs){
      const gain=measured/window.average;
      // Reject badly matched windows near stop/restart. The settled encoder
      // remains authoritative even if this transient estimate is unavailable.
      if(gain<=2)this.gain=gain;
    }
    this.driveRpm=raw.rpm_m*this.gain;
  }
}
