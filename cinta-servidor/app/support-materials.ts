/**
 * Selección de materiales estructurales respetando los nombres del GLB.
 * La protección de un ensamble se hereda por todos sus descendientes.
 * La sustitución de referencias evita recolorear materiales compartidos con
 * electrónica protegida; solo se liberan recursos que ya no tienen usuarios.
 */
import {Material, Mesh, Texture} from 'three';
import type {Object3D} from 'three';

export const PROTECTED_SUPPORTS = [
  'Nema17:1', 'HC-020K:1', 'switch:1', 'Display_OLED:1', 'hc-sr04:1',
  'base con driver y fan:1',
] as const;

/* Recupera el nombre original de Onshape conservado en userData. */
function originalName(object: Object3D): string {
  // GLTFLoader sanitizes Object3D.name (including ':' and spaces), but keeps
  // the exact GLB node name in userData.name. Do not match sanitized substrings.
  return String(object.userData.name ?? object.name).replace(/^occurrence of /, '');
}

/* Recorre primero todo el árbol y exige localizar las ramas protegidas
 * antes de autorizar cualquier sustitución de materiales. */
export function inspectSupports(root: Object3D) {
  const found = new Set<string>();
  const protectedNodes = new Set<Object3D>();
  const structural: Mesh[] = [];
  const visit = (object: Object3D, inheritedProtection: boolean) => {
    const name = originalName(object);
    const match = PROTECTED_SUPPORTS.find(target=>
      name===target || name.startsWith(target+'__') || name.startsWith(target+' <'));
    if (match) found.add(match);
    const protectedBranch = inheritedProtection || Boolean(match);
    if (protectedBranch) protectedNodes.add(object);
    else if (object instanceof Mesh) structural.push(object);
    for (const child of object.children) visit(child, protectedBranch);
  };
  visit(root, false);
  const missing = PROTECTED_SUPPORTS.filter(name=>!found.has(name));
  // Inspect the entire hierarchy before changing anything. Fail closed if a
  // different export lost the names that protect the electronics assembly.
  if (missing.length) throw new Error('No se identificaron en soportes.glb: '+missing.join(', '));
  return {found, protectedNodes, structural};
}

/* Aplica gris únicamente a mallas estructurales fuera de ramas protegidas. */
export function applySupportMaterial(root: Object3D, gray: Material) {
  const inspection = inspectSupports(root);
  const replaced = new Set<Material>();
  for (const mesh of inspection.structural) {
    for (const old of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) replaced.add(old);
    // Replace only these references. Imported materials can also be shared by
    // protected children; mutating a shared material would recolor those too.
    mesh.material = gray;
  }
  disposeUnreferencedMaterials(root, replaced);
  return inspection;
}

// Dispose only detached resources; never dispose a material or texture still
// used by a protected component (even through a different material instance).
/* Libera candidatos retirados solo si ninguna malla conserva su material
 * o textura, incluyendo los subcomponentes electrónicos. */
export function disposeUnreferencedMaterials(root: Object3D, candidates: Set<Material>) {
  const usedMaterials = new Set<Material>();
  const usedTextures = new Set<Texture>();
  root.traverse(object=>{
    if (!(object instanceof Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      usedMaterials.add(material);
      for (const value of Object.values(material)) if (value instanceof Texture) usedTextures.add(value);
    }
  });
  const retiredTextures = new Set<Texture>();
  for (const material of candidates) {
    if (usedMaterials.has(material)) continue;
    for (const value of Object.values(material)) {
      if (value instanceof Texture && !usedTextures.has(value)) retiredTextures.add(value);
    }
    material.dispose();
  }
  retiredTextures.forEach(texture=>texture.dispose());
}
