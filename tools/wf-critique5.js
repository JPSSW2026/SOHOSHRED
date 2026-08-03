export const meta = {
  name: 'soho-shred-round5-score',
  description: 'Round 5: blind A/B on r12 after sunlit rider line, spray, garments, LAW-2 bounce gate - scoring only',
  phases: [{ title: 'Critique', detail: 'blind A/B + 56-point checklist on r12' }],
}

const ROOT = '/home/user/SOHOSHRED'

phase('Critique')

const SCHEMA = {
  type: 'object',
  required: ['blindCall', 'verdict', 'score', 'blockers'],
  properties: {
    blindCall: { type: 'string' },
    blindCorrect: { type: 'boolean' },
    hesitated: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', enum: ['AAA', 'CLOSE', 'NOT_AAA', 'BROKEN'] },
    score: { type: 'number' },
    blockers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['issue', 'file', 'severity', 'fix'],
        properties: {
          issue: { type: 'string' }, file: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          fix: { type: 'string' },
        },
      },
    },
  },
}

const BASE = [
  'You are a brutally harsh art director doing a blind comparison of the in-development',
  'Three.js game "Soho Shred" (Soho Basin, Cardrona NZ) against the shipped game',
  '"Shredders". This is scoring round 3, after seven verified single-defect fixes:',
  'the bluff venetian-blind comb, the contour-parallel corduroy (rock-shader foliation',
  'moire), wedding-cake tors, pen-scribble sastrugi, mid-field shadows (a 240 m cap',
  'meant NOTHING past 240 m ever cast a shadow - now adaptive to 900 m), rider stance,',
  'and per-setup exposure metering. Judge r12 as it is - stale memories of earlier',
  'rounds do not apply.',
  '',
  'STEP 1 - BLIND. Read the pairs in ' + ROOT + '/compare/r12/ (pair-*.png, panels A/B,',
  'one ours one Shredders). Commit calls for ALL NINE pairs BEFORE opening',
  'ANSWER_KEY.json. For each: which is ours, what gave it away, and - critically -',
  'whether you HESITATED. List pairs where the call took real inspection in `hesitated`.',
  'Then open the key and report accuracy honestly.',
  '',
  'STEP 2 - GRADE ' + ROOT + '/shots/r12/ against the 56-point checklist at the end of',
  ROOT + '/docs/ART_DIRECTION.md and its section-1 measured targets. Use',
  ROOT + '/tools/measure.mjs and ' + ROOT + '/tools/banding.mjs (node) rather than',
  'eyeballing numbers. Score 10 = indistinguishable. Every blocker names the exact',
  'file and a concrete fix.',
  '',
  'Ownership: terrain/LOD -> src/world/terrain.js; snow+rock shading ->',
  'src/world/snowMaterial.js; sky/sun/cloud/aerial/shadow -> src/world/sky.js;',
  'rocks/poles/fences/lift -> src/world/props.js; post -> src/fx/postprocess.js;',
  'exposure -> src/core/config.js; rider -> src/player/rider.js; spray ->',
  'src/fx/particles.js; framing -> src/core/shots.js.',
].join('\n')

const critics = await parallel([
  () => agent(BASE + '\n\nYOUR LENS: lighting, atmosphere, colour, post, shadow quality.',
    { label: 'critic:lighting', phase: 'Critique', schema: SCHEMA, effort: 'high' }),
  () => agent(BASE + '\n\nYOUR LENS: surfaces, materials, artefacts. Any rendering artefact is automatically critical.',
    { label: 'critic:material', phase: 'Critique', schema: SCHEMA, effort: 'high' }),
  () => agent(BASE + '\n\nYOUR LENS: terrain believability, composition, rider and FX quality.',
    { label: 'critic:terrain-character', phase: 'Critique', schema: SCHEMA, effort: 'high' }),
  () => agent(BASE + '\n\nYOUR LENS: the rider as a character — stance (must read regular, left foot'
    + ' forward), garment/material credibility, pose dynamics, silhouette at gameplay distance. Also'
    + ' read ' + ROOT + '/shots/demo-frames/f0060.png, f0100.png, f0130.png, f0180.png as motion'
    + ' samples and judge whether the riding itself would pass for Shredders footage.',
    { label: 'critic:rider-motion', phase: 'Critique', schema: SCHEMA, effort: 'high' }),
  () => agent(BASE + '\n\nYOUR LENS: none — you are the generalist whose only job is the blind test.'
    + ' Spend your entire effort on the A/B pairs: for each one, list the exact pixel evidence that'
    + ' betrays the render, ranked by how fast it reads. The team fixes whatever you name first.',
    { label: 'critic:blind-tells', phase: 'Critique', schema: SCHEMA, effort: 'high' }),
])

const valid = critics.filter(Boolean)
log('Scores: ' + valid.map((c) => c.verdict + '(' + c.score + ')').join(', '))
return {
  critique: valid.map((c) => ({
    verdict: c.verdict, score: c.score, blindCorrect: c.blindCorrect,
    hesitated: c.hesitated, blindCall: c.blindCall,
    blockers: c.blockers,
  })),
}
