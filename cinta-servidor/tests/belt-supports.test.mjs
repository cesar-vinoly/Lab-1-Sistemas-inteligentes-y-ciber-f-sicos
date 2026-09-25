import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {applyBeltMaterials, BELT_TILE_LENGTH} from '../app/belt.ts';
import {createTransmission} from '../app/transmission.ts';
import {applySupportMaterial, inspectSupports, PROTECTED_SUPPORTS} from '../app/support-materials.ts';

async function readGLB(file) {
  const buffer=await readFile(new URL('../public/models/'+file,import.meta.url));
  return {buffer, json:JSON.parse(buffer.subarray(20,20+buffer.readUInt32LE(12)).toString())};
}
async function beltFixture() {
  const {buffer}=await readGLB('correa.glb');
  const gltf=await new GLTFLoader().parseAsync(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength),'');
  const finishes=Object.fromEntries(['abrasive','backing'].map(name=>{
    const map=new THREE.Texture({width:1920,height:1280});
    map.name=name;
    return [name,new THREE.MeshStandardMaterial({map,bumpMap:map.clone()})];
  }));
  const transmission=createTransmission();
  return {root:gltf.scene, finishes, transmission};
}
function snapshot(root) {
  const nodes=[];
  root.traverse(node=>nodes.push({node,parent:node.parent,children:[...node.children],
    transform:[...node.position,...node.quaternion,...node.scale],
    geometry:node.geometry,
    attributes:node.geometry?Object.fromEntries(Object.entries(node.geometry.attributes).map(([name,attribute])=>
      [name,{attribute,array:attribute.array.slice()}])):null,
    index:node.geometry?.index?.array.slice(),
  }));
  return nodes;
}
function assertGeometryUnchanged(nodes) {
  for (const before of nodes) {
    assert.equal(before.node.parent,before.parent);
    assert.deepEqual(before.node.children,before.children);
    assert.deepEqual([...before.node.position,...before.node.quaternion,...before.node.scale],before.transform);
    assert.equal(before.node.geometry,before.geometry);
    if (!before.geometry) continue;
    for (const [key,{attribute,array}] of Object.entries(before.attributes)) {
      assert.equal(before.geometry.attributes[key],attribute);
      assert.deepEqual(attribute.array,array);
    }
    assert.deepEqual(before.geometry.index?.array,before.index);
  }
}
// Mirrored-repeat samplers repeat every two tiles, not every single tile.
const wrappedDistance=(a,b)=>Math.abs((a-b)-2*Math.round((a-b)/2));
function textureUV(mesh, index) {
  const uv=new THREE.Vector2().fromBufferAttribute(mesh.geometry.attributes.uv,index);
  mesh.material.map.updateMatrix();
  return uv.applyMatrix3(mesh.material.map.matrix);
}

test('correa real: 10 caras interiores, 6 exteriores, 2 cantos; ninguna geometría ni UV se modifica',async()=>{
  const {root,finishes,transmission}=await beltFixture();
  const before=snapshot(root);
  const belt=applyBeltMaterials(root,finishes,transmission);
  assert.deepEqual(belt.surfaces.map(face=>face.surface),[
    ...Array(10).fill('inside'),...Array(2).fill('edge'),...Array(6).fill('outside'),
  ]);
  for (const {mesh,surface} of belt.surfaces) {
    if (surface==='edge') {assert.equal(mesh.material.map,null);continue;}
    assert.equal(mesh.material.map.source,(surface==='outside'?finishes.abrasive:finishes.backing).map.source);
    assert.equal(mesh.material.map.repeat.x,mesh.material.bumpMap.repeat.x);
    assert.equal(mesh.material.map.wrapS,THREE.MirroredRepeatWrapping);
    assert.ok(mesh.material.map.offset.equals(mesh.material.bumpMap.offset));
  }
  transmission.setDirection(1,0);transmission.update(130000);
  transmission.setDirection(-1,130000);transmission.update(131000);
  assertGeometryUnchanged(before);
  belt.dispose();
});

