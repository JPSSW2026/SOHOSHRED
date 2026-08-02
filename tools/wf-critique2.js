export const meta = {
  name: 'soho-shred-round2',
  description: 'Round 2: blind A/B on r6, fix the round-1 regressions, verify in pixels',
  phases: [
    { title: 'Critique', detail: 'blind A/B on r6 + regression audit' },
    { title: 'Fix', detail: 'one file per agent, root causes only' },
    { title: 'Verify', detail: 'rebuild, recapture r7, confirm in pixels' },
  ],
}

const ROOT = '/home/user/SOHOSHRED'

phase('Critique')

const CRITIC_SCHEMA = {
  type: 'object',
  required: ['blindCall', 'verdict', 'score', 'blockers'],
  properties: {
    blindCall: { type: 'string' },
    blindCorrect: { type: 'boolean' },
    verdict: { type: 'string', enum: ['AAA', 'CLOSE', 'NOT_AAA', 'BROKEN'] },
    score: { type: 'number' },
    blockers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['issue', 'file', 'severity', 'fix'],
        properties: {
          issue: { type: 'string' },
          file: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          fix: { type: 'string' },
        },
      },
    },
  },
}

// Carried forward from the round-1 verification, which measured every one of
// these in the r4 pixels. Round 2 must not rediscover them from scratch, but
// must not assume they persist either - several files changed since.
const CARRIED = [
  'REGRESSIONS INTRODUCED BY ROUND 1 (verified in r4 pixels, re-check in r6):',
  '  SEVERE  terrain.js  bluff faces render as a venetian-blind comb: ~15 alternating',
  '          white/dark-blue horizontal stripes across the west-spur frontage.',
  '          Suspect winding flip + _foliationRelief + the faceW taper interacting.',
  '  MAJOR   sky.js      sky over-saturated. Mean frame saturation 0.39-0.47 against a',
  '          0.18-0.36 target; cool high-chroma share 18-29% against 1.5-6%.',
  '  MAJOR   snowMaterial.js  shadow B/R over-corrected past the 1.25-1.40 band on 6/9',
  '          (up to 1.885, and 3.288 on ridge-backlight). sky.js spectral bounce and',
  '          snowMaterial INDIRECT_TINT are stacking.',
  '  MAJOR   terrain.js  solifluction terraces read as corduroy/fingerprint ripple over',
  '          the whole shadowed mid-slope. The 0.75 m riser raise is too strong.',
  '  MAJOR   sky.js      cast-shadow boundaries have hard polygonal stair-steps and a',
  '          screen-door dither pattern inside them.',
  '  MOD     postprocess.js  chromatic aberration far too strong: thin dark objects get',
  '          rainbow fringes (the lift-tower mast reads cyan/red/yellow).',
  '  MOD     props.js    lift towers cast no shadow at all despite a low sun.',
  '  MOD     props.js    a solid orange-red fence line runs unbroken across west-spur and',
  '          reads as a 2D drawn line rather than a fence in the world.',
  '',
  'STILL BROKEN FROM ROUND 1 (re-check, do not assume):',
  '  sky.js      distant ridges render PALER than the sky directly above them - an',
  '              impossible image. REGRESSED in r4: delta was +26..+49, now +73..+93.',
  '  sky.js      a cloud wedge with a razor-straight vertical cut reads as a knife-cut',
  '              billboard.',
  '  props.js    schist outcrops render as small dark blue-grey CUBOIDS scattered on the',
  '              snow: no foliation, no drift collar, no contact shadow.',
  '  snowMaterial.js  glints render as large white SQUARES rather than points.',
  '  terrain.js  the drainage network and concave run-out do not read at any framing.',
  '  props.js    tussock gold absent: warm high-chroma share 0.00-0.14% against 1.5-6%.',
].join('\n')

