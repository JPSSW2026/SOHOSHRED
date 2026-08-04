export const meta = {
  name: 'soho-shred-round7-score',
  description: 'Round 7: majesty + playability lenses on the cycle-1 evidence set (kickers, tricks, inversion-deck backdrop)',
  phases: [{ title: 'Critique', detail: 'three lenses over shots/r15 + measured telemetry' }],
}

const ROOT = '/home/user/SOHOSHRED'

phase('Critique')

const SCHEMA = {
  type: 'object',
  required: ['verdict', 'score', 'blockers'],
  properties: {
    verdict: { type: 'string', enum: ['AAA', 'CLOSE', 'NOT_AAA', 'BROKEN'] },
    score: { type: 'number' },
    strongest: { type: 'array', items: { type: 'string' } },
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
  'You are a brutally harsh art/design director reviewing the in-development Three.js',
  'game "Soho Shred" (Soho Basin, Cardrona NZ) against the shipped game "Shredders".',
  'This is round 7. The user\'s standing directive for this cycle: "I want majestic',
  'feeling and better playability to be the defining characteristic."',
  '',
  'Evidence set in ' + ROOT + '/shots/r15/ :',
  '  bd-on.png       — headwall vantage, painted backdrop over inversion deck',
  '  bd-off.png      — same vantage, painted model hidden (procedural wall only)',
  '  bd-ride.png     — ride-height vantage down-valley',
  '  kicker-*.png    — wind-lip kicker approach + two mid-air chase frames',
  '  close-*.png     — close-ups: indy grab, backflip at two phases',
  '  portrait-check.png — the LOCKED rider portrait (do not re-litigate the kit)',
  '',
  'Measured telemetry (do not re-measure): 3 wind-lip kickers on the top section;',
  'tucked rider (~20 m/s) airs all three (1.65 s / 38 m carry, 0.9 s / 19 m,',
  '0.9 s / 17 m); tricks land, name and score end-to-end ("Indy" 126 pts,',
  '"Backflip" 587 pts clean); stall rescue fires at 3.0 s; full-body flip rotation',
  'renders on the mesh.',
  '',
  'LOCKED (user-approved, DO NOT flag): black kit + silver-in-sun exposure physics,',
  'lighting/glare/veil, untracked pure powder, fog deck treatment direction,',
  'art-treated painted backdrop direction.',
  '',
  'Score 10 = indistinguishable from Shredders footage. Every blocker names the',
  'exact file and a concrete fix. Ownership: terrain/kickers -> src/world/terrain.js;',
  'snow/rock shading -> src/world/snowMaterial.js; sky/aerial/deck -> src/world/sky.js;',
  'painted backdrop mount -> src/world/backdropModel.js; rider mesh/garments ->',
  'src/player/rider.js; physics/flips -> src/player/physics.js; trick scoring ->',
  'src/player/tricks.js; camera -> src/player/camera.js; post -> src/fx/postprocess.js.',
].join('\n')

const critics = await parallel([
  () => agent(BASE + '\n\nYOUR LENS: MAJESTY. Does the world feel vast, alpine, awe-inspiring —'
    + ' like standing above an inversion in the Southern Alps? Judge the backdrop scale/tone/'
    + ' composition, the inversion deck, the sense of altitude and distance, and what single'
    + ' change would add the most grandeur. Compare bd-on vs bd-off to judge what the painted'
    + ' model adds and where the blend still tells.',
    { label: 'critic:majesty', phase: 'Critique', schema: SCHEMA, model: 'sonnet', effort: 'high' }),
  () => agent(BASE + '\n\nYOUR LENS: PLAYABILITY-ON-CAMERA. Judge what the kicker/trick frames'
    + ' say about moment-to-moment fun: air readability (can you tell you are airborne and how'
    + ' high), kicker legibility on approach (does the lip read as a jump you would aim for),'
    + ' trick pose quality (grab reach, flip silhouette), landing zones. Name the highest-impact'
    + ' fix for game-feel legibility.',
    { label: 'critic:playability', phase: 'Critique', schema: SCHEMA, model: 'sonnet', effort: 'high' }),
  () => agent(BASE + '\n\nYOUR LENS: ARTEFACTS & COHERENCE. Any rendering artefact is'
    + ' automatically critical: seams, floating geometry, alpha-sorting tells on the transparent'
    + ' backdrop floor, silhouette shredding on the far wall, LOD pops frozen in stills, shadow'
    + ' acne, banding. Sweep every frame at 100% crop discipline.',
    { label: 'critic:artefacts', phase: 'Critique', schema: SCHEMA, model: 'sonnet', effort: 'high' }),
])

const ok = critics.filter(Boolean)
return {
  scores: ok.map(c => ({ verdict: c.verdict, score: c.score })),
  strongest: ok.flatMap(c => c.strongest || []),
  blockers: ok.flatMap(c => c.blockers).sort((a, b) =>
    ({ critical: 0, major: 1, minor: 2 })[a.severity] - ({ critical: 0, major: 1, minor: 2 })[b.severity]),
}