test('islas UV nativas: las uniones de ambas superficies conservan continuidad de textura',async()=>{
  const {root,finishes,transmission}=await beltFixture();
  const belt=applyBeltMaterials(root,finishes,transmission);
  for (const time of [0,1500,120100]) {
    if (!time) transmission.setDirection(1,0); else transmission.update(time);
    const joints=new Map(); let compared=0;
    for (const {mesh,surface} of belt.surfaces) {
      if (surface==='edge') continue;
      const positions=mesh.geometry.attributes.position;
      for (let i=0;i<positions.count;i++) {
        const key=surface+':'+[positions.getX(i),positions.getY(i),positions.getZ(i)].map(n=>n.toFixed(7)).join(',');
        const uv=textureUV(mesh,i);
        if (joints.has(key)) {
          const previous=joints.get(key);
          assert.ok(wrappedDistance(uv.x,previous.x)<.00002,'costura longitudinal '+key);
          assert.ok(wrappedDistance(uv.y,previous.y)<.00002,'costura transversal '+key);
          compared++;
        } else joints.set(key,uv);
      }
    }
    assert.ok(compared>=24,'se comprobaron las uniones del modelo real');
  }
});

test('el patrón avanza hacia -Z arriba y +Z abajo con giro positivo del rodillo',async()=>{
  const {root,finishes,transmission}=await beltFixture();
  const belt=applyBeltMaterials(root,finishes,transmission);
  // Independently measured flat primitives from the actual GLB: outer upper,
  // outer return, inner upper and inner return (not dependent on runtime tags).
  for (const [index,expectedSign] of [[12,-1],[15,1],[3,-1],[8,1]]) {
    const mesh=belt.surfaces[index].mesh;
    const p=mesh.geometry.attributes.position;
    let lo=0,hi=0;
    for (let i=1;i<p.count;i++) {if(p.getZ(i)<p.getZ(lo))lo=i;if(p.getZ(i)>p.getZ(hi))hi=i;}
    const slope=(textureUV(mesh,hi).x-textureUV(mesh,lo).x)/(p.getZ(hi)-p.getZ(lo));
    assert.equal(Math.sign(slope),expectedSign);
    assert.ok(Math.abs(Math.abs(slope)-1/BELT_TILE_LENGTH)<.0001,'escala longitudinal física');
  }
});

test('avance sin deslizamiento a distintas FPS, sin salto al envolver la fase de los engranajes',async()=>{
  for (const fps of [15,30,60,144]) {
    const {root,finishes,transmission}=await beltFixture();
    const belt=applyBeltMaterials(root,finishes,transmission);
    const maps=belt.surfaces.filter(face=>face.surface!=='edge').map(face=>face.mesh.material.map);
    const offsets=maps.map(map=>map.offset.x);
    transmission.setDirection(1,0);
    const duration=120.13;
    for(let frame=1;frame/fps<duration;frame++)transmission.update(frame*1000/fps);
    transmission.update(duration*1000);
    // 20 rpm, 19/40 reduction, measured 35 mm diameter of the driving roller.
    const travel=duration*(20*2*Math.PI/60)*(19/40)*(.035/2)/BELT_TILE_LENGTH;
    maps.forEach((map,i)=>assert.ok(wrappedDistance(map.offset.x,offsets[i]-travel)<1e-10));
    belt.dispose();
  }
});

test('parada, inversión entre cuadros, pestaña oculta y limpieza detienen o invierten todas las texturas',async()=>{
  const {root,finishes,transmission}=await beltFixture();
  const belt=applyBeltMaterials(root,finishes,transmission);
  const maps=belt.surfaces.filter(face=>face.surface!=='edge').flatMap(face=>[face.mesh.material.map,face.mesh.material.bumpMap]);
  const initial=maps.map(map=>map.offset.x);
  transmission.setDirection(1,0);transmission.update(500);
  transmission.setDirection(-1,1000);transmission.update(2000);
  maps.forEach((map,i)=>assert.ok(wrappedDistance(map.offset.x,initial[i])<1e-12));
  transmission.setDirection(0,2200); const stopped=maps.map(map=>map.offset.x);
  transmission.update(92000);
  maps.forEach((map,i)=>assert.equal(map.offset.x,stopped[i]));
  transmission.setDirection(1,92000);transmission.resetClock();transmission.update(192000);
  maps.forEach((map,i)=>assert.equal(map.offset.x,stopped[i]));
  belt.dispose();transmission.update(193000);
  maps.forEach((map,i)=>assert.equal(map.offset.x,stopped[i]));
});

