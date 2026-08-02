export const meta = {
  name: 'soho-shred-critique-fix',
  description: 'Blind A/B critique of the world render against real Shredders frames, then fix confirmed blockers',
  phases: [
    { title: 'Critique', detail: 'blind A/B + 56-point checklist' },
    { title: 'Fix', detail: 'repair confirmed blockers, one file per agent' },
    { title: 'Verify', detail: 'rebuild, recapture, confirm in pixels' },
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

const BASE = [
  'You are a brutally harsh art director reviewing the in-development Three.js game',
  '"Soho Shred" (Soho Basin, Cardrona NZ) against the shipped Xbox/PC game "Shredders".',
  '',
  'STEP 1 - BLIND TEST. Look at the images in ' + ROOT + '/compare/r3/ with the Read tool.',
  'Each pair-*.png shows two frames labelled A and B. One is ours, one is real Shredders.',
  'DO NOT read ANSWER_KEY.json until you have committed to a call. For at least three',
  'pairs, state which panel you believe is the shipped game and what gave it away. Then',
  'read ANSWER_KEY.json and report whether you were right.',
  '',
  'STEP 2 - GRADE. Our raw frames are in ' + ROOT + '/shots/r3/. Grade them against the',
  '56-point AAA ACCEPTANCE CHECKLIST at the end of ' + ROOT + '/docs/ART_DIRECTION.md and',
  'the measured targets in its section 1. Also read ' + ROOT + '/docs/REFERENCE_ANALYSIS.md',
  'and ' + ROOT + '/docs/FINDINGS_R1.md - the latter records three known defects; confirm',
  'or refute each against the current r3 captures rather than assuming they persist.',
  '',
  'Score 10 = indistinguishable from Shredders. Be uncharitable. Do not grade on effort',
  'or on "good for procedural". Every blocker must name the exact file to change and a',
  'concrete implementable fix. "Looks flat" is useless. "The aerial perspective uses a',
  'linear distance falloff so a 4km ridge and a 400m ridge sit at the same value,',
  'collapsing depth - use exponential height-and-distance falloff in sky.js" is useful.',
  '',
  'Module ownership for the file field:',
  '  terrain geometry and LOD        -> src/world/terrain.js',
  '  snow and rock shading           -> src/world/snowMaterial.js',
  '  sky, sun, cloud, aerial persp,  -> src/world/sky.js',
  '  shadow setup',
  '  rocks, poles, tussock, cornices -> src/world/props.js',
  '  bloom, DOF, grain, grade, AO    -> src/fx/postprocess.js',
  '  exposure and tonemapping        -> src/core/config.js',
].join('\n')

const critics = await parallel([
  () => agent(BASE + [
    '',
    'YOUR LENS: LIGHTING, ATMOSPHERE, COLOUR AND POST. Sky gradient and saturation, sun',
    'disc and glare, exposure and tonal range, shadow colour and softness, aerial',
    'perspective and near-to-far depth separation, cloud form, the colour grade, bloom,',
    'and whether the dynamic range is handled like film rather than clipped.',
  ].join('\n'), { label: 'critic:lighting', phase: 'Critique', schema: CRITIC_SCHEMA, effort: 'high' }),

  () => agent(BASE + [
    '',
    'YOUR LENS: SURFACE, MATERIAL AND ARTEFACTS. Snow surface at macro and close range,',
    'sparkle, sastrugi, windpack vs powder variation, snow-on-rock transitions, schist',
    'rock shading. Hunt aggressively for RENDERING ARTEFACTS: floating or detached',
    'geometry, LOD or tile seams, texture tiling, shimmer, aliasing, z-fighting,',
    'streaking. Any artefact is automatically a critical blocker.',
  ].join('\n'), { label: 'critic:material', phase: 'Critique', schema: CRITIC_SCHEMA, effort: 'high' }),

  () => agent(BASE + [
    '',
    'YOUR LENS: TERRAIN, COMPOSITION AND SCALE. Does this read as a real glacially-carved',
    'alpine basin - drainage, talus angles, concave run-outs, ridge and spur structure -',
    'or as fractal noise? Can you tell how big the mountain is? Is the set dressing',
    'present, well-placed and convincing? Compare against ' + ROOT + '/docs/TERRAIN_BRIEF.md:',
    'does it depict Soho Basin specifically, or generic mountains?',
  ].join('\n'), { label: 'critic:terrain', phase: 'Critique', schema: CRITIC_SCHEMA, effort: 'high' }),
])

const valid = critics.filter(Boolean)
const allBlockers = valid.flatMap((c) => c.blockers || [])
log('Critique: ' + valid.map((c) => c.verdict + '(' + c.score + ')').join(', ') + ' - ' + allBlockers.length + ' blockers')

const byFile = {}
for (const b of allBlockers) {
  const f = (b.file || '').trim()
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
    'parallel and your edits there would be lost or would break them. If a fix genuinely',
    'requires a change elsewhere, do what you can in your own file and report the rest',
    'under notFixed.',
    '',
    'Blockers assigned to your file, found by harsh art-direction critics grading against',
    'real Shredders reference frames:',
    '',
    JSON.stringify(byFile[f], null, 2),
    '',
    'Read first:',
    '  ' + ROOT + '/docs/ARCHITECTURE.md       - the module contract you must keep honouring',
    '  ' + ROOT + '/docs/ART_DIRECTION.md      - measured targets + 56-point checklist',
    '  ' + ROOT + '/docs/REFERENCE_ANALYSIS.md - what the real target actually looks like',
    '  ' + ROOT + '/docs/FINDINGS_R1.md        - previously recorded defects',
    '',
    'HARD RULES: zero external assets, everything procedural. Never Math.random() - use',
    'makeRng/Simplex from src/core/rng.js. Three.js r185, plain JS ESM, SI units, +Y up.',
    'Headless target is SwiftShader so keep it efficient, but it must scale up on real GPUs.',
    '',
    'Fix the ROOT CAUSE, not the symptom. Do not paper over an artefact by hiding it',
    'behind fog, shrinking it, or moving the camera away from it.',
    '',
    'VALIDATE before reporting: run',
    '  cd ' + ROOT + ' && npx vite build --outDir dist-fix' + i + ' --logLevel warn',
    'confirm it exits 0, then rm -rf ' + ROOT + '/dist-fix' + i + '. Do NOT run the',
    'screenshot harness - a verification agent does that after you, and concurrent runs',
    'collide on dist/.',
  ].join('\n'), {
    label: 'fix:' + f.split('/').pop(), phase: 'Fix', schema: FIX_SCHEMA,
    agentType: 'general-purpose', effort: 'high',
  })
)) : []

