/**
 * Control de aproximación con lazo interno de velocidad y modelo independiente.
 * DIST determina el perfil de frenado; POS valida la presencia del objeto.
 * VEL_R, medida por el encoder, realimenta el PID. La salida es un porcentaje
 * con signo: positivo adelante, negativo reversa y cero parada.
 * G(s) recibe el comando aplicado y produce una predicción en cm/s; nunca
 * sustituye el encoder ni alimenta la animación. Tiempos internos en ms;
 * las ecuaciones de integración convierten explícitamente los intervalos a s.
 */
import {MotorMotion} from '../shared/motor-motion.mjs';
import {EncoderMotion} from '../shared/encoder-motion.mjs';
import {CONTROL,PID_DEFAULTS,PID_BASE_PERCENT,PLANT,ROLLER_CM_PER_REV,MAX_BELT_CM_S,APPROACH,validatePidConfig,validEncoder} from '../shared/control-protocol.mjs';

export const validDistance=value=>Number.isFinite(value)&&value>=2&&value<=400;
// POS=NA is the existing firmware's validity flag: DIST can retain its last
// numeric value after an echo timeout. Such a frame means no detected object;
// it must not trigger position braking from that retained numeric value.
export const validFeedback=raw=>Boolean(raw&&validDistance(raw.dist)&&Number.isFinite(raw.pos)&&raw.pos>=0&&raw.pos<=CONTROL.beltLengthCm);
const clamp=(value,limit)=>Math.max(-limit,Math.min(limit,value));
const emptyModel=()=>({speedCmS:null,signedSpeedCmS:null,rollerRpm:null,positionCm:null,errorCmS:null,errorPercent:null});

// Exact zero-order-hold discretization of the supplied continuous plant.
// x1'=x2; x2'=-8.058*x1-4.286*x2+u; y=.1425*x1+.004656*x2.
/* Modelo continuo en espacio de estados: x1'=x2, x2'=-8.058x1-4.286x2+u.
 * La solución exacta con entrada constante entre muestras evita depender del FPS. */
export class PlantModel {
  x1=0;x2=0;
  reset(){this.x1=0;this.x2=0;}
  get output(){return PLANT.numerator[1]*this.x1+PLANT.numerator[0]*this.x2;}
  /* Propaga el estado de la planta durante dt segundos con retención de orden cero.
   * El resultado conserva el signo; su magnitud se usa en la gráfica. */
  advance(input,dt){
    if(!Number.isFinite(input)||!Number.isFinite(dt)||dt<0)throw Error('Entrada o intervalo de planta inválido.');
    if(!dt)return this.output;
    const a=PLANT.denominator[1]/2,b=PLANT.denominator[2],w=Math.sqrt(b-a*a);
    const decay=Math.exp(-a*dt),cos=Math.cos(w*dt),s=Math.sin(w*dt)/w;
    const equilibrium=input/b,z=this.x1-equilibrium,v=this.x2;
    this.x1=equilibrium+decay*((cos+a*s)*z+s*v);
    this.x2=decay*(-b*s*z+(cos-a*s)*v);
    return this.output;
  }
}

