# Dataset & Third-Party Attribution

## English-Vietnamese Lexical Dictionary (`dictionary_en_vi.db`)

EnglishCoach utilizes an offline, read-only SQLite English-Vietnamese lexical database (`dictionary_en_vi.db`) for the Vietnamese senses of dictionary lookups (single words since 2026-10-24, shown with this attribution) and multi-word lexical enrichment (idioms, expressions, phrasal verbs). EnglishCoach does not claim authorship of this lexical dataset.

- **Project / Dataset Name:** `english-vietnamese-dictionary` (`dictionary_en_vi.db`)
- **Source Repository:** [https://github.com/skypediacode/english-vietnamese-dictionary](https://github.com/skypediacode/english-vietnamese-dictionary)
- **Pinned Upstream Commit:** `388adc0826300912e5b0311c089e0e70494b065f`
- **License:** Creative Commons Attribution-ShareAlike 4.0 International ([CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/))

### Upstream Attribution & Lineage

> This SQLite dictionary database was created by [Skypedia](https://github.com/skypediacode) based on the [MinhQND Dictionary project](https://github.com/minhqnd/dictionary), with added learner-friendly example sentences and data validation using OVDP references. Originally sourced from Wiktionary and other open-source linguistic resources. Licensed under CC BY-SA 4.0.

- **Author / Maintainer:** Skypedia ([https://github.com/skypediacode](https://github.com/skypediacode)) (2026)
- **Primary Source:** MinhQND Dictionary ([https://github.com/minhqnd/dictionary](https://github.com/minhqnd/dictionary)) by minhqnd (CC BY-SA 4.0)
- **Reference Sources:**
  - OVDP (Open Vietnamese Dictionary Project, [https://sourceforge.net/projects/ovdp/](https://sourceforge.net/projects/ovdp/), GPLv2)
  - Wiktionary ([https://www.wiktionary.org](https://www.wiktionary.org), CC BY-SA 3.0 / CC BY-SA 4.0)
  - vntk/dictionary – Vietnamese dictionary data
  - Hồ Ngọc Đức's Vietnamese Dictionary Project – Vietnamese lexical resources
  - WikDict and open-dict-data (IPA pronunciation data)

### Usage in EnglishCoach
- Used exclusively as a read-only, local SQLite lexical provider (`LocalEnViLexicalProvider`) for offline Vietnamese lexical translation enrichment of trusted multi-word lexical entries (idioms, expressions, phrasal verbs).
- No modifications are made to the database at runtime.
- Also the source of the Vietnamese sense wordings and IPA of the curated SYSTEM topic decks (`backend/src/main/resources/data/decks/topic-*.json`, 2026-10-30); those deck files are a derived database shared under CC BY-SA 4.0.

## SYSTEM topic decks (Flashcards, 2026-10-30)

The curated topic decks (`topic-*.json`) combine the following sources; per-card provenance (dictionary sense, Tatoeba sentence ids, definition and CEFR source) is kept in each deck file (`source`) and in `docs/flashcards/vocabulary-universe-2026-10-30/manifest.json`. Build scripts and pinned hashes: `backend/scripts/flashcards/vocabulary/` (`sources.lock.json`).

- **Tatoeba** ([https://tatoeba.org](https://tatoeba.org)) — English example sentences and their human Vietnamese translations, exports of 2026-10-30. License: Creative Commons Attribution 2.0 France ([CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/)). Each sentence is credited to Tatoeba and its contributors; a sentence's page is `https://tatoeba.org/en/sentences/show/<id>` (ids in `source.tatoeba` as `[English id, Vietnamese id]`).
- **Open English WordNet 2025** ([https://en-word.net](https://en-word.net)) — part of speech, sense order and topic evidence; English definitions of words with a single sense. License: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (derived from Princeton WordNet, WordNet 3.0 license).
- **CEFR-J Vocabulary Profile 1.5** (Tono Laboratory, Tokyo University of Foreign Studies, via Open Language Profiles) — CEFR levels A1–B2; free for research and commercial use with citation: "CEFR-J Wordlist Version 1.5. Compiled by Yukio Tono, Tokyo University of Foreign Studies."
- **Octanove Vocabulary Profile C1/C2 1.0** (Open Language Profiles) — CEFR levels C1–C2. License: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

## TOEIC & IELTS Score-Banded SYSTEM decks (Flashcards, 2026-11-19)

The 9 curated score-banded exam decks (`backend/src/main/resources/data/decks/toeic-score-*.json` and `ielts-band-*.json`, 10,223 card associations total) combine the license-compatible open corpora below with the existing OEWN 2025, CEFR-J 1.5, Octanove C1/C2 1.0, `dictionary_en_vi.db`, and Tatoeba sources listed above. Per-card provenance (`source.datasets`, `source.signals`, `source.sourceCefr`, `source.sfi`, `source.confidence`, `source.license`) is recorded inside every deck JSON. Derived deck data is shared under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Non-commercial corpora (including EFLLex/CEFRLex under CC BY-NC-SA 4.0) were audited and excluded.

- **TOEIC Service List (TSL) v1.2** — Browne, C., & Culligan, B. ([https://www.newgeneralservicelist.com/toeic-list](https://www.newgeneralservicelist.com/toeic-list)). License: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- **New General Service List (NGSL) v1.2 & NGSL-SFI 31K** — Browne, C., Culligan, B., & Phillips, J. ([https://www.newgeneralservicelist.com](https://www.newgeneralservicelist.com)). License: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- **New Academic Word List (NAWL) v1.2** — Browne, C., Culligan, B., & Phillips, J. ([https://www.newgeneralservicelist.com/nawl-new-academic-word-list](https://www.newgeneralservicelist.com/nawl-new-academic-word-list)). License: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- **Business Service List (BSL) v1.20** — Browne, C., & Culligan, B. ([https://www.newgeneralservicelist.com/bsl-business-service-list](https://www.newgeneralservicelist.com/bsl-business-service-list)). License: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- **NGSL-Spoken (NGSL-S) v1.2** — Browne, C., Culligan, B., & Phillips, J. ([https://www.newgeneralservicelist.com/ngsl-spoken](https://www.newgeneralservicelist.com/ngsl-spoken)). License: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- **Note on Exam Framing:** Score bands (`TOEIC 10–990` and `IELTS 4.0–9.0`) are open-corpus difficulty progressions aligned via CEFR, frequency (SFI), and register signals for learner guidance; EnglishCoach does not claim official ETS or Cambridge/IDP/British Council endorsement or certification.

## Speaking Arena: Echo Whale monument (2026-11-19)

- **Low poly animated Cartoon Whale** by Blue Colossus Studio, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — the Echo model (`frontend/public/models/whale-e0569b41.glb`) posed, smoothed and glazed by `scripts/speaking/build_archipelago_assets.py` into the plaza sculpture in `archipelago-props-6ea5df8a29ce.glb`.

## Echo cast: hands and motion (Study Space, Speaking Arena)

- **MakeHuman** ([https://static.makehumancommunity.org](https://static.makehumancommunity.org)) — the geometry, joint positions and skin weights of the cast's hands derive from the MakeHuman base mesh and default rig. These assets are released under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Source files and licence text: `imports/sources-assets/owner-authored/speaking-arena/makehuman-cc0/`.
- **CMU Graphics Lab Motion Capture Database** ([http://mocap.cs.cmu.edu](http://mocap.cs.cmu.edu)) — the walking and running cycles are retargeted from takes 35_01 and 16_35. The database was created with funding from NSF EIA-0196217. It is free for all uses and may be included in products; it is never redistributed here as data, only as baked animation inside the character files.

## Echo cast: heads (Study Space, Speaking Arena)

- **CharMorph-Vitruvian** ([https://github.com/Upliner/CharMorph](https://github.com/Upliner/CharMorph)) — the base head mesh, its shape keys and the facial expressions of Lyra and Kai are built from the Vitruvian character's assets, released under CC0 1.0. The CharMorph add-on's own GPL code is not part of the product.

## Study Space: daily-life things and water (Echo Life 5.0, 2026-11-07)

- **Poly Haven** ([https://polyhaven.com](https://polyhaven.com)) — the models of the kettle, watering can, tea set (teapot, cup, saucer), spare light bulb and potted plant in `frontend/public/assets/study-space/study-life-<hash>.glb` are Poly Haven assets, released under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (no attribution required; credited here). Vintage Electric Kettle — SV Garip; Watering Can Metal 01 — Charles Nderitu; Tea Set 01 — James Ray Cock, Rico Cilliers, Jurita Burger; Lightbulb 01 — Josh Dean; Potted Plant 02 — Rico Cilliers. Stood on their base, turned, thinned and compressed for the browser by `docs/study-space/echo-life-5-20261107/art/{fetch_polyhaven.py,life_pack.py,optimize_life.sh}`.
- **jeantimex/fluid** ([https://github.com/jeantimex/fluid](https://github.com/jeantimex/fluid)), MIT License, Copyright (c) 2026 Su — the structure of the WebGPU compute passes of the room's water (`frontend/src/components/study-space/world/water/fluid.ts`: predicted positions, spatial hash, density and near-density, relaxation, velocities from positions) follows this project, itself ported from Sebastian Lague's Fluid-Sim (MIT). The method is double-density relaxation (Clavet, Beaudoin and Poulin, 2005). MIT notice: "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE."
- **three-mesh-bvh** ([https://github.com/gkjohnson/three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)), MIT License — the contact geometry of the hands (`frontend/src/lib/embodiment/grasp.ts`); an npm dependency, its notice ships with the package.

## Speaking Arena: Echo Archipelago v7 environment, vessels, underwater optics, and motion (2026-11-22)

All 56 content-hashed Zero-WASM 3D models (`LOD0` and `LOD1`), 12 tileable WebP PBR textures, and 3 environment skies in `frontend/public/speaking/arena/v7/` (`v7-manifest.json`, detailed per-file SHA-256 ledger in `docs/speaking-area-overhaul/06_ASSET_INVENTORY_AND_LICENSES.md`) derive exclusively from the permissive sources below:

- **English Coach Original Blender 4.2 Cycles OptiX Assets** (Project-Owned) — the curved coconut palm, stately royal palm, fruiting mango and banana trees, bougainvillea and hibiscus coastal shrubs, beach dune grass, Ha Long limestone karst spire and sea arch, cedar and woven-thatch Tropical Speaking Pavilion, coastal fishing stilt cottage, bamboo fruit and fish market stall, painted stone coastal lighthouse, clinker cedar skiff, traditional bamboo-canopy sampan, Pelagic/Tern/Cruiser motor launches, angling rod, bobber float, tropical fruit harvest pack, and seamless golden coral beach sand PBR maps are authored and GPU-baked by `scripts/speaking/build_archipelago_v7_assets.py` and optimized without WebAssembly decoders by `scripts/speaking/optimize_archipelago_v7_glb.mjs`.
- **Poly Haven** ([https://polyhaven.com](https://polyhaven.com)), [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) (no attribution required; credited here) —
  - 3D botanical and rock models adapted into `tree-tropical-banyan`, `tree-tropical-canopy`, `fern-tropical-cluster`, and `rock-coastal-cluster`: *Island Tree 01*, *Island Tree 02*, and *Fern 02* by Rob Tuytel and Rico Cilliers; *Boulder 01* by Rico Cilliers; *Rock 07* by Jenelle van Heerden.
  - 1K PBR surface maps adapted into `limestone_karst`, `wood_pier_weathered`, and `stone_harbor_travertine` in `frontend/public/speaking/arena/v7/pbr/`: *Concrete Wall 007* by Dario Barresi, Rico Cilliers, and Charlotte Baglioni; *Oak Veneer 01* by Jenelle van Heerden; *Concrete Pavers 02* by Amal Kumar.
  - 1K equirectangular sky environments in `frontend/public/speaking/arena/v7/env/`: *Clarens Midday* by Dimitrios Savva and Jarod Guest; *Belfast Sunset (Pure Sky)* by Greg Zaal, Dimitrios Savva, and Jarod Guest.
- **Kenney Watercraft Kit 2.1** ([https://kenney.nl/assets/watercraft-pack](https://kenney.nl/assets/watercraft-pack)) by Kenney, [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) (no attribution required; credited here) — base hull proportions of `boat-fishing-small.glb` and `boat-sail-a.glb` rebuilt with custom timber superstructures, gantry rigging, trawl nets, cambered sails, and Cycles OptiX 1K PBR bakes in `vessel-trawler` and `vessel-sailboat`.
- **Low poly animated Cartoon Whale** by Blue Colossus Studio, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — the project's Echo Whale (`frontend/public/models/whale-e0569b41.glb`) remeshed to under 6,500 triangles (`LOD0`) and 1,650 triangles (`LOD1`) and baked with aged bronze and verdigris patina in `harbor-whale-monument`.
- **Noniv/abyssal-garden** ([https://github.com/Noniv/abyssal-garden](https://github.com/Noniv/abyssal-garden)), MIT License, Copyright (c) Maksymilian Dendura (`Noniv`) — architectural reference for procedural underwater caustics, volumetric light shafts, kelp/coral sway, and marine boids schooling ported cleanly into English Coach's WebGL2 Three.js architecture. MIT notice: "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE."
- **CMU Graphics Lab Motion Capture Database** ([http://mocap.cs.cmu.edu](http://mocap.cs.cmu.edu)) — swimming, rowing, ladder-climb, and coastal casting motion references (Subjects 79, 80, 125, 126, 141; funded by NSF EIA-0196217). Free for all academic and commercial uses; never redistributed as raw `.bvh` capture files, only as retargeted skeletal animation tracks.
- **pixiv/three-vrm** ([https://github.com/pixiv/three-vrm](https://github.com/pixiv/three-vrm)), MIT License, Copyright (c) pixiv Inc., and **pmndrs/ecctrl** ([https://github.com/pmndrs/ecctrl](https://github.com/pmndrs/ecctrl)), MIT License, Copyright (c) Erdong Chen — clean-room mathematical reference for world-space Verlet secondary spring chains and floating-capsule slope/platform locomotion.

