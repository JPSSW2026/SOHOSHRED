/**
 * The modelled range wall: the user's treated Soho Basin backdrop
 * (image-to-3D relief, single 457k-tri mesh with baked painterly
 * textures), mounted as the down-valley horizon above the inversion
 * deck. The baked art carries its own shading, so the material stays
 * unlit apart from aerial perspective, which it inherits through the
 * standard fog chunk like every other surface.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export async function mountBackdropModel(ctx) {
  const gltf = await new GLTFLoader().loadAsync('models/backdrop-ranges.glb');
  const root = gltf.scene;
  let mesh = null;
  root.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
  if (!mesh) return null;

  // A painted matte: the art was authored as seen from the slopes with its
  // atmosphere baked in, so it renders UNLIT and UNFOGGED - adding our
  // aerial on top flattened it into the sky.
  const mat = new THREE.MeshBasicMaterial({
    map: mesh.material.map,
    fog: false,
    toneMapped: true,
    side: THREE.DoubleSide,   // look-dev: orientation-proof
  });
  mesh.material = mat;
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  // Unit slab -> a 15 km wide, ~2.4 km tall relief standing across the
  // down-valley horizon, its base buried in the fog deck.
  const g = new THREE.Group();
  g.name = 'backdrop-model';
  g.add(root);
  root.scale.set(11000, 6000, 3500);
  g.position.set(300, 1250, -5600);
  // The runs face down-valley (-z); the painted face looks back up at them.
  ctx.scene.add(g);
  return g;
}
