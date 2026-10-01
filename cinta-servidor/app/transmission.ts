/**
 * Cinemática del ensamble: engranajes 19/19/40 y rodillos solidarios.
 * La fase del motriz se integra con deltaTime y se multiplica por cada relación.
 * Los pivotes están en coordenadas CAD originales (metros); los grupos
 * compensadores mantienen la posición importada al iniciar la animación.
 * El giro del rodillo 1 notifica a la correa para desplazar sus texturas.
 */
import {advanceMotor} from '../shared/motor-motion.mjs';
import {GEAR_RATIO} from '../shared/control-protocol.mjs';
import {Group, Vector3} from 'three';
import type {Object3D} from 'three';

export type Direction = -1 | 0 | 1;
export type Motion = {direction:Direction; driveRpm:number; targetRpm?:number; sampledAt?:number};
export type RotorId = 'gear1' | 'gear2' | 'gear3' | 'roller1' | 'roller2' | 'encoder';
export type RotorSpec = {
  id: RotorId;
  file: string;
  finish: 'white' | 'black';
  pivot: readonly [number, number, number];
  ratio: number;
};

export const DRIVE_RPM = 20;
export const OUTPUT_RATIO = GEAR_RATIO;
// Reset phase only after 40 input turns (= 19 output turns), never after one
// input turn: wrapping at 2 PI would make the reduced output jump backwards.
const PHASE_PERIOD = 40 * 2 * Math.PI;
const AXIS = new Vector3(1, 0, 0);

// CAD coordinates, in metres, BEFORE the existing common stage rotation.
// Axes measured from circular bores/cylindrical surfaces, not bounding-box
// centres (odd tooth counts and the keyed bore have asymmetric bounds).
// Gear 3 shares the measured axis of roller 1 and the encoder disc.
// X can be any point along each shaft; zero defines the same mechanical line.
export const ROTORS: readonly RotorSpec[] = [
  {id:'gear1', file:'Engranaje_1.glb', finish:'white', pivot:[0,-0.05925,0.04], ratio:1},
  {id:'gear2', file:'Engranaje_2.glb', finish:'white', pivot:[0,-0.07825,0.04], ratio:-1},
  {id:'gear3', file:'Engranaje_3.glb', finish:'black', pivot:[0,-0.10835,0.04], ratio:OUTPUT_RATIO},
  {id:'roller1', file:'Rodillo_1.glb', finish:'black', pivot:[0,-0.10835,0.04], ratio:OUTPUT_RATIO},
  {id:'roller2', file:'Rodillo_2.glb', finish:'black', pivot:[0,-0.10835,0.465], ratio:OUTPUT_RATIO},
  {id:'encoder', file:'encoder.glb', finish:'black', pivot:[0,-0.10835,0.04], ratio:OUTPUT_RATIO},
];

/* Encapsula la pieza con T(p)·R·T(-p), de modo que la rotación se realiza
 * alrededor del eje mecánico sin cambiar su posición inicial CAD. */
export function createRotor(model: Object3D, spec: RotorSpec): Group {
  const pivot = new Group();
  pivot.name = `Eje_${spec.id}`;
  pivot.position.fromArray(spec.pivot);
  const compensate = new Group();
  compensate.name = `Coordenadas_CAD_${spec.id}`;
  compensate.position.copy(pivot.position).negate();
  compensate.add(model);
  pivot.add(compensate);
  // T(p) * R(0) * T(-p) = identity. The imported nodes, vertices and original
  // phase remain untouched. During rotation only this outer pivot changes.
  return pivot;
}

/* Conserva una fase motriz común; las relaciones firmadas garantizan
 * sincronismo entre todos los engranajes, rodillos y encoder. */
export function createTransmission() {
  let direction: Direction = 0;
  let driveRpm = DRIVE_RPM;
  let phase = 0;
  let targetRpm: number | null = null;
  let previousTime: number | null = null;
  const rotors: {pivot: Group; spec: RotorSpec}[] = [];
  const listeners = new Set<{ratio:number; callback:(deltaAngle:number)=>void}>();
  const apply = () => {
    for (const {pivot, spec} of rotors) {
      pivot.quaternion.setFromAxisAngle(AXIS, phase * spec.ratio);
    }
  };
  /* Integra velocidad angular desde RPM: dtheta = RPM·2π·dt/60.
   * Descarta tiempos antiguos y distribuye el incremento a la correa. */
  const update = (timeMs: number): boolean => {
    // A queued RAF can carry a timestamp older than the latest telemetry
    // commit. Never rewind the animation clock or replay that interval.
    if(!Number.isFinite(timeMs)||previousTime!==null&&timeMs<=previousTime)return false;
    const deltaTime = previousTime === null ? 0 : Math.max(0, (timeMs - previousTime) / 1000);
    previousTime = timeMs;
    if (deltaTime === 0) return false;
    let rpmSeconds = direction * driveRpm * deltaTime;
    if (targetRpm !== null) {
      const next=advanceMotor(direction*driveRpm,targetRpm,deltaTime);
      direction=Math.sign(next.rpm) as Direction;driveRpm=Math.abs(next.rpm);rpmSeconds=next.rpmSeconds;
    }
    if (rpmSeconds === 0) return false;
    const deltaAngle = rpmSeconds * 2 * Math.PI / 60;
    phase = (phase + deltaAngle) % PHASE_PERIOD;
    apply();
    // Send the actual increment, before wrapping the displayed phase. A belt
    // texture must not jump when the gears complete their 40-turn cycle.
    for (const listener of listeners) listener.callback(deltaAngle * listener.ratio);
    return true;
  };
  return {
    add(model: Object3D, spec: RotorSpec) {
      const pivot = createRotor(model, spec);
      rotors.push({pivot, spec});
      apply();
      return pivot;
    },
    update,
    onRotate(id: RotorId, callback: (deltaAngle:number)=>void) {
      const spec = ROTORS.find(rotor=>rotor.id===id)!;
      const listener = {ratio:spec.ratio, callback};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setDirection(next: Direction, timeMs: number) {
      // Account for the interval before this click using the OLD direction.
      update(timeMs);
      direction = next;targetRpm=null;
    },
    setMotion(next: Motion, timeMs: number) {
      const nextRpm=Number.isFinite(next.driveRpm)?Math.max(0,next.driveRpm):0;
      const nextTarget=Number.isFinite(next.targetRpm)?next.targetRpm!:null;
      if((nextTarget===null||nextTarget===0)&&(!next.direction||nextRpm===0)){
        // Measured stop: freeze the last displayed phase BEFORE integrating
        // anything. Advancing the old RPM here caused an extra turn when a
        // stop arrived between delayed frames. Cancel any previous trajectory
        // and rebase the clock so queued frames cannot move gears or belt UVs.
        direction=0;driveRpm=0;targetRpm=null;
        previousTime=Math.max(previousTime??timeMs,timeMs);
        return;
      }
      // Finish the previous interval before changing speed or direction.
      // The same rotation increments still drive every rotor and the belt UVs.
      update(timeMs);
      direction = next.direction;
      driveRpm = nextRpm;
      targetRpm=nextTarget;
      if(targetRpm!==null&&next.sampledAt!==undefined){
        const current=advanceMotor(direction*driveRpm,targetRpm,Math.max(0,timeMs-next.sampledAt)/1000);
        direction=Math.sign(current.rpm) as Direction;driveRpm=Math.abs(current.rpm);
      }
    },
    resetClock() { previousTime = null; },
    getState() { return {direction, phase, driveRpm: direction * driveRpm}; },
  };
}

export type Transmission = ReturnType<typeof createTransmission>;