async function supportFixture() {
  const {json}=await readGLB('soportes.glb');
  // Read the real compressed GLB's complete node tree, names, mesh assignments
  // and material sharing without requiring a browser/Draco worker for this test.
  // Geometry is a sentinel: the material code must never read or edit it.
  const sharedGeometry=new THREE.BoxGeometry(.01,.02,.03);
  const materials=json.materials.map(definition=>{
    const pbr=definition.pbrMetallicRoughness??{};
    const color=pbr.baseColorFactor??[1,1,1,1];
    return new THREE.MeshStandardMaterial({name:definition.name??'',color:new THREE.Color(...color.slice(0,3)),
      roughness:pbr.roughnessFactor??1,metalness:pbr.metallicFactor??1});
  });
  const nodes=json.nodes.map(definition=>{
    const node=new THREE.Group();node.userData.name=definition.name;
    node.name=THREE.PropertyBinding.sanitizeNodeName(definition.name??'');
    if (definition.matrix) node.applyMatrix4(new THREE.Matrix4().fromArray(definition.matrix));
    if (definition.translation) node.position.fromArray(definition.translation);
    if (definition.rotation) node.quaternion.fromArray(definition.rotation);
    if (definition.scale) node.scale.fromArray(definition.scale);
    if (definition.mesh!==undefined) {
      for (const primitive of json.meshes[definition.mesh].primitives) node.add(new THREE.Mesh(sharedGeometry,materials[primitive.material]));
    }
    return node;
  });
  json.nodes.forEach((definition,i)=>{for (const child of definition.children??[]) nodes[i].add(nodes[child]);});
  const root=new THREE.Group();for(const i of json.scenes[json.scene??0].nodes)root.add(nodes[i]);
  return {root,nodes,json};
}

test('árbol completo del GLB: gris solo fuera de los seis componentes y todos sus descendientes',async()=>{
  const {root,nodes,json}=await supportFixture();
  const before=snapshot(root);
  // Explicit roots independently identified in the GLB before implementation.
  const protectedIndices=[7,19,32,49,87,1454];
  assert.match(json.nodes[87].name,/base con driver y fan:1/);
  const protectedMeshes=[];
  for(const i of protectedIndices)nodes[i].traverse(node=>{if(node.isMesh)protectedMeshes.push(node);});
  const original=protectedMeshes.map(mesh=>({mesh,material:mesh.material,json:mesh.material.toJSON()}));
  const protectedMaterials=new Set(original.map(entry=>entry.material));
  const disposed=new Set();protectedMaterials.forEach(material=>material.addEventListener('dispose',()=>disposed.add(material)));
  // Include sharing of one texture through different materials, as well as
  // sharing of whole materials between structure and protected electronics.
  const sharedTexture=new THREE.Texture();
  const firstProtected=original[0].material;
  firstProtected.map=sharedTexture;original[0].json=firstProtected.toJSON();
  for (const entry of original) if(entry.material===firstProtected) entry.json=firstProtected.toJSON();
  let textureDisposed=false;sharedTexture.addEventListener('dispose',()=>{textureDisposed=true;});
  const structure=inspectSupports(root).structural;
  structure[0].material=new THREE.MeshStandardMaterial({map:sharedTexture});
  const gray=new THREE.MeshStandardMaterial({color:0x555555});
  const inspection=applySupportMaterial(root,gray);
  assert.equal(inspection.found.size,6);
  assert.equal(new Set(inspection.structural.map(mesh=>mesh.parent)).size,12);
  for(const entry of original) {
    assert.equal(entry.mesh.material,entry.material);
    assert.deepEqual(entry.mesh.material.toJSON(),entry.json);
    assert.ok(inspection.protectedNodes.has(entry.mesh));
  }
  assert.equal(disposed.size,0);assert.equal(textureDisposed,false);
  for(const mesh of inspection.structural)assert.equal(mesh.material,gray);
  assertGeometryUnchanged(before);
});

test('se inspeccionan todos los nombres antes de modificar; un nombre ausente deja materiales intactos',async()=>{
  const {root,nodes}=await supportFixture();
  nodes[87].userData.name='ensamble sin nombre';nodes[87].name='ensamble sin nombre';
  const materials=[];root.traverse(node=>{if(node.isMesh)materials.push([node,node.material]);});
  assert.throws(()=>applySupportMaterial(root,new THREE.MeshStandardMaterial()),/base con driver y fan:1/);
  for(const [node,material] of materials)assert.equal(node.material,material);
  assert.equal(PROTECTED_SUPPORTS.length,6);
});
