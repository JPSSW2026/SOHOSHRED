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
import { CONFIG } from '../core/config.js';
import { SOHO_HORIZON } from './sky.js';

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
    // `toneMapped` is a no-op here either way: with the composer in the
    // pipeline the scene renders to linear buffers and AgX is applied to
    // the whole frame at the end (see postprocess.js), so this matte is
    // tone-mapped no matter what the material asks for.
    toneMapped: true,
    side: THREE.DoubleSide,   // look-dev: orientation-proof
  });

  // ...which is why the painting needs a gain. The art is authored as FINAL
  // pixels - snow already white, atmosphere already in it - but it was being
  // fed to AgX at exposure 0.34 like a scene-linear radiance, which crushed
  // its whites to grey-blue and desaturated the snow off the peaks entirely
  // (playtest: "refined but stripped of snow on peaks"). Lit surfaces
  // survive that because sunlight is far above 1.0; a painted 1.0 does not.
  // Pre-dividing by the exposure puts the matte back where the painter put
  // it - the same inverse-exposure trick the AO luminance thresholds use.
  const exposure = ctx.renderer?.toneMappingExposure || CONFIG.render?.exposure || 1;
  mat.userData.gain = { value: 1 / Math.max(0.05, exposure) };
  // The colour the sky converges to at the horizon, in scene-linear. The
  // matte is fog:false, so this is the only way it can know what it is
  // standing in front of — and a range that does not know that is exactly
  // the range that ends up brighter than its own sky.
  // The sky's live horizon radiance, shared by reference so it tracks every
  // frame. scene.fog cannot serve here: the main path nulls it and keeps it
  // only as a fallback carrier, so reading it at mount yielded the Fog
  // constructor's default -- a fixed colour the sky had never rendered, which
  // is why clamping against it moved the matte without ever reaching the sky.
  mat.userData.haze = SOHO_HORIZON;
  // The painting's lower half is its valley floor, painted grey-olive.
  // From ride height the terrain silhouette hides it, but from the
  // headwall you see straight over the bowl rim onto it — a flat dull
  // slab between the snow and the ridges. Sink everything below the
  // inversion deck's top into the same fog the deck paints (the deck
  // itself cannot reach this material: it is fog:false by design).
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uBdGain = mat.userData.gain;
    sh.uniforms.uBdHaze = mat.userData.haze;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uBdGain;\nuniform vec3 uBdHaze;');
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSohoBW;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
	vSohoBW = ( modelMatrix * vec4( position, 1.0 ) ).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSohoBW;')
      .replace('#include <dithering_fragment>', `
	{
		// Gain FIRST. The art is display-referred - painted as final pixels -
		// and everything below compares it against the sky, which only means
		// anything in the scene-linear space the tone mapper works in. Doing
		// the haze mix before the gain was the bug: the fade mixed toward a
		// near-white (0.92,0.96,1.02) in display space and *then* multiplied
		// by 1/exposure, landing at ~(2.7,2.8,3.0) linear - about four times
		// the fog colour the sky converges to. The haze meant to sink the
		// painted valley floor was itself the brightest thing in frame.
		gl_FragColor.rgb *= uBdGain;

		// The painted floor reaches ~y 2100 and the ridge feet start ~2200,
		// so the range sinks into the inversion deck from below: only the
		// tops stay clear of it.
		float sink = 1.0 - smoothstep( 1700.0, 2600.0, vSohoBW.y );
		// Converge to the LIVE horizon colour rather than a baked constant.
		// Reaching a full 1.0 is what lets the dithered discard go: at the
		// bottom of the band the matte is now exactly the colour the deck
		// and sky behind it would have painted, so an opaque pixel is
		// indistinguishable from a discarded one - without a screen-space
		// pattern shearing across a jagged silhouette. That pattern was
		// resolving into a woven stripe right across the horizon, and no
		// band width fixes it, because the artefact is the dither itself.
		gl_FragColor.rgb = mix( gl_FragColor.rgb, uBdHaze, min( sink * 1.25, 1.0 ) );

		// A range 5.6 km out cannot be brighter than the sky behind it. This
		// is the one artefact that reads as "matte painting" instead of
		// "mountain" (tell #28), and the baked-in atmosphere cannot prevent
		// it because the painter did not know our exposure. Extinction wins
		// at this distance, so clamp luma to just under the horizon haze
		// rather than trusting the art.
		const vec3 W = vec3( 0.2126, 0.7152, 0.0722 );
		float ceilL = dot( uBdHaze, W ) * 0.96;
		float artL = dot( gl_FragColor.rgb, W );
		gl_FragColor.rgb *= ( artL > ceilL ) ? ( ceilL / max( artL, 1e-4 ) ) : 1.0;
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
  // FrontSide: DoubleSide was drawing the building's interior back faces,
  // which read as loose shards hanging around the roofline.
  m.side = THREE.FrontSide;
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
  // Buried, not perched. At +5.0 there were five metres of daylight under
  // the foundation and the whole thing read as a slab floating over the snow.
  g.position.set(320, gy - 3.0, -560);
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