const okFixes = fixes.filter(Boolean)
log('Fixes: ' + okFixes.length + '/' + files.length + ' files repaired')

phase('Verify')

const verify = await agent([
  'You are verifying the fix round for "Soho Shred" at ' + ROOT + '.',
  '',
  'Fix agents just edited these files in parallel:',
  JSON.stringify(okFixes, null, 2),
  '',
  'TASK:',
  '1. cd ' + ROOT + ' && npx vite build --logLevel warn - fix every error until exit 0.',
  '   You may edit any file now; you are the only agent running.',
  '2. node tools/shoot.mjs --width 960 --height 540 --out shots/r4',
  '   Iterate until all 9 presets capture with ZERO console errors.',
  '3. Read the resulting PNGs with the Read tool. Confirm each blocker below is actually',
  '   resolved IN THE PIXELS - do not take the fix agents word for it. A fix that did not',
  '   change the image is not a fix.',
  '   Blockers: ' + JSON.stringify(allBlockers.map((b) => b.issue)),
  '4. node tools/compare.mjs --ours shots/r4 --out compare/r4',
  '5. git add -A and commit on branch claude/soho-shred-game-lgudxl. Do NOT push - push is',
  '   403-blocked by a GitHub App permission gap. Only commit if the build is green.',
  '',
  'Report which blockers are visually confirmed fixed, which are not, and any new',
  'problems the fixes introduced.',
].join('\n'), {
  label: 'verify', phase: 'Verify', agentType: 'general-purpose', effort: 'high',
  schema: {
    type: 'object',
    required: ['buildPassed', 'confirmedFixed', 'stillBroken'],
    properties: {
      buildPassed: { type: 'boolean' },
      confirmedFixed: { type: 'array', items: { type: 'string' } },
      stillBroken: { type: 'array', items: { type: 'string' } },
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
