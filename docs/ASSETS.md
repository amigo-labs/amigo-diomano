# Third-party assets

HANDOFF §7.5: everything is procedural, and **if an asset is needed, CC0
only**. This file is the ledger of the assets that clause has admitted, so the
licence story stays checkable. If it is not listed here, it does not ship.

## Surface textures (`web/public/tex/`)

Source: [ambientCG](https://ambientcg.com), licensed
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain,
no attribution required — recorded here anyway so provenance never depends on
memory).

| File | ambientCG asset | Used for | Mean | 1 / mean |
|---|---|---|---|---|
| `rock.webp` | Rock035 | rock material, cliff faces (slope band) | 0.092 | 10.90 |
| `grass.webp` | Ground037 | meadow structure (luminance only, hue stays authored) | 0.556 | 1.80 |
| `sand.webp` | Ground054 | sand material, beach band | 0.551 | 1.81 |
| `dirt.webp` | Ground024 | soil / ash / swamp base | 0.409 | 2.44 |
| `snow.webp` | Snow010A | snow cap structure (luminance only) | 0.924 | 1.08 |

**The mean matters, and it is why the reciprocal is recorded here.** The shader
divides each map by its own mean before using it, so what reaches the palette is
a field centred on 1.0 — structure — rather than the map's absolute brightness.
It did not always: a single gain tuned for the bright maps was applied to all
five, and rock at a sixth of their brightness therefore came out at about a
fifth of its authored colour. Where a fragment was *pure* rock with nothing to
blend against, that rounded to black — the black ring around every spawn
pedestal, which had been recorded as a suspected NaN for several phases and was
this all along. **Replacing a map means re-measuring its mean and updating both
this table and `dioTexDetail`'s constants in `planet.ts`.**

The means are the average of the decoded RGB over the whole file, weighted
0.299 / 0.587 / 0.114.

Pipeline: the 1K JPG colour maps, resized to 512² and encoded as WebP
(quality 0.82). ~285 KB total — inside §7.5's 3 MB payload budget without
needing the KTX2 machinery, which for five small colour maps would cost more
in transcoder payload than it saves. Revisit KTX2 if the set grows or normal
maps join it.

Integration (`web/src/renderer/planet.ts`): triplanar projection — the
quadsphere has no UV atlas, by §7.3's own design — with the textures applied
as *structure over the authored palette*, never as replacement colours, so
the game's colour script survives. `uTexMix` stays 0 until all five maps have
loaded; until then the shading is the purely procedural fallback, and the
title card covers the load in practice. No simulation impact of any kind:
textures live entirely on the render side of the §10 wall.
