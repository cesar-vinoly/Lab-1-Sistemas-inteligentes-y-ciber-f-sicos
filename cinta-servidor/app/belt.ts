import {MathUtils, Matrix3, Mesh, MeshStandardMaterial, MirroredRepeatWrapping, Vector3} from 'three';
import type {Material, Object3D, Texture} from 'three';
import type {Transmission} from './transmission';
import {disposeUnreferencedMaterials} from './support-materials.ts';

// Measurements in the original CAD frame, in metres. These values parameterize
// texture coordinates only: no vertices or imported transforms are changed.
export const BELT_PROFILE = {
  centerY: -0.108138971031,
  startZ: 0.040974631906,
  endZ: 0.465974658728,
  neutralRadius: 0.01915000379,
  width: 0.15000000596,
} as const;
export const ROLLER_1_RADIUS = 0.0175; // Cylindrical contact surface in Rodillo_1.glb.
const STRAIGHT = BELT_PROFILE.endZ - BELT_PROFILE.startZ;
export const BELT_LENGTH = 2 * STRAIGHT + 2 * Math.PI * BELT_PROFILE.neutralRadius;
// The supplied photos are not seamless. Mirrored pairs remove hard tile edges;
// an even number of tiles also closes the loop without an image discontinuity.
export const BELT_TILE_LENGTH = BELT_LENGTH / (2 * Math.max(1, Math.round(BELT_LENGTH / .05 / 2)));
export type BeltSurface = 'outside' | 'inside' | 'edge';

// Positive s follows positive rotation about the roller's CAD +X axis:
// upper run towards smaller Z, lower run towards larger Z.
export function beltDistance(point: Vector3): number {
  const {centerY, startZ, endZ, neutralRadius:r} = BELT_PROFILE;
  if (point.z >= startZ && point.z <= endZ) {
    return point.y >= centerY ? Math.PI*r + point.z-startZ : BELT_LENGTH-(point.z-startZ);
  }
  const left = point.z < startZ;
  const angle = MathUtils.euclideanModulo(Math.atan2(-(point.z-(left?startZ:endZ)), -(point.y-centerY)), 2*Math.PI);
  return left ? r*angle : Math.PI*r + STRAIGHT + r*(angle-Math.PI);
}

function inspectSurface(mesh: Mesh) {
  const positions = mesh.geometry.getAttribute('position');
  const normals = mesh.geometry.getAttribute('normal');
  const uv = mesh.geometry.getAttribute('uv');
  if (!positions || !normals || !uv) throw new Error('La correa necesita posiciones, normales y UV originales.');
  const point = new Vector3(), normal = new Vector3();
  const normalMatrix = new Matrix3().getNormalMatrix(mesh.matrixWorld);
  const kinds = new Set<BeltSurface>();
  let uMin=Infinity, uMax=-Infinity;
  const start = new Vector3(), end = new Vector3(), mean = new Vector3();
  for (let i=0; i<positions.count; i++) {
    point.fromBufferAttribute(positions,i).applyMatrix4(mesh.matrixWorld);
    normal.fromBufferAttribute(normals,i).applyNormalMatrix(normalMatrix);
    // Outward from the loop, not "world up": the abrasive also covers the
    // underside of the return run; backing always faces the rollers.
    const radialY = point.y-BELT_PROFILE.centerY;
    const radialZ = point.z-MathUtils.clamp(point.z,BELT_PROFILE.startZ,BELT_PROFILE.endZ);
    kinds.add(Math.abs(normal.x)>.9 ? 'edge' : normal.y*radialY+normal.z*radialZ>0 ? 'outside' : 'inside');
    const u = uv.getX(i);
    if (u<uMin) {uMin=u;start.copy(point);}
    if (u>uMax) {uMax=u;end.copy(point);}
    mean.add(point);
  }
  if (kinds.size!==1) throw new Error('Una primitiva de la correa mezcla caras internas y externas.');
  const surface = [...kinds][0];
  if (surface==='edge') return {mesh, surface, repeat:0, offset:0};
  if (uMax-uMin<1e-8) throw new Error('UV longitudinales inválidas en la correa.');
  const reference = beltDistance(mean.divideScalar(positions.count));
  // Keep each native UV island on one continuous branch of the closed path.
  const unwrap = (s:number)=>s + Math.round((reference-s)/BELT_LENGTH)*BELT_LENGTH;
  const s0=unwrap(beltDistance(start)), s1=unwrap(beltDistance(end));
  const repeat=(s1-s0)/(uMax-uMin)/BELT_TILE_LENGTH;
  return {mesh, surface, repeat, offset:s0/BELT_TILE_LENGTH-uMin*repeat};
}

export function applyBeltMaterials(
  root: Object3D,
  finishes: {abrasive:MeshStandardMaterial; backing:MeshStandardMaterial},
  transmission: Transmission,
) {
  root.updateMatrixWorld(true);
  const surfaces: ReturnType<typeof inspectSurface>[] = [];
  root.traverse(object=>{if (object instanceof Mesh) surfaces.push(inspectSurface(object));});
  if (!surfaces.some(face=>face.surface==='outside') || !surfaces.some(face=>face.surface==='inside')) {
    throw new Error('No se identificaron ambas superficies de correa.glb.');
  }
  const oldMaterials = new Set<Material>();
  const maps: {texture:Texture; origin:number}[] = [];
  const edgeMaterial = new MeshStandardMaterial({color:0xd5c7a6, roughness:.93, metalness:0});
  for (const face of surfaces) {
    for (const material of Array.isArray(face.mesh.material) ? face.mesh.material : [face.mesh.material]) oldMaterials.add(material);
    if (face.surface==='edge') {face.mesh.material=edgeMaterial;continue;}
    const material = (face.surface==='outside' ? finishes.abrasive : finishes.backing).clone();
    material.name = face.surface==='outside' ? 'Correa · lija exterior' : 'Correa · base interior';
    // Native Onshape UV islands run along U and across V. Each island needs its
    // own scale/phase, so clone texture state while sharing the loaded image.
    // Geometry, UV attributes, normals, indices, transforms and parents remain
    // exactly as loaded; all mapping is done by the existing texture matrix.
    for (const key of ['map','bumpMap'] as const) {
      const source = material[key];
      if (!source) continue;
      const texture=source.clone();
      const image=source.image as {width:number; height:number};
      texture.wrapS=texture.wrapT=MirroredRepeatWrapping;
      texture.repeat.set(face.repeat, BELT_PROFILE.width/(BELT_TILE_LENGTH*image.height/image.width));
      texture.offset.set(face.offset,0);
      texture.needsUpdate=true;
      material[key]=texture;
      maps.push({texture,origin:face.offset});
    }
    face.mesh.material=material;
  }
  disposeUnreferencedMaterials(root, oldMaterials);
  let travel=0;
  const unsubscribe=transmission.onRotate('roller1', deltaAngle=>{
    // No slip: ds = radius * dtheta. Increasing offset moves the pattern in the
    // opposite direction, hence the minus sign. Wrap tile phase, not gear phase.
    travel=MathUtils.euclideanModulo(travel+ROLLER_1_RADIUS*deltaAngle/BELT_TILE_LENGTH,2);
    for (const {texture,origin} of maps) texture.offset.x=origin-travel;
  });
  return {surfaces, dispose:unsubscribe};
}
