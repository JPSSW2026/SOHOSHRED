/**
 * Snow-gun plumes.
 *
 * A tower lance is only recognisable when it is RUNNING: the reference photos
 * of these machines are four-fifths thrown snow and one-fifth yellow steel.
 *
 * This was first built as geometry — a swept tube along the ballistic arc,
 * with alpha faded toward the silhouette so it would not show an edge. It
 * never stopped reading as blown glass. A surface has a front and a back and
 * the eye finds them; a cloud does not. The spray under the rider's board
 * looks right for exactly one reason, which is that it is not a surface, and
 * the same answer applies here.
 *
 * So a plume is a stream of camera-facing puffs, and the whole stream is
 * static geometry evaluated in the vertex shader:
 *
 *   · every puff of every gun on the mountain is one quad in ONE mesh, one
 *     draw call, built once
 *   · a puff's age is `fract(time / life + its own offset) * life`, so the
 *     puffs cycle continuously from nozzle to ground with no CPU work and no
 *     pool to run dry
 *   · position is the ballistic arc evaluated at that age, so the plume
 *     genuinely flows rather than pulsing in place
 *   · the puff grows and thins with age, and the ground clamp piles the tail
 *     into drifting fog where the snow lands
 *
 * The shading is the spray's: a dense core with a diffuse skirt, and a
 * Henyey-Greenstein forward-scattering term so that looking toward the sun
 * through a plume makes it glow, which is the single most recognisable thing
 * about airborne snow.
 */
import * as THREE from 'three';
import { makeRng } from '../core/rng.js';

const VERT = /* glsl */`
  precision highp float;

  uniform float uTime;
  uniform float uLife;       // seconds from nozzle to ground
  uniform float uGravity;    // softened: wet snow has a lot of drag
  uniform vec3  uWind;

  attribute vec2  aCorner;   // ±1 quad corner
  attribute vec3  aVel;      // muzzle velocity, world space
  attribute vec4  aPuff;     // x: phase offset, y: size, z: alpha, w: seed
  attribute float aGroundY;

  varying float vAlpha;
  varying vec2  vUv;
  varying vec2  vSeed;
  varying vec3  vWorld;

  void main() {
    float u = fract( uTime / uLife + aPuff.x );
    float age = u * uLife;

    vec3 wp = position + aVel * age;
    wp.y -= 0.5 * uGravity * age * age;
    // Wind acts as an acceleration, not a velocity: a puff just out of the
    // nozzle is still going where it was aimed, and only the old, slow snow
    // at the end of the arc gets carried sideways.
    wp += uWind * ( age * age * 0.5 );
    // Where the snow lands it does not stop existing, it drifts along the
    // ground. Clamping instead of killing is what gives the base of a plume
    // its skirt.
    wp.y = max( wp.y, aGroundY + 0.25 );

    float size = aPuff.y * ( 0.30 + 2.15 * pow( u, 0.72 ) );

    // Fade in over the first few per cent of the life and out over the last
    // third, so a recycling puff never pops at either end.
    float a = aPuff.z
      * smoothstep( 0.0, 0.05, u )
      * ( 1.0 - smoothstep( 0.72, 1.0, u ) );

    vec4 mv = modelViewMatrix * vec4( wp, 1.0 );
    // Spin each puff by its own angle so the fragment grain is not aligned
    // across the whole plume.
    float sp = aPuff.w * 6.28318 + u * 1.7;
    float cs = cos( sp ), sn = sin( sp );
    vec2 c = vec2( aCorner.x * cs - aCorner.y * sn, aCorner.x * sn + aCorner.y * cs );
    mv.xy += c * size;

    vWorld = wp;
    vUv = aCorner;
    vSeed = vec2( aPuff.w, aPuff.x );
    vAlpha = a;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */`
  precision highp float;

  uniform vec3 uSunDir;      // toward the sun
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform vec3 uCameraPos;
  uniform float uFar;        // distance at which a plume has faded out
  uniform float uSunEnergy;  // scene sun intensity x a scattering coefficient

  varying float vAlpha;
  varying vec2  vUv;
  varying vec2  vSeed;
  varying vec3  vWorld;

  float hash(vec2 p) {
    return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
  }

  void main() {
    float r2 = dot( vUv, vUv );
    if ( r2 > 1.0 ) discard;

    // Dense core, diffuse skirt — the same profile the board spray uses.
    float core = 1.0 - r2;
    float shape = core * core * ( 0.52 + 0.48 * core );
    shape *= 0.84 + 0.16 * hash( vSeed + floor( vUv * 3.0 ) );

    vec3 viewDir = normalize( vWorld - uCameraPos );
    float cosT = dot( viewDir, uSunDir );
    float g = 0.6;
    float denom = 1.0 + g * g - 2.0 * g * cosT;
    float phase = ( 1.0 - g * g ) / ( 4.0 * 3.14159 * pow( max( denom, 0.0001 ), 1.5 ) );

    // WEIGHT THE SUN, NOT THE SKY.
    //
    // uSkyColor here is the scene ambient, and the scene ambient in this
    // basin is (0.23, 0.46, 1.00) -- a saturated blue, because that is what
    // fills a snow shadow. The board spray gets away with leaning on it
    // because a puff of spray lasts a third of a second. A plume hangs in
    // frame for seconds, and at those weights it came out blue-grey and read
    // as exhaust from a diesel rather than as snow. Thrown snow is a
    // broadband scatterer: it takes its colour from the SUN, with the sky
    // only tinting it cool.
    vec3 lit = uSunColor * ( 1.05 + phase * 5.0 ) + uSkyColor * 0.45;
    vec3 dim = uSunColor * 0.95 + uSkyColor * 0.55;
    float sunAmount = clamp( 0.38 + phase * 2.4, 0.0, 1.0 );
    // SCALE TO THE SCENE'S LIGHT LEVEL.
    //
    // uSunColor is a normalised colour -- the sun's actual intensity is 30,
    // carried on the light, and this shader writes LINEAR radiance into an
    // HDR target that the post chain tonemaps. Writing ~1.0 into a frame
    // where sunlit snow sits near 5.0 makes the plume DARKER than the sky
    // behind it, so it composites as a dim veil and ACES turns that dim blue
    // into grey-brown. It looked like exhaust because it was, radiometrically,
    // a shadow. Three rounds of adjusting the plume's HUE changed nothing,
    // for the obvious reason once the level is the thing that is wrong.
    vec3 col = mix( dim, lit, sunAmount ) * uSunEnergy;

    // Distance fade. Sixty plumes' worth of large soft quads is a lot of
    // overdraw for something that is two pixels across.
    float d = length( vWorld - uCameraPos );
    float far = 1.0 - smoothstep( uFar * 0.62, uFar, d );

    float a = vAlpha * shape * far;
    if ( a < 0.004 ) discard;
    gl_FragColor = vec4( col, a );
  }
