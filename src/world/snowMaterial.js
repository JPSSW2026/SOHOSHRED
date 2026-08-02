/** PLACEHOLDER — replaced by the snow-shading workstream. */
import * as THREE from 'three';
import { CONFIG } from '../core/config.js';

export function createSnowMaterial(ctx, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.90, 0.93, 0.98),
    roughness: 0.72,
    metalness: 0.0,
    ...opts,
  });
}

export function createRockMaterial(ctx, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.20, 0.19, 0.20),
    roughness: 0.92,
    metalness: 0.0,
    ...opts,
  });
}

export function updateSnowMaterial() {}
