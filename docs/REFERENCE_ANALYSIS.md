# Reference Analysis — measured from actual Shredders frames

Derived by direct inspection of the 21 official Shredders screenshots in
`reference/shredders/` (downloaded from the Steam store listing, appid 1874170;
kept out of git — they are copyrighted marketing assets used only as local
development reference).

This document outranks general web research: it describes what the target
**actually looks like**, pixel by pixel. Every visual workstream is accountable
to it, and critics grade against it.

## The single most important finding

**Shredders' snow is not heavily textured.** The most common failure mode when
chasing "AAA snow" is to pile on high-frequency normal detail, sparkle and
noise. Shredders does the opposite: large areas of snow are *smooth*, soft and
almost matte, with very gentle undulation. Its realism comes from four things,
in this order of importance:

1. **Lighting and shadow shape** — long, soft, blue-filled shadows that describe
   the terrain's form. The shadows do the modelling work, not the texture.
2. **Aerial perspective** — the far field collapses to low-contrast blue-grey.
3. **Sun glare / veiling bloom** — a large, soft, high-threshold glare.
4. **Silhouette and set dressing** — trees, lifts, poles, buildings, riders
   giving scale and breaking the white.

Surface texture is a distant fifth. Over-texturing snow is a *tell*, not a fix.

## Frame-by-frame notes

### `ref_19.jpg` — the closest analogue to our Soho Basin shots
Open mountain, sun in frame, mid-morning. This is the primary target for
`hero-basin` and `ridge-backlight`.

- **Sky**: strong vertical gradient. Deep saturated blue at top-left
  (~`#4A7FC1`), desaturating toward the horizon, and blowing out to near-white
  in a large radius around the sun. The blue is *rich*, not pale.
- **Sun**: not a hard disc — a soft white core with a wide, smooth veiling
  glare that bleeds several hundred pixels and washes across the cloud bank.
  Highlight rolloff is gradual; nothing reads as a clipped flat plateau.
- **Clouds**: dense banks *hugging the ridgelines*, lit from behind, with
  genuinely volumetric shading — bright rims, grey-blue cores, soft edges that
  dissolve into the slope. They sit *in* the terrain, not above it. This is a
  huge believability contributor and is usually missing from procedural scenes.
- **Aerial perspective**: the mid-distance slopes (left third) are very low
  contrast, shifted blue-grey, almost merging with the cloud. Near snow is
  bright white with real contrast. The value separation between near and far is
  enormous — this is what creates the sense of scale.
- **Snow surface**: smooth. Broad soft forms. Detail comes from long shadow
  shapes, a few drift lines, and occasional track scars — not from noise.
- **Foreground**: snow-laden buildings, bare frosted trees, a gondola cable and
  car. Strong dark silhouettes against white; they anchor the scale.

### `ref_05.jpg` — open piste with park features
- Overcast-bright / high thin cloud. Very high-key, low contrast overall.
- Distant ridges almost white-on-white, separated only by subtle value shifts.
- Snow shows **groomer corduroy** in the halfpipe and faint track striping on
  the open slope — subtle, low contrast, but present. Worth reproducing.
- Autumn-orange trees and red banners provide the only saturated colour: a few
  small, highly saturated accents against a desaturated field read as expensive.
- Riders are small in frame; their dark silhouettes give the slope its scale.
- Shadows here are soft-edged and low contrast (diffuse light), in contrast to
  the hard sun shadows of ref_02/ref_12.

### `ref_02.jpg` — hard bluebird sun, concrete + snow
- **Sky**: the deepest blue in the set, near `#1E5FAE` at the top, clean
  gradient, no haze. Bluebird = saturated, not pale.
- **Shadows**: crisp, hard-edged, and clearly **blue** (`#8FA6C8`-ish on snow) —
  lit only by the sky. The blue shadow is the single most recognisable snow
  lighting cue and must be reproduced.
- Snow is bright but **not clipped**: the sunlit faces hold detail rather than
  going to pure 255 white. Highlight rolloff is doing real work.
- Frost-laden trees read as near-white lace against the blue sky.
- Concrete has restrained detail: subtle streaking and staining, not busy grunge.

### `ref_12.jpg` — close third-person on the rider
- **Character quality bar**: separate helmet with a visible shell seam and a
  mirrored goggle lens, a backpack with straps and buckles, a jacket with real
  panel seams, zips, a chest pocket and a drawcord hem, gloves with knuckle
  darts, boots with lacing and a highback binding with ratchet straps, and a
  board with an actual printed graphic and a visible steel edge.
- Fabric shading is soft and slightly sheened — outerwear nylon, not cloth
  diffuse and not plastic. Subtle sheen at grazing angles.
- The rider's shadow is a crisp, correctly-shaped silhouette on the snow.
- Snow in the near field here **does** show fine granular texture and small
  wind ripples — so the detail exists, it is just reserved for close range and
  fades out fast with distance.

## Numeric targets extracted

| Quantity | Measured from reference |
| --- | --- |
| Sky zenith (bluebird) | deep saturated blue, ~`#1E5FAE`–`#4A7FC1` |
| Sky near horizon | pale desaturated blue-white, ~`#C8D8EA` |
| Sunlit snow | bright but sub-clipping, ~`#EDF1F6`, holds detail |
| Shadowed snow | distinctly blue, ~`#8FA6C8`–`#A8BCD8` |
| Shadow/sun value ratio | roughly 0.55–0.65, not 0.2 — sky fill is strong |
| Far ridge contrast | very low; near-far value separation is large |
| Saturated accents | few, small, high-chroma (orange/red) against desaturation |
| Sun glare radius | very wide and soft, hundreds of px at 1920 |

## Acceptance implications

A frame from Soho Shred should be rejected if:
- Shadows on snow are grey or black rather than blue.
- Sunlit snow clips to flat white with no detail.
- Distant ridges have the same contrast/saturation as near terrain.
- The sky is a flat colour or a weak washed-out gradient rather than a rich
  saturated vertical gradient.
- Snow is uniformly noisy/sparkly at all distances (over-texturing tell).
- There is no cloud interacting with the terrain.
- Nothing in frame gives scale — no props, no silhouettes, no tracks.