// Inner loop: normalized speed error, output in motor-command percent.
export class VelocityPid {
  integral=0;derivative=0;filtered=null;terms={p:0,i:0,d:0};
  reset(){this.integral=0;this.derivative=0;this.filtered=null;this.terms={p:0,i:0,d:0};}
  /* Calcula PID de velocidad normalizado por MAX_BELT_CM_S.
   * Añade anticipación proporcional a la referencia, deriva la medición filtrada
   * y condiciona la integral a los límites efectivos para impedir windup. */
  update(reference,measured,dt,config,lower,upper,integrate=true){
    if(![reference,measured,dt,lower,upper].every(Number.isFinite)||measured<0||reference<0||dt<=0||upper<lower)throw Error('Realimentación de velocidad o límites PID inválidos.');
    const previous=this.filtered;
    this.filtered=previous===null?measured:previous+(1-Math.exp(-dt/APPROACH.encoderFilterSeconds))*(measured-previous);
    const slope=previous===null?0:-(this.filtered-previous)/dt/MAX_BELT_CM_S;
    const alpha=APPROACH.derivativeFilterSeconds/(APPROACH.derivativeFilterSeconds+dt);
    this.derivative=alpha*this.derivative+(1-alpha)*slope;
    const error=(reference-this.filtered)/MAX_BELT_CM_S;
    const p=config.kp*error,d=config.kd*this.derivative,feedforward=reference/MAX_BELT_CM_S*100;
    const candidate=clamp(this.integral+(integrate?config.ki*error*dt:0),config.maxPercent);
    const sum=feedforward+p+candidate+d;
    // Includes both actuator saturation and the actual slew/profile bounds.
    if(sum>=lower&&sum<=upper||sum>upper&&error<0||sum<lower&&error>0)this.integral=candidate;
    this.terms={p,i:this.integral,d};
    return Math.max(lower,Math.min(upper,feedforward+p+this.integral+d));
  }
}