const BASE = [
  'You are a brutally harsh art director reviewing the in-development Three.js game',
  '"Soho Shred" (Soho Basin, Cardrona NZ) against the shipped Xbox/PC game "Shredders".',
  '',
  'STEP 1 - BLIND TEST. Look at the images in ' + ROOT + '/compare/r6/ with the Read tool.',
  'Each pair-*.png shows two frames labelled A and B. One is ours, one is real Shredders.',
  'DO NOT read ANSWER_KEY.json until you have committed to a call. For at least four',
  'pairs, state which panel you believe is the shipped game and what gave it away. Then',
  'read ANSWER_KEY.json and report whether you were right.',
  '',
  'STEP 2 - GRADE. Our raw frames are in ' + ROOT + '/shots/r6/. Grade against the',
  '56-point AAA ACCEPTANCE CHECKLIST at the end of ' + ROOT + '/docs/ART_DIRECTION.md and',
  'the measured targets in its section 1. Also read ' + ROOT + '/docs/REFERENCE_ANALYSIS.md.',
  '',
  'This is round 2. Round 1 fixed ten confirmed blockers but introduced nine new',
  'problems. Exposure has since been re-metered per setup and all nine presets now sit',
  'in the 130-185 mean-luma band, and the rider/FX/HUD layer has shipped, so anything',
  'you remember about capsule riders or blown exposure is stale - judge r6 only.',
  '',
  CARRIED,
  '',
  'Score 10 = indistinguishable from Shredders. Be uncharitable. Every blocker must name',
  'the exact file and a concrete implementable fix, with the measurement that proves it.',
  '',
  'Module ownership for the file field:',
  '  terrain geometry, LOD, landforms -> src/world/terrain.js',
  '  snow and rock shading, glints    -> src/world/snowMaterial.js',
  '  sky, sun, cloud, aerial persp,   -> src/world/sky.js',
  '  shadow setup',
  '  rocks, poles, tussock, fences,   -> src/world/props.js',
  '  lift towers, cornices',
  '  bloom, DOF, grain, grade, AO, CA -> src/fx/postprocess.js',
  '  exposure and tonemapping         -> src/core/config.js',
  '  rider mesh, rig, animation       -> src/player/rider.js',
  '  spray, plume, ambient snow       -> src/fx/particles.js',
  '  carve trenches                   -> src/fx/trails.js',
  '  camera framing and presets       -> src/core/shots.js',
].join('\n')

const critics = await parallel([
  () => agent(BASE + [
    '',
    'YOUR LENS: LIGHTING, ATMOSPHERE, COLOUR AND POST. Sky gradient and saturation, sun',
    'disc and glare, tonal range, shadow colour AND whether the blue has been pushed too',
    'far, aerial perspective and near-to-far depth separation, cloud form, grade, bloom,',
    'chromatic aberration, and shadow-map quality.',
  ].join('\n'), { label: 'critic:lighting', phase: 'Critique', schema: CRITIC_SCHEMA, effort: 'high' }),

  () => agent(BASE + [
    '',
    'YOUR LENS: SURFACE, MATERIAL AND ARTEFACTS. Snow at macro and range, glint shape,',
    'sastrugi, windpack vs powder, snow-on-rock, schist shading. Hunt aggressively for',
    'ARTEFACTS: the bluff comb, terrace corduroy, floating or detached geometry, seams,',
    'tiling, shimmer, aliasing, z-fighting. Any artefact is automatically critical.',
  ].join('\n'), { label: 'critic:material', phase: 'Critique', schema: CRITIC_SCHEMA, effort: 'high' }),

  () => agent(BASE + [
    '',
    'YOUR LENS: TERRAIN, CHARACTER, FX AND COMPOSITION. Does this read as a real',
    'glacially-carved alpine basin, and does it read as Soho Basin specifically (compare',
    ROOT + '/docs/TERRAIN_BRIEF.md)? Separately: judge the RIDER and the FX, which are',
    'new in r6 - character silhouette, proportion, pose plausibility, board contact,',
    'spray volume and shape, carve trench, and whether the gameplay framings are',
    'photographs a studio would actually ship.',
  ].join('\n'), { label: 'critic:terrain-character', phase: 'Critique', schema: CRITIC_SCHEMA, effort: 'high' }),
])

const valid = critics.filter(Boolean)
const allBlockers = valid.flatMap((c) => c.blockers || [])
log('Critique: ' + valid.map((c) => c.verdict + '(' + c.score + ')').join(', ') + ' - ' + allBlockers.length + ' blockers')

const byFile = {}
for (const b of allBlockers) {
  const f = (b.file || '').trim().replace(ROOT + '/', '')
  if (!f) continue
  if (!byFile[f]) byFile[f] = []
  byFile[f].push(b)
}
const rank = { critical: 0, major: 1, minor: 2 }
const sev = (f) => Math.min.apply(null, byFile[f].map((x) => (rank[x.severity] === undefined ? 3 : rank[x.severity])))
const files = Object.keys(byFile).sort((a, b) => sev(a) - sev(b))
log('Fix targets: ' + (files.join(', ') || '(none)'))

phase('Fix')

const FIX_SCHEMA = {
  type: 'object',
  required: ['file', 'fixed', 'notFixed', 'buildPassed'],
  properties: {
    file: { type: 'string' },
    fixed: { type: 'array', items: { type: 'string' } },
    notFixed: { type: 'array', items: { type: 'string' } },
    buildPassed: { type: 'boolean' },
  },
}

