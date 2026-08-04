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
    // The valley-floor sink below is an ALPHA fade: the sunk region lets
    // the real inversion deck / sky render through, which matches the fog
    // by construction (a painted constant never matched the post chain).
    transparent: true,
    depthWrite: false,
  });
  // The painting's lower half is its valley floor, painted grey-olive.
  // From ride height the terrain silhouette hides it, but from the
  // headwall you see straight over the bowl rim onto it — a flat dull
  // slab between the snow and the ridges. Sink everything below the
  // inversion deck's top into the same fog the deck paints (the deck
  // itself cannot reach this material: it is fog:false by design).
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSohoBW;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
	vSohoBW = ( modelMatrix * vec4( position, 1.0 ) ).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSohoBW;')
      .replace('#include <dithering_fragment>', `
	{
		// Band-mapped against the mounted mesh: the painted floor reaches
		// ~y 2100 and the ridge feet start ~2200, so the fog rises to just
		// below them — "only the tops of the mountains visible", with a
		// graded shoulder so the midslopes emerge from haze, not a cut.
		// A light whitening rides the shoulder so the emerging midslopes
		// look haze-licked rather than cleanly clipped.
		float sink = 1.0 - smoothstep( 1860.0, 2400.0, vSohoBW.y );
		gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( 1.14, 1.22, 1.35 ), sink * 0.55 );
		gl_FragColor.a *= 1.0 - sink * 0.97;
	}
	#include <dithering_fragment>`);
  };
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


/**
 * The modelled Soho Express base station (user GLB, "a bit rough but cake
 * it in more snow"). Kept lit (it is a building in our sun), with snow
 * caking injected into its material: strong accumulation on every
 * up-facing surface plus a light rime dusting overall, and a drift
 * collar buried around the foundation so it sits IN the snowpack.
 */
export async function mountBaseStation(ctx) {
  const gltf = await new GLTFLoader().loadAsync('models/base-station.glb');
  const root = gltf.scene;
  let mesh = null;
  root.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
  if (!mesh) return null;

  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const m = mesh.material;
  m.side = THREE.DoubleSide;
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSohoWN;')
      .replace('#include <defaultnormal_vertex>',
        '#include <defaultnormal_vertex>\nvSohoWN = normalize( mat3( modelMatrix ) * objectNormal );');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSohoWN;')
      .replace('#include <map_fragment>', `#include <map_fragment>
	{
		float up = smoothstep( 0.30, 0.75, vSohoWN.y );
		float dust = 0.18 * smoothstep( -0.2, 0.6, vSohoWN.y );
		float cake = clamp( up * 0.95 + dust, 0.0, 1.0 );
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.895, 0.905, 0.93 ), cake );
	}`);
  };
  m.needsUpdate = true;

  const yaw = Math.atan2(240 - 320, 700 - (-560));
  const gy = ctx.terrain.getHeight(320, -560);
  const g = new THREE.Group();
  g.name = 'base-station-model';
  g.add(root);
  root.scale.set(58, 44, 58);
  g.position.set(320, gy + 5.0, -560);
  g.rotation.y = yaw;
  ctx.scene.add(g);

  // Drift collar: a shallow snow ring burying the foundation line.
  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(26, 33, 3.2, 26),
    new THREE.MeshStandardMaterial({ color: 0xf2f4f8, roughness: 0.94 }),
  );
  collar.position.set(320, gy + 0.5, -560);
  collar.receiveShadow = true;
  ctx.scene.add(collar);
  return g;
}
