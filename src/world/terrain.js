/** PLACEHOLDER — replaced by the terrain workstream. See docs/ARCHITECTURE.md */
import * as THREE from 'three';
import { Simplex, fbm2, ridged2 } from '../core/rng.js';
import { CONFIG } from '../core/config.js';
import { createSnowMaterial } from './snowMaterial.js';

export class Terrain {
  constructor(ctx) {
    this.ctx = ctx;
    this.simplex = new Simplex(1337);
    this.object3D = new THREE.Object3D();
    this.bounds = { minX: -1024, maxX: 1024, minZ: -1024, maxZ: 1024 };
    this._n = new THREE.Vector3();
  }

  getHeight(x, z) {
    const s = 0.0016;
    const base = ridged2(this.simplex, x * s, z * s, { octaves: 6 }) * 220;
    const detail = fbm2(this.simplex, x * s * 6, z * s * 6, { octaves: 4 }) * 12;
    // Global tilt so there is a fall line toward -Z.
    return base + detail - z * 0.28;
  }

  getNormal(x, z, out = new THREE.Vector3()) {
    const e = 0.75;
    const hL = this.getHeight(x - e, z), hR = this.getHeight(x + e, z);
    const hD = this.getHeight(x, z - e), hU = this.getHeight(x, z + e);
    return out.set(hL - hR, 2 * e, hD - hU).normalize();
  }

  sample(x, z, out = {}) {
    out.height = this.getHeight(x, z);
    out.normal = this.getNormal(x, z, out.normal || new THREE.Vector3());
    out.slope = Math.acos(Math.min(1, Math.max(-1, out.normal.y)));
    out.surface = 'powder';
    out.roughness = 0.5;
    return out;
  }

  getSpawn() {
    const x = 0, z = 380;
    return { position: new THREE.Vector3(x, this.getHeight(x, z), z), heading: Math.PI };
  }

  async build() {
    const size = 2048, res = 256;
    const geo = new THREE.PlaneGeometry(size, size, res, res);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, this.getHeight(pos.getX(i), pos.getZ(i)));
    }
    geo.computeVertexNormals();
    const mat = createSnowMaterial(this.ctx, {});
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.object3D.add(this.mesh);
    this.ctx.scene.add(this.object3D);
  }

  update() {}
}