const fixes = files.length ? await parallel(files.map((f, i) => () =>
  agent([
    'You are fixing confirmed visual blockers in the Three.js game "Soho Shred" at ' + ROOT + '.',
    '',
    'YOU OWN EXACTLY ONE FILE: ' + f,
    'NEVER edit any other source file - other agents are editing those right now in',
    'parallel. If a fix genuinely requires a change elsewhere, do what you can in your',
    'own file and report the rest under notFixed.',
    '',
    'Blockers assigned to your file:',
    '',
    JSON.stringify(byFile[f], null, 2),
    '',
    'Read first:',
    '  ' + ROOT + '/docs/ARCHITECTURE.md       - the module contract',
    '  ' + ROOT + '/docs/ART_DIRECTION.md      - measured targets + 56-point checklist',
    '  ' + ROOT + '/docs/REFERENCE_ANALYSIS.md - what the real target looks like',
    '',
    'ROUND 1 LESSON, AND IT IS THE MOST IMPORTANT INSTRUCTION HERE: round 1 fixed ten',
    'blockers and introduced nine new problems, several worse than what they replaced.',
    'Two specific failure modes to avoid:',
    '  1. OVERSHOOT. Several round-1 fixes flew past their target band and out the other',
    '     side - shadows went from too grey to far too blue, exposure from too hot to',
    '     mean luma 73. Every target in ART_DIRECTION section 1 is a BAND. Aim for the',
    '     middle of it and state the number you expect to land on.',
    '  2. STACKING. Fixes in different files multiplied together because each agent',
    '     assumed it was the only one correcting a given quantity. If your fix changes a',
    '     quantity another file also contributes to (shadow tint, saturation, exposure,',
    '     contrast), say so explicitly under notFixed so it can be reconciled.',
    '',
    'HARD RULES: zero external assets, everything procedural. Never Math.random() - use',
    'makeRng/Simplex from src/core/rng.js. Three.js r185, plain JS ESM, SI units, +Y up.',
    'Fix the ROOT CAUSE. Do not hide an artefact behind fog, shrink it, or move the',
    'camera away from it.',
    '',
    'VALIDATE before reporting: run',
    '  cd ' + ROOT + ' && npx vite build --outDir dist-fix' + i + ' --logLevel warn',
    'confirm it exits 0, then rm -rf ' + ROOT + '/dist-fix' + i + '. Do NOT run the',
    'screenshot harness - a verification agent does that after you.',
  ].join('\n'), {
    label: 'fix:' + f.split('/').pop(), phase: 'Fix', schema: FIX_SCHEMA,
    agentType: 'general-purpose', effort: 'high',
  })
)) : []

const okFixes = fixes.filter(Boolean)
log('Fixes: ' + okFixes.length + '/' + files.length + ' files repaired')

phase('Verify')

const verify = await agent([
  'You are verifying fix round 2 for "Soho Shred" at ' + ROOT + '.',
  '',
  'Fix agents just edited these files in parallel:',
  JSON.stringify(okFixes, null, 2),
  '',
  'TASK:',
  '1. cd ' + ROOT + ' && npx vite build --logLevel warn - fix every error until exit 0.',
  '   You may edit any file now; you are the only agent running.',
  '2. node tools/shoot.mjs --width 960 --height 540 --out shots/r7',
  '   Iterate until all 9 presets capture with ZERO console errors.',
  '3. Read the PNGs. Confirm each blocker below is resolved IN THE PIXELS. A fix that',
  '   did not change the image is not a fix. Measure; do not take the agents word.',
  '   Blockers: ' + JSON.stringify(allBlockers.map((b) => b.issue)),
  '4. CHECK FOR OVERSHOOT specifically. For every band-valued target in',
  '   ART_DIRECTION section 1 (mean luma 130-185, shadow B/R 1.25-1.40, frame saturation',
  '   0.18-0.36, pure-white share 0.43-5.82%), report the measured value per preset and',
  '   flag anything that has crossed to the far side of its band.',
  '5. node tools/compare.mjs --ours shots/r7 --out compare/r7',
  '6. git add -A and commit on branch claude/soho-shred-game-lgudxl. Do NOT push - push',
  '   is 403-blocked. Only commit if the build is green.',
  '',
  'Report what is confirmed fixed, what is not, what regressed, and what overshot.',
].join('\n'), {
  label: 'verify', phase: 'Verify', agentType: 'general-purpose', effort: 'high',
  schema: {
    type: 'object',
    required: ['buildPassed', 'confirmedFixed', 'stillBroken'],
    properties: {
      buildPassed: { type: 'boolean' },
      confirmedFixed: { type: 'array', items: { type: 'string' } },
      stillBroken: { type: 'array', items: { type: 'string' } },
      overshot: { type: 'array', items: { type: 'string' } },
      newProblems: { type: 'array', items: { type: 'string' } },
      committed: { type: 'boolean' },
    },
  },
})

return {
  critique: valid.map((c) => ({
    verdict: c.verdict, score: c.score, blindCall: c.blindCall, blindCorrect: c.blindCorrect,
  })),
  blockerCount: allBlockers.length,
  filesFixed: files,
  verify,
}