// State and simulation belong to the Node server, never to the browser timer.
export class ConveyorController {
  config={...PID_DEFAULTS};enabled=false;status='manual';reason='PID desactivado.';
  // Selection belongs to the user; missing feedback can pause the output,
  // but only disable() clears enabled.
  waitFor=null;pausedAt=-Infinity;
  errorCm=null;outputPercent=0;requestedPercent=0;effectiveSampleMs=null;
  latest=null;lastAt=null;modelAt=null;lastTickAt=null;lastControlAt=null;consumedAt=null;
  manualDirection=0;manualPercent=50;plant=new PlantModel();pid=new VelocityPid();lastModel=emptyModel();
  motion=new MotorMotion();trackingCommand=false;speedReferenceCmS=0;speedErrorCmS=null;remainingCm=null;
  feedback=new EncoderMotion();
  speedLimitPercent=100;
  /* Actualiza el límite impuesto por fallas y reinicia memoria del PID al cambiarlo.
   * No libera un frenado por objeto ni modifica la selección enabled. */
  setSpeedLimit(percent){
    const next=Math.max(1,Math.min(100,percent));
    if(next===this.speedLimitPercent)return;
    this.speedLimitPercent=next;this.pid.reset();
    if(!this.braking)this.profileCeiling=Infinity;
  }
  goalLatched=false;braking=false;profileCeiling=Infinity;approachDirection=-1;encoderMissingSince=null;
  clearSince=null;clearAt=null;clearSamples=0;zoneAt=null;
  objectPresent=null;nearestDistance=null;newObject=false;
  resetClear(){this.clearSince=null;this.clearAt=null;this.clearSamples=0;}
  /* Rearma el perfil para una nueva pieza o un despeje confirmado.
   * Conserva el estado físico y la planta; elimina integral y error de la pieza anterior. */
  restartObject(now){
    // Clear only the previous object's control history. Keep the actual held
    // output, plant state, encoder observer, enabled selection and direction.
    this.goalLatched=false;this.braking=false;this.profileCeiling=Infinity;
    this.pid.reset();this.speedErrorCmS=null;this.encoderMissingSince=null;
    this.nearestDistance=null;this.resetClear();this.newObject=true;
    this.lastControlAt=now-this.config.sampleMs;this.consumedAt=null;
  }
  /* Detecta transiciones de presencia y exige muestras separadas para confirmar
   * despeje. Una lectura NA aislada cerca del objetivo no libera la parada. */
  updateObject(now,detected){
    if(this.zoneAt===this.lastAt)return false;
    this.zoneAt=this.lastAt;
    const returned=detected&&this.objectPresent===false;
    if(this.objectPresent!==null&&this.objectPresent!==detected){
      this.pid.reset();this.speedErrorCmS=null;
    }
    this.objectPresent=detected;
    const awayFromGoal=detected&&this.latest.dist>this.config.targetCm+this.config.toleranceCm+Math.max(1,2*this.config.toleranceCm);
    // A new far object after an absent frame immediately gets its own profile,
    // even when cruise stopping distance is longer than the whole conveyor.
    if(returned&&(!(this.braking||this.goalLatched)||awayFromGoal)){
      this.restartObject(now);this.nearestDistance=this.latest.dist;return true;
    }
    const movedAway=awayFromGoal&&this.nearestDistance!==null&&
      this.latest.dist-this.nearestDistance>Math.max(3,2*this.config.toleranceCm);
    if(detected)this.nearestDistance=this.nearestDistance===null?this.latest.dist:Math.min(this.nearestDistance,this.latest.dist);
    const clear=!detected&&this.nearestDistance!==null||(this.goalLatched||this.braking)&&movedAway;
    if(!clear){this.resetClear();return false;}
    // STATUS can repeat the same HC reading. Count at most once per native
    // range period, require elapsed time as well, and reject gaps/replays.
    if(this.clearAt!==null&&this.lastAt-this.clearAt>=CONTROL.staleMs)this.resetClear();
    if(this.clearAt===null||this.lastAt-this.clearAt>=APPROACH.clearSampleMs){
      this.clearSince??=this.lastAt;this.clearAt=this.lastAt;this.clearSamples++;
    }
    if(this.clearSamples<APPROACH.clearSamples||this.lastAt-this.clearSince<APPROACH.clearMs)return false;
    this.restartObject(now);if(detected)this.nearestDistance=this.latest.dist;
    return true;
  }
  /* Avanza G(s) con la salida aplicada durante el intervalo anterior y actualiza
   * el seguimiento del mando. No introduce datos sintéticos en el encoder. */
  advance(now){
    if(this.modelAt!==null)this.plant.advance(this.outputPercent*this.config.inputScale,Math.max(0,now-this.modelAt)/1000);
    this.modelAt=now;this.motion.advance(now);
  }
  /* Reinicia la sesión de telemetría sin desactivar el PID seleccionado.
   * Mantiene las pausas manuales y espera realimentación nueva antes de actuar. */
  reset(now){
    const reason=this.waitFor==='manual'||this.waitFor==='encoder'?this.reason:
      this.enabled?'PID activo; esperando telemetría de la ESP32.':'PID desactivado.';
    this.pause(now,reason,this.waitFor??'telemetry');
    this.latest=null;this.lastAt=null;this.lastTickAt=null;this.modelAt=now;
    this.motion=new MotorMotion();this.motion.target(0,now,true);this.motion.commandAt=-Infinity;this.trackingCommand=false;
    this.feedback=new EncoderMotion();
    this.plant.reset();this.lastModel=emptyModel();this.manualDirection=0;this.manualPercent=50;this.errorCm=null;this.remainingCm=null;
  }
  /* Valida parámetros únicamente con el PID desactivado. Si cambian unidades
   * de entrada/salida, reinicia G(s) para no mezclar estados de escalas diferentes. */
  configure(input,now){
    if(this.enabled)throw Error('Desactivá el PID antes de cambiar su configuración.');
    const next=validatePidConfig(input,this.config);this.advance(now);
    if(next.inputScale!==this.config.inputScale||next.outputScale!==this.config.outputScale){this.plant.reset();this.lastModel=emptyModel();}
    this.config=next;this.pid.reset();
    this.errorCm=validFeedback(this.latest)?next.targetCm-this.latest.dist:null;
    this.remainingCm=validFeedback(this.latest)?this.latest.dist-next.targetCm:null;
  }
  /* Incorpora la muestra física, actualiza presencia y observador visual,
   * y obtiene un punto de G(s) emparejado con el mismo instante. */
  observe(raw,now){
    this.advance(now);this.latest={...raw};this.lastAt=now;
    this.feedback.observe(raw,now);
    this.errorCm=validFeedback(raw)?this.config.targetCm-raw.dist:null;
    this.remainingCm=validFeedback(raw)?raw.dist-this.config.targetCm:null;
    const recent=now-this.motion.commandAt<500;
    this.motion.observe(raw,now,this.enabled||this.status==='fault'||recent||this.trackingCommand&&raw.state==='RAMP');
    if(!this.enabled&&this.status!=='fault'&&!recent&&(raw.state!=='RAMP'||!this.trackingCommand)){
      this.trackingCommand=false;
      this.manualDirection=raw.dir==='FWD'?1:raw.dir==='REV'?-1:0;
      this.manualPercent=raw.v;this.outputPercent=this.manualDirection*raw.v;
    }
    // One model sample per real sample, at exactly the same server timestamp.
    this.lastModel=this.modelSample();
  }
  /* Exige encoder válido y telemetría reciente; una velocidad cero es válida.
   * La ausencia de objeto no impide activar el control. */
  enable(now){
    if(!validEncoder(this.latest)||this.lastAt===null||now-this.lastAt>CONTROL.staleMs)throw Error('El PID requiere telemetría reciente y realimentación válida del encoder.');
    this.enabled=true;
    this.resume(now,this.config.forwardIncreasesDistance?-1:1,true);
  }
  /* Libera la pausa y reinicia el perfil de aproximación en el sentido indicado. */
  resume(now,direction=this.approachDirection,initial=false){
    this.waitFor=null;this.status='running';this.reason='PID activo; aproximación con realimentación del encoder.';
    this.goalLatched=false;this.braking=false;this.profileCeiling=Infinity;this.encoderMissingSince=null;
    this.resetClear();this.zoneAt=null;this.objectPresent=null;this.nearestDistance=null;this.newObject=false;
    this.approachDirection=direction;
    this.pid.reset();this.lastControlAt=initial?null:now-this.config.sampleMs;this.consumedAt=null;this.lastTickAt=now;
  }
  /* Retiene la selección PID y pone la salida a cero. waitFor identifica si
   * la recuperación necesita acción manual, encoder o nueva telemetría. */
  pause(now,reason,waitFor='telemetry'){
    this.advance(now);this.waitFor=this.enabled?waitFor:null;this.pausedAt=now;
    this.status=this.enabled?(waitFor==='manual'?'paused':waitFor==='encoder'?'fault':'waiting'):'manual';this.reason=reason;
    this.outputPercent=0;this.requestedPercent=0;this.manualDirection=0;this.pid.reset();
    this.motion.target(0,now);this.speedReferenceCmS=0;this.speedErrorCmS=null;
    this.resetClear();this.zoneAt=null;
    this.lastControlAt=null;this.consumedAt=null;this.effectiveSampleMs=null;
  }
  /* Único punto de desactivación explícita del PID por decisión del usuario. */
  disable(now){
    this.enabled=false;this.pause(now,'PID desactivado por el usuario.');
  }
  /* Integra el mando manual: con PID activo, S/E pausan y F/R reanudan;
   * sin PID actualiza dirección y porcentaje de la trayectoria del motor. */
  manual(command,now){
    if(this.enabled){
      if(['S','E','V0'].includes(command)){
        this.pause(now,'PID activo; cinta detenida por el usuario. Adelante/Reversa reanudan el movimiento.','manual');
        this.motion.target(0,now,command==='E');
      }else if(command==='F'||command==='R')this.resume(now,command==='F'?1:-1);
      else if(command.startsWith('V'))this.manualPercent=Number(command.slice(1));
      return;
    }
    this.advance(now);this.status='manual';this.reason='Mando manual.';
    if(command==='F')this.manualDirection=1;
    if(command==='R')this.manualDirection=-1;
    if(command==='S'||command==='E')this.manualDirection=0;
    if(command.startsWith('V')){this.manualPercent=Number(command.slice(1));if(!this.manualPercent)this.manualDirection=0;}
    this.outputPercent=this.manualDirection*this.manualPercent;
    this.motion.target(this.outputPercent,now,command==='E',this.manualDirection);this.trackingCommand=true;
  }
  /* Registra el porcentaje con signo aplicado al actuador; será la entrada
   * de G(s) durante el siguiente intervalo temporal. */
  applied(output,now){
    this.advance(now);
    if(output!==this.outputPercent||this.motion.targetRpm!==output*CONTROL.maxMotorRpm/100)this.motion.target(output,now);
    this.outputPercent=output;if(output!==0)this.manualPercent=Math.abs(output);this.trackingCommand=true;
  }
  /* Ejecuta el ciclo condicionado por muestreo, frescura y ACK pendientes.
   * La parada por setpoint tiene prioridad; luego calcula perfil de distancia
   * y PID de velocidad dentro del límite de falla y la rampa de salida. */
  tick(now,canSend=true){
    this.advance(now);
    let gap=this.lastTickAt===null?0:now-this.lastTickAt;this.lastTickAt=now;
    if(!this.enabled)return null;
    if(this.waitFor){
      if(this.waitFor==='manual'||!canSend||this.lastAt===null||this.lastAt<=this.pausedAt||
        now-this.lastAt>CONTROL.staleMs||!validEncoder(this.latest)||
        this.waitFor==='encoder'&&this.latest.vel_r<=0.01)return null;
      this.resume(now);gap=0;
    }
    if(gap>Math.max(1000,3*this.config.sampleMs))return {fault:'PID activo; salida en espera por interrupción del ciclo.'};
    if(this.lastAt===null||now-this.lastAt>CONTROL.staleMs)return {fault:'PID activo; salida en espera por telemetría vencida.'};
    // A goal crossing preempts an outstanding ACK; do not keep driving for
    // the full command timeout when a valid range sample already says stop.
    if(!validEncoder(this.latest))return {fault:'PID activo; salida en espera por velocidad del encoder inválida.'};
    const objectDetected=validFeedback(this.latest);
    const cruisePercent=Math.min(PID_BASE_PERCENT,this.speedLimitPercent);
    const cruiseSpeed=cruisePercent/100*MAX_BELT_CM_S;
    this.updateObject(now,objectDetected);
    if(this.goalLatched)return null;
    if(objectDetected&&this.latest.dist-this.config.targetCm<=this.config.toleranceCm){
      this.goalLatched=true;this.pid.reset();this.requestedPercent=0;this.speedReferenceCmS=0;
      this.resetClear();
      this.speedErrorCmS=-this.latest.vel_r;this.status='target';
      this.reason='Objetivo alcanzado. Rearranque automático al confirmar la zona despejada.';
      return {output:0};
    }
    if(!canSend||this.consumedAt===this.lastAt||this.lastControlAt!==null&&now-this.lastControlAt<this.config.sampleMs)return null;
    const first=this.lastControlAt===null,fresh=first||this.newObject;
    const dt=this.lastControlAt===null?this.config.sampleMs/1000:(now-this.lastControlAt)/1000;
    const raw=this.latest,config=this.config;
    this.remainingCm=objectDetected?raw.dist-config.targetCm:null;
    this.speedErrorCmS=this.speedReferenceCmS-raw.vel_r;
    this.effectiveSampleMs=dt*1000;this.lastControlAt=now;this.consumedAt=this.lastAt;
    /* Perfil de frenado: limita v para que v·T + v²/(2·a) no exceda
     * la distancia libre. Incluye tiempo de respuesta y velocidad física actual. */
    if(objectDetected){
      const responseSeconds=Math.max(config.sampleMs/1000,dt)+APPROACH.telemetrySeconds;
      const decel=APPROACH.decelCmS2,free=Math.max(0,this.remainingCm-config.toleranceCm/2);
      // v*T + v²/(2*a) <= remaining distance. Include actual encoder speed in
      // the braking decision, including overspeed relative to the command.
      const actualSpeed=Math.max(raw.vel_r,raw.rpm_m/CONTROL.maxMotorRpm*MAX_BELT_CM_S);
      const stoppingDistance=actualSpeed*responseSeconds+actualSpeed*actualSpeed/(2*decel);
      const envelope=Math.sqrt((decel*responseSeconds)**2+2*decel*free)-decel*responseSeconds;
      this.braking ||= envelope<cruiseSpeed||stoppingDistance>=free;
      this.profileCeiling=Math.min(this.profileCeiling,cruiseSpeed,envelope);
    }else if(!this.braking){
      // Cruise still closes the same speed PID through the physical encoder.
      // A confirmed clear/new object gets a fresh command. The ESP's existing
      // physical ramp remains authoritative; no second slow ramp is added.
      this.braking=false;this.profileCeiling=cruiseSpeed;
    }
    this.speedReferenceCmS=Math.min(this.profileCeiling,cruiseSpeed);
    this.speedErrorCmS=this.speedReferenceCmS-raw.vel_r;
    const previous=Math.abs(this.outputPercent);
    const profilePercent=Math.min(config.maxPercent,this.profileCeiling/MAX_BELT_CM_S*100);
    // Native encoder updates every second. During startup/ramp don't integrate
    // its held zero sample into an increasingly large command.
    if(raw.rpm_m>20&&raw.vel_r<0.01)this.encoderMissingSince??=now;else this.encoderMissingSince=null;
    if(this.encoderMissingSince!==null&&now-this.encoderMissingSince>2500)return {fault:'PID activo; sin giro medido por el encoder. Esperando realimentación o un mando de arranque.',waitFor:'encoder'};
    const upper=Math.max(1,Math.min(config.maxPercent,cruisePercent,
      this.braking?Math.min(profilePercent,fresh?cruisePercent:previous):cruisePercent,
      fresh?cruisePercent:previous+APPROACH.slewPercentS*dt));
    // A 1% final crawl avoids stopping short of the goal; the goal latch
    // commands zero. Automatic cruise and the physical ceiling are always 100%.
    const floor=Math.min(upper,1);
    const lower=Math.min(upper,Math.max(floor,fresh?0:previous-APPROACH.slewPercentS*dt));
    const calculated=this.pid.update(this.speedReferenceCmS,raw.vel_r,dt,config,lower,upper,raw.state!=='RAMP'&&raw.vel_r>0.01);
    const percent=first?Math.min(cruisePercent,upper):calculated;
    this.newObject=false;
    this.requestedPercent=this.approachDirection*Math.max(1,Math.floor(percent+1e-9));
    this.status=this.braking?'braking':'running';
    this.reason=this.braking?'Reduciendo velocidad según distancia y encoder.':`Crucero al ${cruisePercent} % con realimentación del encoder.${cruisePercent<100?' Limitado por simulación de falla.':''}`;
    return {output:this.requestedPercent};
  }
  /* Convierte la salida identificada de G(s) de RPM a cm/s y calcula
   * error encoder menos modelo, sin sustituir ninguna curva. */
  modelSample(){
    const signedSpeedCmS=this.plant.output*this.config.outputScale,speedCmS=Math.abs(signedSpeedCmS);
    const errorCmS=this.latest?this.latest.vel_r-speedCmS:null;
    return {speedCmS,signedSpeedCmS,rollerRpm:speedCmS/ROLLER_CM_PER_REV*60,positionCm:null,errorCmS,
      errorPercent:errorCmS===null||speedCmS<0.01?null:Math.abs(errorCmS)/speedCmS*100};
  }
  /* Estado serializable para todos los clientes: selección, salida, referencias,
   * términos PID, modelo y realimentación visual. */
  snapshot(){return {enabled:this.enabled,status:this.status,reason:this.reason,config:{...this.config},errorCm:this.errorCm,
    outputPercent:this.outputPercent,requestedPercent:this.requestedPercent,commandPercent:this.manualPercent,effectiveSampleMs:this.effectiveSampleMs,
    terms:{...this.pid.terms},model:{...this.lastModel},
    speedReferenceCmS:this.speedReferenceCmS,speedErrorCmS:this.speedErrorCmS,remainingCm:this.remainingCm,
    feedback:{driveRpm:this.feedback.driveRpm},motion:this.motion.snapshot(this.modelAt??0)};}
}
