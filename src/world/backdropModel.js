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
    side: THREE.FrontSide,    // orientation settled; DoubleSide bled a warm back face down the cut edge
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
  // Band derived from the MESH, not from constants.
  //
  // The fade used hardcoded world heights of 1700 and 2600. Those were true
  // of an earlier mount; rescaling to 12.2 x 6.4 km at y 1180 moved every
  // feature of the model without moving them, so the painted valley floor
  // ended up at sink 0.58 -- where the curve below passed roughly a third of
  // the haze -- and two thirds of raw grey-olive paint survived as a flat
  // slab across 12% of the frame. Measuring the model means the band cannot
  // drift out of step with it again.
  mat.userData.band = { value: new THREE.Vector2(0, 1) };
  // The painting's lower half is its valley floor, painted grey-olive.
  // From ride height the terrain silhouette hides it, but from the
  // headwall you see straight over the bowl rim onto it — a flat dull
  // slab between the snow and the ridges. Sink everything below the
  // inversion deck's top into the same fog the deck paints (the deck
  // itself cannot reach this material: it is fog:false by design).
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uBdGain = mat.userData.gain;
    sh.uniforms.uBdHaze = mat.userData.haze;
    sh.uniforms.uBdBand = mat.userData.band;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uBdGain;\nuniform vec3 uBdHaze;\nuniform vec2 uBdBand;');
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

		// The painted art is a blue-grey range; the direction is a snowy one.
		// Pull chroma back toward the art's own luminance and lift the value,
		// so distant snow reads as snow rather than as weather. Proportional,
		// not additive, so rock keeps its relative darkness and the ridge
		// structure survives.
		{
			vec3 Wl = vec3( 0.2126, 0.7152, 0.0722 );
			float aL = dot( gl_FragColor.rgb, Wl );
			gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( aL ), 0.40 ) * 1.30;
		}

		// The painted floor reaches ~y 2100 and the ridge feet start ~2200,
		// so the range sinks into the inversion deck from below: only the
		// tops stay clear of it.
		float sink = 1.0 - smoothstep( uBdBand.x, uBdBand.y, vSohoBW.y );
		// Converge to the LIVE horizon colour rather than a baked constant.
		// Reaching a full 1.0 is what lets the dithered discard go: at the
		// bottom of the band the matte is now exactly the colour the deck
		// and sky behind it would have painted, so an opaque pixel is
		// indistinguishable from a discarded one - without a screen-space
		// pattern shearing across a jagged silhouette. That pattern was
		// resolving into a woven stripe right across the horizon, and no
		// band width fixes it, because the artefact is the dither itself.
		// Haze TARGET varies with height. Converging the whole massif to one
		// horizon colour is what made it read as blue haze rather than as
		// snow: the base genuinely does dissolve into the inversion deck, but
		// the tops are snow, lit by the same sun as the foreground, and they
		// keep their own value. So the target is the live horizon low down and
		// a bright neutral higher up -- the range stays snowy where it is
		// clear of the deck.
		vec3 W3 = vec3( 0.2126, 0.7152, 0.0722 );
		vec3 hazeHigh = mix( uBdHaze, vec3( dot( uBdHaze, W3 ) ) * 1.18, 0.68 );
		// Below the ridge feet the target is the horizon, flatly. The painted
		// valley floor is not snow catching sun, it is ground that should have
		// dissolved into the inversion deck, and converging it toward the
		// bright neutral meant for summits is what made it glow as a shelf.
		vec3 hazeTgt = mix( hazeHigh, uBdHaze, smoothstep( 0.10, 0.55, sink ) );
		// Weighted to the base as well: pow() keeps the mid-slopes far clearer
		// than a linear ramp did, so ridge structure survives instead of being
		// washed into a single wall of blue.
		// Linear, not pow(). The exponent was there to protect mid-slope
		// structure, but it also held the floor at a third of its haze, and the
		// band above now does that job properly by height instead.
		gl_FragColor.rgb = mix( gl_FragColor.rgb, hazeTgt, min( sink * 1.30, 1.0 ) );

		// Soft ceiling, not a hard one -- and well ABOVE the horizon, not
		// below it.
		//
		// This used to clamp the range to 0.96x the horizon luma, on the
		// reading that a distant range can never be brighter than its own sky
		// (tell #28). That is true of a range dissolving in haze; it is false
		// of sunlit snow. Real sunlit peaks at this distance are markedly
		// brighter than a deep blue sky, which is exactly what makes a big
		// massif read as majestic instead of as weather. The hard clamp was
		// crushing every peak to below sky value and flattening the whole
		// thing into the blue wash it was meant to prevent.
		//
		// A saturating curve keeps the guarantee that matters -- nothing can
		// run away and blow out -- while leaving the art's own value structure
		// intact right up to the ceiling.
		const vec3 W = vec3( 0.2126, 0.7152, 0.0722 );
		float ceilL = dot( uBdHaze, W ) * 2.60;
		float artL = dot( gl_FragColor.rgb, W );
		float soft = ceilL * ( 1.0 - exp( -artL / max( ceilL, 1e-4 ) ) );
		gl_FragColor.rgb *= soft / max( artL, 1e-4 );
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
  // Scale and height are the difference between a horizon detail and a
  // mountain range. At 11 km x 6 km mounted at y 1250 the massif cleared the
  // bowl rim by about ten pixels in a 720-line frame -- structurally present,
  // visually absent, which is why the wide shots read as an empty white bowl
  // under sky rather than as a place ringed by mountains. Nothing in the
  // shading could fix that; there was almost nothing on screen to shade.
  //
  // Taller and lifted so the tops stand well clear of the rim, and pulled
  // slightly closer so it subtends a larger angle. The base still sinks into
  // the inversion deck, so the extra height reads as peaks rather than as a
  // wall dropped in front of the valley.
  root.scale.set(12200, 6400, 3500);
  g.position.set(300, 1180, -6400);
  // The runs face down-valley (-z); the painted face looks back up at them.
  ctx.scene.add(g);

  // RING the bowl, do not wall one side of it.
  //
  // A single 12.2 km slab at 6.4 km subtends about 87 degrees, so the massif
  // existed in exactly one of nine framings: valley-vista looked at mountains
  // and hero-basin, west-spur and chase-carve looked at empty gradient sky
  // with the bowl rim as the only horizon event. Majesty cannot be delivered
  // by a backdrop that covers a quarter of the view.
  //
  // Three more copies rotated about the basin, each yawed to face inward and
  // nudged in radius and height so the skyline does not repeat as an obvious
  // tiling. Clones share geometry and material with the original, so this
  // costs three draw calls and no extra memory for a 495k-triangle mesh.
  const CENTRE = new THREE.Vector3(300, 1180, 0);
  const RADIUS = 6400;
  // All copies sit at the SAME height as the original. The haze band is one
  // shared uniform derived from the first mesh's bounds, so a copy lifted off
  // that height samples a different part of the fade and reads paler than the
  // range it is supposed to continue -- which is exactly what the flanks were
  // doing. Radius still varies, so the skyline does not repeat; height cannot,
  // until each copy carries its own band.
  for (const [deg, rScale, yLift] of [[92, 0.96, 0], [188, 1.04, 0], [270, 0.99, 0]]) {
    const a = deg * Math.PI / 180;
    const ring = new THREE.Group();
    ring.name = `backdrop-model-${deg}`;
    const clone = root.clone(true);
    clone.traverse((o) => { if (o.isMesh) o.material = mat; });
    ring.add(clone);
    ring.position.set(
      CENTRE.x + Math.sin(a) * RADIUS * rScale,
      1180 + yLift,
      CENTRE.z - Math.cos(a) * RADIUS * rScale,
    );
    // Face the basin centre.
    ring.rotation.y = a;
    ctx.scene.add(ring);
  }

  // Now that the group carries its final transform, measure it and set the
  // band: the floor dissolves below 42% of the model's height, and everything
  // above 62% is clear of the deck.
  g.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(g);
  const span = Math.max(1, bb.max.y - bb.min.y);
  mat.userData.band.value.set(bb.min.y + span * 0.42, bb.min.y + span * 0.62);

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
