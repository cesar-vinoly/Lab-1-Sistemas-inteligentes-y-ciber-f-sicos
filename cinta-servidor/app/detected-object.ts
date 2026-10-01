/**
 * Objeto detectado: cubo semitransparente de 3,5 cm en coordenadas CAD.
 * Mapea POS de 0 a 45 cm sobre el tramo longitudinal de la banda.
 * Los datos inválidos ocultan el cubo. El filtro exponencial solo suaviza
 * la representación; no cambia POS, DIST, PID ni las mediciones registradas.
 */
import {BoxGeometry,Mesh,MeshStandardMaterial} from 'three';
import type {Box3} from 'three';
import {BELT_PROFILE} from './belt.ts';
import {CONTROL} from '../shared/control-protocol.mjs';

export const OBJECT_SIZE=.035;
// POS arrives calibrated by the server. Do not add a second visual offset:
// the cube, position chart and measurement panel share this physical reference.
const VISUAL_TAU=.12;

// Strict validation: null/NA/missing values must never coerce to POS=0.
/* Convierte una posición válida en cm a la coordenada Z del CAD en metros. */
export function objectZ(pos:unknown):number|null{
  if(typeof pos!=='number'||!Number.isFinite(pos)||pos<0||pos>CONTROL.beltLengthCm)return null;
  const z=BELT_PROFILE.startZ+(BELT_PROFILE.endZ-BELT_PROFILE.startZ)*pos/CONTROL.beltLengthCm;
  return Math.max(BELT_PROFILE.startZ,Math.min(BELT_PROFILE.endZ,z));
}

// Bounds are read BEFORE the common stage/CAD transforms. Negative CAD Y
// points up; the cube's lower face rests on the upper run of the real belt.
// One mesh/material per viewer. Only position and visibility change at runtime.
/* Crea una única geometría y material; solo posición y visibilidad
 * cambian con las muestras y con el reloj de animación. */
export function createDetectedObject(beltBounds:Box3){
  const geometry=new BoxGeometry(OBJECT_SIZE,OBJECT_SIZE,OBJECT_SIZE);
  const material=new MeshStandardMaterial({color:0x38bdf8,opacity:.3,transparent:true,
    depthWrite:false,roughness:.4,metalness:0});
  const mesh=new Mesh(geometry,material);
  mesh.name='Objeto detectado · POS';mesh.visible=false;
  mesh.position.set((beltBounds.min.x+beltBounds.max.x)/2,beltBounds.min.y-OBJECT_SIZE/2-.0001,BELT_PROFILE.startZ);
  let targetZ=mesh.position.z,lastTime:number|null=null;
  const update=(timeMs:number)=>{
    const dt=lastTime===null?0:Math.max(0,(timeMs-lastTime)/1000);lastTime=timeMs;
    if(!mesh.visible||!dt||mesh.position.z===targetZ)return false;
    const next=targetZ+(mesh.position.z-targetZ)*Math.exp(-dt/VISUAL_TAU);
    mesh.position.z=Math.abs(next-targetZ)<1e-7?targetZ:next;
    return true;
  };
  return {mesh,update,
    setPosition(pos:unknown,timeMs:number){
      update(timeMs);
      const next=objectZ(pos);
      if(next===null){mesh.visible=false;lastTime=null;return;}
      targetZ=next;
      if(!mesh.visible)mesh.position.z=targetZ;
      mesh.visible=true;lastTime=timeMs;
    },
    resetClock(){lastTime=null;},
  };
}
