/**
 * Pruebas automatizadas de relaciones mecánicas, fase, tiempo de renderizado y parada.
 * Los relojes/dispositivos simulados permiten reproducir transiciones sin hardware.
 * Estas verificaciones no sustituyen un ensayo físico de la cinta.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {ROTORS, DRIVE_RPM, createRotor, createTransmission} from '../app/transmission.ts';
import {applyRotorMaterial} from '../app/rotor-materials.ts';

const expectedRatios = {gear1:1,gear2:-1,gear3:19/40,roller1:19/40,roller2:19/40,encoder:19/40};
const loader = new GLTFLoader();
async function readModel(spec) {
  const bytes = await readFile(new URL('../public/models/'+spec.file,import.meta.url));
  return (await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength), '')).scene;
}
function fixture() {
  const transmission=createTransmission();
  const rotors=Object.fromEntries(ROTORS.map(spec=>[spec.id,transmission.add(new THREE.Group(),spec)]));
  return {transmission,rotors};
}
function equalRotation(actual, angle, message) {
  const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),angle);
  assert.ok(1-Math.abs(actual.dot(expected))<1e-12,message);
}

test('cada pieza respeta la relación mecánica solicitada en ambos sentidos',()=>{
  for(const direction of [-1,1]){
    const {transmission,rotors}=fixture();
    transmission.setDirection(direction,0);transmission.update(1000);
    for(const [id,ratio] of Object.entries(expectedRatios)){
      equalRotation(rotors[id].quaternion,direction*DRIVE_RPM*Math.PI*2/60*ratio,id);
    }
  }
});

test('la misma duración da el mismo resultado a 15, 30, 60 y 144 FPS',()=>{
  const duration=9.125;
  for(const fps of [15,30,60,144]){
    const {transmission,rotors}=fixture();
    transmission.setDirection(1,0);
    for(let i=1;i/fps<duration;i++)transmission.update(i*1000/fps);
    transmission.update(duration*1000);
    for(const [id,ratio] of Object.entries(expectedRatios))equalRotation(rotors[id].quaternion,duration*DRIVE_RPM*Math.PI*2/60*ratio,id+' @ '+fps);
  }
});

test('detener congela todas las piezas; invertir conserva la fase y vuelve al inicio',()=>{
  const {transmission,rotors}=fixture();
  transmission.setDirection(1,0);transmission.update(1600);
  transmission.setDirection(0,2000);
  const stopped=Object.fromEntries(Object.entries(rotors).map(([id,rotor])=>[id,rotor.quaternion.clone()]));
  transmission.update(92000);
  for(const [id,rotor] of Object.entries(rotors))assert.ok(rotor.quaternion.equals(stopped[id]));
  transmission.setDirection(-1,92000);
  for(const [id,rotor] of Object.entries(rotors))assert.ok(rotor.quaternion.equals(stopped[id]));
  transmission.update(94000);
  for(const [id,rotor] of Object.entries(rotors))equalRotation(rotor.quaternion,0,id);
});

test('inversión directa contabiliza el tiempo anterior con el sentido anterior',()=>{
  const {transmission,rotors}=fixture();
  transmission.setDirection(1,0);transmission.update(500);
  transmission.setDirection(-1,1000);transmission.update(1500);
  for(const [id,ratio] of Object.entries(expectedRatios))equalRotation(rotors[id].quaternion,.5*DRIVE_RPM*Math.PI*2/60*ratio,id);
});

test('la reducción no salta al completar una vuelta motriz ni al envolver 40 vueltas',()=>{
  for(const seconds of [3.01,120.01,240.01]){
    const {transmission,rotors}=fixture();
    transmission.setDirection(1,0);transmission.update(seconds*1000);
    for(const [id,ratio] of Object.entries(expectedRatios))equalRotation(rotors[id].quaternion,seconds*DRIVE_RPM*Math.PI*2/60*ratio,id);
  }
});

test('pausar el reloj al ocultar la pestaña evita recuperar tiempo oculto de golpe',()=>{
  const {transmission}=fixture();
  transmission.setDirection(1,0);transmission.update(1000);
  const phase=transmission.getState().phase;
  transmission.resetClock();transmission.update(100000);
  assert.equal(transmission.getState().phase,phase);
  transmission.update(101000);
  assert.ok(Math.abs(transmission.getState().phase-2*phase)<1e-12);
});

test('todos los vértices reales conservan su posición inicial y giran sin traslación de eje',async()=>{
  for(const spec of ROTORS){
    const model=await readModel(spec);
    model.updateMatrixWorld(true);
    const nodes=[];const samples=[];
    model.traverse(object=>{
      nodes.push([object,object.matrix.clone()]);
      if(object instanceof THREE.Mesh){
        const position=object.geometry.getAttribute('position');
        for(let i=0;i<position.count;i++)samples.push([object,i,new THREE.Vector3().fromBufferAttribute(position,i).applyMatrix4(object.matrixWorld)]);
      }
    });
    const pivot=createRotor(model,spec);pivot.updateMatrixWorld(true);
    for(const [object,i,before] of samples){
      const after=new THREE.Vector3().fromBufferAttribute(object.geometry.getAttribute('position'),i).applyMatrix4(object.matrixWorld);
      assert.ok(after.distanceTo(before)<1e-12,spec.id+' posición inicial');
    }
    for(const angle of [.713,-1.201]){
      pivot.quaternion.setFromAxisAngle(new THREE.Vector3(1,0,0),angle);pivot.updateMatrixWorld(true);
      for(const [object,i,before] of samples){
        const after=new THREE.Vector3().fromBufferAttribute(object.geometry.getAttribute('position'),i).applyMatrix4(object.matrixWorld);
        const dy=before.y-spec.pivot[1],dz=before.z-spec.pivot[2];
        const expected=new THREE.Vector3(before.x,spec.pivot[1]+dy*Math.cos(angle)-dz*Math.sin(angle),spec.pivot[2]+dy*Math.sin(angle)+dz*Math.cos(angle));
        assert.ok(after.distanceTo(expected)<1e-12,spec.id+' eje mecánico');
        assert.ok(Math.abs(Math.hypot(after.y-spec.pivot[1],after.z-spec.pivot[2])-Math.hypot(dy,dz))<1e-12);
      }
      for(const [object,matrix] of nodes)assert.ok(object.matrix.equals(matrix),spec.id+' transformación original');
    }
  }
});

test('materiales blancos y negros conservan todos los triángulos, vértices y normales',async()=>{
  for(const spec of ROTORS){
    assert.equal(spec.finish,['gear1','gear2'].includes(spec.id)?'white':'black');
    const model=await readModel(spec);
    const before=[];
    model.traverse(object=>{
      if(object instanceof THREE.Mesh)before.push([object,new Uint8Array(object.geometry.attributes.position.array.buffer).slice(),new Uint8Array(object.geometry.attributes.normal.array.buffer).slice(),object.geometry.index.array.slice()]);
    });
    const texture=new THREE.Texture();const material=new THREE.MeshStandardMaterial({map:texture});
    applyRotorMaterial(model,spec,material);
    for(const [object,positions,normals,indices] of before){
      assert.deepEqual(new Uint8Array(object.geometry.attributes.position.array.buffer),positions);
      assert.deepEqual(new Uint8Array(object.geometry.attributes.normal.array.buffer),normals);
      assert.deepEqual(object.geometry.index.array,indices);
      assert.equal(object.material,material);
      assert.ok([...object.geometry.attributes.uv.array].every(Number.isFinite));
    }
    texture.dispose();material.dispose();
  }
});

test('RPM compartidas conservan fases, relaciones y UV al acelerar, invertir y detener',()=>{
  for(const fps of [15,60,144]){
    const {transmission,rotors}=fixture();
    let beltAngle=0;
    transmission.onRotate('roller1',angle=>{beltAngle+=angle;});
    let start=0,expectedAngle=0;
    for(const [direction,driveRpm,duration] of [[1,75,1.1],[1,120,.7],[-1,40,2],[0,40,.5],[1,0,1],[-1,12.5,.3]]){
      transmission.setMotion({direction,driveRpm},start);
      const angleAtChange=beltAngle;
      for(let time=start+1000/fps;time<start+duration*1000;time+=1000/fps)transmission.update(time);
      start+=duration*1000;transmission.update(start);
      expectedAngle+=direction*driveRpm*2*Math.PI/60*duration;
      for(const [id,ratio] of Object.entries(expectedRatios))equalRotation(rotors[id].quaternion,expectedAngle*ratio,id+' @ '+fps);
      assert.ok(Math.abs(beltAngle-expectedAngle*19/40)<1e-10);
      if(direction===0||driveRpm===0)assert.equal(beltAngle,angleAtChange);
      assert.equal(transmission.getState().driveRpm,direction*driveRpm);
    }
  }
});

test('cambiar RPM entre fotogramas respeta el intervalo anterior sin saltar de posición',()=>{
  const {transmission,rotors}=fixture();
  transmission.setMotion({direction:1,driveRpm:60},0);transmission.update(250);
  transmission.setMotion({direction:-1,driveRpm:30},500);transmission.update(750);
  for(const [id,ratio] of Object.entries(expectedRatios))equalRotation(rotors[id].quaternion,2*Math.PI*(.5-.125)*ratio,id);
  transmission.setMotion({direction:1,driveRpm:NaN},750);
  const phase=transmission.getState().phase;transmission.update(1000);
  assert.equal(transmission.getState().phase,phase);
});

test('cero medido congela fase, rotores y UV antes de integrar; descarta frames pendientes e inercia',()=>{
  for(const direction of [-1,1])for(const delay of [16,400,2500])for(const targetRpm of [undefined,0]){
    const {transmission,rotors}=fixture();let beltAngle=0,notifications=0;
    transmission.onRotate('roller1',angle=>{beltAngle+=angle;notifications++;});
    transmission.setMotion({direction,driveRpm:150,targetRpm:direction*150},0);
    transmission.update(100);
    const phase=transmission.getState().phase,belt=beltAngle,count=notifications;
    const poses=Object.fromEntries(Object.entries(rotors).map(([id,rotor])=>[id,rotor.quaternion.clone()]));
    const stoppedAt=100+delay;
    transmission.setMotion({direction:0,driveRpm:0,targetRpm},stoppedAt);
    for(const at of [stoppedAt-1,stoppedAt,stoppedAt+16,stoppedAt+1000,stoppedAt+100000]){
      transmission.update(at);
      assert.equal(transmission.getState().phase,phase);assert.equal(beltAngle,belt);
      assert.equal(notifications,count);assert.equal(transmission.getState().driveRpm,0);
      for(const [id,rotor] of Object.entries(rotors))assert.ok(rotor.quaternion.equals(poses[id]));
    }
    const restartAt=stoppedAt+100100;
    transmission.setMotion({direction,driveRpm:60},restartAt);
    // The next queued RAF is older than the synchronous measurement commit.
    transmission.update(restartAt-1);transmission.update(restartAt+10);
    assert.ok(Math.abs(transmission.getState().phase-phase-direction*.01*2*Math.PI)<1e-12);
  }
});
