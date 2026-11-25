# Garden and Rush discovery key art

Owner supplied Image A (Garden) and Image B (Rush) on 2026-10-11 for this card redesign. The supplied compositions are used directly. No gameplay screenshots, additional generated art or runtime rendering is involved. Original PNGs are preserved in the source paths below. These assets do not change gameplay atlases or the Garden world.

Both masters are 1672x941 pixels. Encoded with existing Sharp 0.35.3, WebP quality 90 / effort 6, preserving dimensions, composition and color. No crop, resize, overlays or retouching. Runtime wrappers retain the same aspect ratio with cover sizing.

Garden original: `imports/sources-assets/owner-authored/echo-garden-card/key-art.png`
SHA256: `47e27b9b6d3b45b2f96fb09c73007ea1a1b4294d05047c7d103b87a224ff64a4`

Garden runtime: `frontend/public/games/echo-garden/key-art.webp` (400638 bytes)
SHA256: `e53f937ad9aeb71b786fe4fcba10e7932374fdf137fea977038fcf696f8ccd44`

Rush original: `imports/source-assets-rush/owner-authored/echo-quiz-rush/card-key-art.png`
SHA256: `a2330f56e1abb712ef5cec61790b101922cc4d91c7bec45bb6f1a92c95450b4b`

Rush runtime: `frontend/public/games/echo-quiz-rush/key-art.webp` (389540 bytes)
SHA256: `d4ba438affe523558fffda35e4b525546f765d914ce54f84daf7f212c13786d9`

Reproduction: load each original with the frontend's installed Sharp, call .webp({quality:90,effort:6}).toFile(runtimePath).

Word Chain original: `imports/source-assets-word-chain/owner-authored/word-chain/card-key-art.jpg`
SHA256: `656cc4df9bae856d8601ae044dc05e4d144660cca24c42731b9f05c07638d1a6`

Word Chain runtime: `frontend/public/games/word-chain/key-art.webp` (153968 bytes)
SHA256: `ef5ff02e5d8e0fb08c79118fcc609db38d68398d32932b8b94c1c3ba151f6ac1`

Card Blast original: `imports/source-assets-card-blast/owner-authored/card-blast/card-key-art.jpg`
SHA256: `b9071f85d5b03b84de034583e991874a0e285a5f00ba9625a00951bc5d35c387`

Card Blast runtime: `frontend/public/games/card-blast/key-art.webp` (175530 bytes)
SHA256: `76babad30439fdd87cae10cf4dd60a1a8861ec981155749e31a7739f3091326e`

Hangman original: `imports/source-assets-hangman/owner-authored/hangman/card-key-art.png`
SHA256: `fddd0a4561dad3a6a6f706d94895ba58e8307e1b6248b7d1247bedac1b8b2af9`

Hangman runtime: `frontend/public/games/hangman/key-art.webp` (271176 bytes)
SHA256: `27184f2a837c09a61b8a4f07357f3a3735639efb6de7583577e2428d3605bd19`

Hero Whale original: `imports/source-assets-hero/owner-authored/hero/games-hero-key-art.png` (1584524 bytes)
SHA256: `33e6125b603eb2258121e9275a7f25989b68b9fe85b65b689ca68a07b9eb9d35`

Hero Whale runtime: `frontend/public/games/hero-whale-key-art.webp` (120056 bytes)
SHA256: `3a08c759474c9c232b0754dfca99ff4ebdde073768294cc8e1db1d9b495ecac7`

Validation and local/production boundaries: docs/operations/card-community-20261011/REPORT.md.

King Of English (2026-10-25, "Royal Rebirth"): original renders built from code — no generated, downloaded or owner-supplied picture.
Source: `docs/king-of-english/royal-rebirth-2026-10-25/art/` (Blender 4.2 scenes `scene_poster.py`, `scene_mode.py`; logotype composed by
`compose.py` in Quicksand Bold, SIL OFL 1.1; Echo = `frontend/public/models/whale.glb`, CC BY 4.0, credit kept). Runtime files under
`frontend/public/games/king-of-english/` carry the first 10 hex of their SHA256 in the name (key-art, hero, crown, mode-reflex,
mode-meaning, mode-chain, mode-conquest); manifest `frontend/src/components/features/games/king-of-english/kingArt.ts`.
