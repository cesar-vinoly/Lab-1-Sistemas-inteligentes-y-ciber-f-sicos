import * as THREE from 'three';
import type {RotorSpec} from './transmission';

const TILE_METRES = 0.025;

export async function loadConveyorMaterials(anisotropy: number) {
  const loader = new THREE.TextureLoader();
  const files = ['blanco.jpg', 'negro.jpg', 'lija.jpg', 'base_lija.jpg', 'gris.jpg'];
  const results = await Promise.allSettled(files.map(file=>loader.loadAsync('/textures/'+file)));
  if (results.some(result => result.status === 'rejected')) {
    for (const result of results) if (result.status === 'fulfilled') result.value.dispose();
    throw new Error('No se pudieron cargar todas las texturas de la cinta.');
  }
  const textures = results.map(result => (result as PromiseFulfilledResult<THREE.Texture>).value);
  const materials = textures.map(map => {
    map.colorSpace = THREE.SRGBColorSpace;
    map.flipY = false;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.anisotropy = anisotropy;
    const bump = map.clone();
    bump.colorSpace = THREE.NoColorSpace;
    bump.needsUpdate = true;
    return new THREE.MeshStandardMaterial({
      color: 0xffffff, map, bumpMap: bump, bumpScale: 0.000025,
      metalness: 0, roughness: 0.88, side: THREE.DoubleSide,
    });
  });
  materials[2].roughness = .96;
  materials[3].roughness = .93;
  materials[4].roughness = .82;
  materials[4].bumpScale = .00001;
  return {
    white: materials[0], black: materials[1],
    abrasive: materials[2], backing: materials[3], gray: materials[4],
    all: materials,
    dispose() {
      for (const material of materials) {
        material.map?.dispose(); material.bumpMap?.dispose(); material.dispose();
      }
    },
  };
}

export type ConveyorMaterials = Awaited<ReturnType<typeof loadConveyorMaterials>>;

export function applyRotorMaterial(root: THREE.Object3D, spec: RotorSpec, material: THREE.MeshStandardMaterial) {
  root.updateMatrixWorld(true);
  const sample = new THREE.Vector3();
  let radius = 0;
  root.traverse(object=>{
    if(!(object instanceof THREE.Mesh))return;
    const positions=object.geometry.getAttribute('position');
    for(let i=0;i<positions.count;i++){
      sample.fromBufferAttribute(positions,i).applyMatrix4(object.matrixWorld);
      radius=Math.max(radius,Math.hypot(sample.y-spec.pivot[1],sample.z-spec.pivot[2]));
    }
  });
  const aroundRepeats=Math.max(1,Math.round(2*Math.PI*radius/TILE_METRES));
  const oldMaterials = new Set<THREE.Material>();
  const oldTextures = new Set<THREE.Texture>();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const old of Array.isArray(object.material) ? object.material : [object.material]) {
      oldMaterials.add(old);
      for (const value of Object.values(old)) if (value instanceof THREE.Texture) oldTextures.add(value);
    }
    object.material = material;
    const geometry = object.geometry as THREE.BufferGeometry;
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    const uv = new Float32Array(positions.count * 2);
    const point = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(object.matrixWorld);
    // Cylinder projection for shaft-aligned sides; planar projection for caps.
    // A per-face angular branch prevents a stretched triangle across the seam.
    // Integer repeats around the circumference make adjacent branches agree.
    let sumSin=0,sumCos=0;
    for(let i=0;i<positions.count;i++){
      point.fromBufferAttribute(positions,i).applyMatrix4(object.matrixWorld);
      const angle=Math.atan2(point.y-spec.pivot[1],point.z-spec.pivot[2]);
      sumSin+=Math.sin(angle);sumCos+=Math.cos(angle);
    }
    const angleReference=Math.atan2(sumSin,sumCos);
    // Only UVs change; vertices, indices, normals and tooth profiles stay intact.
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld);
      point.y -= spec.pivot[1]; point.z -= spec.pivot[2];
      normal.fromBufferAttribute(normals, i).applyNormalMatrix(normalMatrix);
      if(Math.abs(normal.x)>.5){
        uv[i*2]=point.z/TILE_METRES;uv[i*2+1]=point.y/TILE_METRES;
      }else{
        let angle=Math.atan2(point.y,point.z);
        if(angle-angleReference>Math.PI)angle-=2*Math.PI;
        if(angle-angleReference< -Math.PI)angle+=2*Math.PI;
        uv[i*2]=point.x/TILE_METRES;uv[i*2+1]=angle*aroundRepeats/(2*Math.PI);
      }
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  });
  oldMaterials.forEach(old => old.dispose());
  oldTextures.forEach(old => old.dispose());
}
