import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Box3,Group,Vector3} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {createDetectedObject,objectZ,OBJECT_SIZE} from '../app/detected-object.ts';
import {parseTelemetry} from '../shared/control-protocol.mjs';
import {calibrateTelemetry} from '../control/telemetry.mjs';
import {LabState} from '../app/lab-state.ts';
import {ConveyorController} from '../control/pid.mjs';

const close=(a,b,eps=1e-12)=>assert.ok(Math.abs(a-b)<eps,`${a} != ${b}`);
async function fixture(){
  const buffer=await readFile(new URL('../public/models/correa.glb',import.meta.url));
  const gltf=await new GLTFLoader().parseAsync(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength),'');
  const bounds=new Box3().setFromObject(gltf.scene);
  return {root:gltf.scene,bounds,object:createDetectedObject(bounds)};
}

test('cubo: POS calibrada, mapeo CAD original sin segundo offset ni coerción de NA/null',()=>{
  close(objectZ(0),.040974631906);close(objectZ(45),.465974658728);
  close(objectZ(22.5),(.040974631906+.465974658728)/2);
  for(const pos of [0,5,10,20,30,40,41,45]){
    const original=.040974631906+(.465974658728-.040974631906)*pos/45;
    close(objectZ(pos),original);
  }
  const calibrated=calibrateTelemetry({pos:6.3});
  close(objectZ(calibrated.pos),.040974631906+(.465974658728-.040974631906)*10/45);
  for(const pos of [null,undefined,'NA','0','45','',false,NaN,Infinity,-Infinity,-.001,45.001])assert.equal(objectZ(pos),null);
});

test('cubo sobre la correa real: centrado, apoyado y bajo la misma transformación CAD',async()=>{
  const {root,bounds,object}=await fixture();
  const assembly=new Group(),stage=new Group();
  assembly.rotation.z=Math.PI;stage.rotation.y=Math.PI/2;
  stage.position.set(.4,.1,-.3);stage.add(assembly);assembly.add(root);
  const originals=[];
  root.traverse(node=>originals.push({node,parent:node.parent,children:[...node.children],matrix:node.matrix.clone(),geometry:node.geometry,material:node.material}));
  assembly.add(object.mesh);object.setPosition(22.5,0);stage.updateMatrixWorld(true);
  assert.equal(object.mesh.parent,root.parent);
  close(object.mesh.position.x,.11010000109672546);
  close(object.mesh.position.x,(bounds.min.x+bounds.max.x)/2);
  const bandSurface=assembly.localToWorld(new Vector3(object.mesh.position.x,bounds.min.y,object.mesh.position.z));
  const cubeBottom=object.mesh.localToWorld(new Vector3(0,OBJECT_SIZE/2,0));
  close(cubeBottom.x,bandSurface.x);close(cubeBottom.z,bandSurface.z);close(cubeBottom.y-bandSurface.y,.0001);
  assert.ok(OBJECT_SIZE<bounds.max.x-bounds.min.x);
  assert.equal(object.mesh.material.opacity,.3);assert.equal(object.mesh.material.transparent,true);
  assert.equal(object.mesh.material.depthWrite,false);
  for(const before of originals){
    assert.equal(before.node.parent,before.parent);assert.deepEqual(before.node.children,before.children);
    assert.ok(before.node.matrix.equals(before.matrix));assert.equal(before.node.geometry,before.geometry);assert.equal(before.node.material,before.material);
  }
  object.mesh.geometry.dispose();object.mesh.material.dispose();
});

test('cubo: POS real controla la visibilidad con PID activo o apagado, sin alterar datos ni fallas simuladas',async()=>{
  const {object}=await fixture();let now=0;
  const state=new LabState(()=>now),controller=new ConveyorController();
  state.setBridge(true);state.setLink(true,'esp');controller.reset(0);
  for(const active of [false,true]){
    for(const position of [0,45,12.5,'NA',null,undefined,-1,46]){
      now+=250;
      const raw=parseTelemetry({DIR:'STOP',V:50,M:8,RPM_M:0,RPM_R:0,VEL_R:0,DIST:10,STATE:'OK',POS:position});
      assert.ok(raw);controller.observe(raw,now);
      if(active&&!controller.enabled)controller.enable(now);
      state.setController(controller.snapshot());state.setFault('deslizamiento',true);state.ingest(raw,now);
      const snapshot=state.snapshot(),original=structuredClone(raw),lastPid=controller.snapshot();
      object.setPosition(snapshot.fresh?snapshot.raw?.pos:null,now);object.update(now+100);
      assert.equal(object.mesh.visible,[0,45,12.5].includes(position));
      assert.deepEqual(raw,original);assert.deepEqual(state.raw,original);assert.deepEqual(controller.snapshot(),lastPid);
    }
  }
  object.setPosition(20,now);assert.equal(object.mesh.visible,true);
  state.setLink(false,null);object.setPosition(state.snapshot().fresh?state.raw?.pos:null,now+1);
  assert.equal(object.mesh.visible,false);
});

test('cubo: suavizado independiente de FPS, parada visual exacta y sin recrear recursos',async()=>{
  let reference=null;
  for(const fps of [15,60,144]){
    const {object}=await fixture();const {geometry,material}=object.mesh;
    object.setPosition(0,0);object.setPosition(45,100);
    for(let t=100+1000/fps;t<400;t+=1000/fps)object.update(t);
    object.update(400);
    const z=object.mesh.position.z;assert.ok(z>objectZ(0)&&z<objectZ(45));
    reference??=z;close(z,reference);
    for(let t=500;t<=2000;t+=100)object.update(t);
    close(object.mesh.position.z,objectZ(45));assert.equal(object.update(2500),false);
    assert.equal(object.mesh.geometry,geometry);assert.equal(object.mesh.material,material);
    object.setPosition(null,2500);assert.equal(object.mesh.visible,false);
    object.setPosition(10,3000);close(object.mesh.position.z,objectZ(10));
    object.setPosition(30,3000);object.update(3030);const beforeHidden=object.mesh.position.z;
    object.resetClock();object.update(100000);close(object.mesh.position.z,beforeHidden);
    object.update(100010);assert.ok(object.mesh.position.z>beforeHidden&&object.mesh.position.z<objectZ(30));
    assert.equal(object.mesh.geometry,geometry);assert.equal(object.mesh.material,material);
  }
});