`;

export class SnowPlumes {
  constructor(opt = {}) {
    this.life = opt.life ?? 2.3;
    this.gravity = opt.gravity ?? 10.0;
    this.speed = opt.speed ?? 9.0;
    this.spread = opt.spread ?? 0.26;     // half-angle of the fan, radians
    // A jet has to be CONTINUOUS. At 34 puffs over a 2.3 s life the stream
    // was a wisp with daylight between its puffs; the density that reads as
    // thrown snow needs several overlapping at every point of the arc.
    this.perGun = opt.perGun ?? 100;
    // Plumes carry a LONG way -- a row of them along a run is most of what
    // makes an establishing shot read as a working ski field, and at 520 m
    // they were fading out before the wide shots even saw them. A plume at a
    // kilometre is a few pixels, so the overdraw this costs is nothing.
    this.far = opt.far ?? 1750;
    this.object3D = new THREE.Group();
    this.object3D.name = 'snow-plumes';
    this.mesh = null;
    this._time = 0;
  }

  /**
   * @param {Array<{x:number,y:number,z:number,yaw:number,rake:number,
   *                lanceLen:number,baseY:number}>} guns
   *        one entry per FIRING gun, in world space; `yaw`/`rake` describe
   *        where its lance points.
   */
  build(guns, seed = 1) {
    if (!guns.length) return;
    const rng = makeRng(seed);
    const N = guns.length * this.perGun;

    const position = new Float32Array(N * 4 * 3);
    const corner = new Float32Array(N * 4 * 2);
    const vel = new Float32Array(N * 4 * 3);
    const puff = new Float32Array(N * 4 * 4);
    const groundY = new Float32Array(N * 4);
    const index = new Uint32Array(N * 6);

    const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    let q = 0;
    for (const gn of guns) {
      // Nozzle in world space: up the lance from the base, in the gun's yaw.
      const dxl = Math.cos(gn.rake), dyl = Math.sin(gn.rake);
      const reach = gn.lanceLen + 0.72;
      const fx = Math.cos(gn.yaw), fz = -Math.sin(gn.yaw);   // local +X in world
      const nx = gn.x + fx * dxl * reach;
      const ny = gn.y + gn.baseY + dyl * reach;
      const nz = gn.z + fz * dxl * reach;

      for (let i = 0; i < this.perGun; i++) {
        // Phases evenly spaced, lightly jittered: even spacing is what makes
        // the stream continuous, and the jitter is what stops it reading as
        // a string of beads.
        const ph = (i + rng.range(-0.35, 0.35)) / this.perGun;
        const fan = rng.range(-this.spread, this.spread);
        const cf = Math.cos(fan), sf = Math.sin(fan);
        // Rotate the aim in the horizontal plane by the fan angle.
        const ax = fx * cf - fz * sf, az = fz * cf + fx * sf;
        const sp = this.speed * rng.range(0.88, 1.12);
        const vx = ax * dxl * sp, vy = dyl * sp, vz = az * dxl * sp;

        const size = rng.range(0.62, 1.15);
        const alpha = 0.40 * rng.range(0.85, 1.15);
        const sd = rng();

        const base = q * 4;
        for (let c = 0; c < 4; c++) {
          const v = base + c;
          position[v * 3] = nx; position[v * 3 + 1] = ny; position[v * 3 + 2] = nz;
          corner[v * 2] = CORNERS[c][0]; corner[v * 2 + 1] = CORNERS[c][1];
          vel[v * 3] = vx; vel[v * 3 + 1] = vy; vel[v * 3 + 2] = vz;
          puff[v * 4] = ph; puff[v * 4 + 1] = size;
          puff[v * 4 + 2] = alpha; puff[v * 4 + 3] = sd;
          groundY[v] = gn.y;
        }
        const o = q * 6;
        index[o] = base; index[o + 1] = base + 1; index[o + 2] = base + 2;
        index[o + 3] = base; index[o + 4] = base + 2; index[o + 5] = base + 3;
        q++;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    geo.setAttribute('aVel', new THREE.BufferAttribute(vel, 3));
    geo.setAttribute('aPuff', new THREE.BufferAttribute(puff, 4));
    geo.setAttribute('aGroundY', new THREE.BufferAttribute(groundY, 1));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    // Every vertex sits at its gun's nozzle and is moved metres away in the
    // shader, so a bounding sphere computed from the attribute is far too
    // small and the whole mesh vanishes the moment the nozzles leave the
    // frustum. Frustum culling is handled by the per-fragment distance fade.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.uniforms = {
      uTime: { value: 0 },
      uLife: { value: this.life },
      uGravity: { value: this.gravity },
      uWind: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 0.97, 0.92) },
      uSkyColor: { value: new THREE.Color(0.45, 0.60, 0.85) },
      uCameraPos: { value: new THREE.Vector3() },
      uFar: { value: this.far },
      uSunEnergy: { value: 4.8 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // Normal blending, never additive: thrown snow OCCLUDES the mountain
      // behind it. Additive would make every gun look like it was on fire.
      blending: THREE.NormalBlending,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'snow-plume-puffs';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // Draw after the opaque world and after the terrain's own transparencies.
    this.mesh.renderOrder = 3;
    this.object3D.add(this.mesh);
  }

  setWind(v) { if (this.uniforms) this.uniforms.uWind.value.copy(v); }

  update(time, camera, sky) {
    if (!this.uniforms) return;
    const u = this.uniforms;
    u.uTime.value = time;
    if (camera) u.uCameraPos.value.copy(camera.position);
    if (sky) {
      if (sky.sunDirection) u.uSunDir.value.copy(sky.sunDirection).normalize();
      if (sky.sunColor) u.uSunColor.value.copy(sky.sunColor);
      // Match sunlit snow: albedo/PI x intensity x a typical N.L. Tracking
      // the light means the plume dims with the sun through the day instead
      // of glowing on at dusk.
      if (sky.sun) u.uSunEnergy.value = sky.sun.intensity * 0.16;
      if (sky.ambientColor) u.uSkyColor.value.copy(sky.ambientColor);
    }
  }
}
