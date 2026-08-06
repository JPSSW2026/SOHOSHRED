/**
 * Base-penetration probe: what pokes out the BOTTOM of the board while riding.
 *
 * The board-preview probe walked only the binding mounts, so the boots -- which
 * hang off the LEG chain (thigh -> shin -> boot), not off the binding -- were
 * never measured, and skinned meshes were measured in bind space rather than
 * posed space. Both holes hide exactly the defect the user reported.
 *
 * This samples the LIVE posed rider over a real run, resolves skinning per
 * vertex, and reports every mesh whose lowest vertex sits below the board's
 * own base plane, in boardPivot-local space.
 *
 *   node tools/base-penetration.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 6393 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.setDefaultTimeout(900000);
page.on('pageerror', e => console.log('[pageerr]', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:6393/index.html');
await page.waitForFunction(() => window.__SOHO?.isReady, null, { timeout: 300000 });

const out = await page.evaluate(async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const S = window.__SOHO;
  const rider = S.ctx.player.rider;
  const board = rider.boardObject;

  // Board base plane, in boardPivot-local space, from the deck itself.
  const _v = new THREE.Vector3();
  const inv = new THREE.Matrix4();
  let baseY = 1e9;
  board.traverse((o) => {
    if ((o.name || '') !== 'deck' || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(o.matrix);
      if (_v.y < baseY) baseY = _v.y;
    }
  });

  // Posed lowest point of one mesh, in boardPivot-local space. SkinnedMesh
  // vertices live in bind space; applyBoneTransform resolves the actual pose.
  const lowestOf = (o) => {
    const pos = o.geometry.attributes.position;
    let lo = 1e9;
    const step = Math.max(1, Math.floor(pos.count / 900));
    for (let i = 0; i < pos.count; i += step) {
      _v.fromBufferAttribute(pos, i);
      if (o.isSkinnedMesh) { o.applyBoneTransform(i, _v); } else { _v.applyMatrix4(o.matrixWorld); }
      if (o.isSkinnedMesh) _v.applyMatrix4(o.matrixWorld);
      _v.applyMatrix4(inv);
      if (_v.y < lo) lo = _v.y;
    }
    return lo;
  };

  const worst = new Map();
  const sample = () => {
    board.updateMatrixWorld(true);
    inv.copy(board.matrixWorld).invert();
    rider.object3D.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      if ((o.name || '') === 'deck' || (o.name || '') === 'steelEdges') return;
      const lo = lowestOf(o);
      const key = o.name || o.geometry.type + '#' + o.id;
      const prev = worst.get(key);
      if (!prev || lo < prev.lowest) worst.set(key, { lowest: +lo.toFixed(4), skinned: !!o.isSkinnedMesh });
    });
  };

  // Sample across a real run: idle, then riding, then a flexed/airborne frame.
  sample();
  for (let n = 0; n < 60; n++) {
    for (let k = 0; k < 8; k++) S.engine.tick(1 / 60);
    sample();
  }

  // Is the leg IK actually landing the ankle on its target, or is the sole
  // low because the solve falls short? Measured in boardPivot-local space, so
  // board roll is already divided out.
  board.updateMatrixWorld(true);
  inv.copy(board.matrixWorld).invert();
  const legs = [['F', 'Front'], ['B', 'Back']].map(([side, tag]) => {
    const ankle = rider.bones[`boot${side}`];
    const mount = rider.bones[`binding${tag}`];
    const a = new THREE.Vector3().setFromMatrixPosition(ankle.matrixWorld).applyMatrix4(inv);
    const m = new THREE.Vector3().setFromMatrixPosition(mount.matrixWorld).applyMatrix4(inv);
    const off = a.clone().sub(m);
    return { tag, wantOffsetLen: 0.1482, gotOffsetLen: +off.length().toFixed(4),
             ankleAboveMount: +off.y.toFixed(4),
             lateralMiss: +Math.hypot(off.x, off.z).toFixed(4),
             offsetTiltDeg: +(Math.acos(Math.min(1, off.y / off.length())) * 180 / Math.PI).toFixed(1) };
  });
  // Board roll about its own long axis, in the rider root's frame.
  const boardUp = new THREE.Vector3(0, 1, 0)
    .applyQuaternion(board.getWorldQuaternion(new THREE.Quaternion()));
  const rollDeg = +(Math.acos(Math.min(1, boardUp.y)) * 180 / Math.PI).toFixed(1);

  const rows = [...worst.entries()]
    .map(([part, v]) => ({ part, ...v, below: +(baseY - v.lowest).toFixed(4) }))
    .filter(r => r.below > -0.004)
    .sort((a, b) => b.below - a.below);
  return { baseY: +baseY.toFixed(4), rollDeg, legs, penetrating: rows.slice(0, 12) };
});
console.log(JSON.stringify(out, null, 1));
await browser.close(); await server.close();
