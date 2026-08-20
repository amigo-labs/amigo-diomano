# Third-party assets

HANDOFF §7.5: everything is procedural, and **if an asset is needed, CC0
only**. This file is the ledger of the assets that clause has admitted, so the
licence story stays checkable. If it is not listed here, it does not ship.

## Surface textures (`web/public/tex/`)

Source: [ambientCG](https://ambientcg.com), licensed
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain,
no attribution required — recorded here anyway so provenance never depends on
memory).

| File | ambientCG asset | Used for |
|---|---|---|
| `rock.webp` | Rock035 | rock material, cliff faces (slope band) |
| `grass.webp` | Ground037 | meadow structure (luminance only, hue stays authored) |
| `sand.webp` | Ground054 | sand material, beach band |
| `dirt.webp` | Ground024 | soil / ash / swamp base |
| `snow.webp` | Snow010A | snow cap structure (luminance only) |

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
