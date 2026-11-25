# Mascot 3D Assets Directory

This directory is designated for the official 3D mascot model of English Coach.

## Served name (content-versioned)
- The landing page loads `whale-<first 8 hex of the file's SHA-256>.glb` (currently `whale-e0569b41.glb`, named in
  `src/components/landing/ocean/echoAssets.ts`). Browsers keep `.glb` files for a year (Nginx) and Cloudflare caches
  `/models/*.glb` at the edge, so a changed model MUST ship under a new name — never replace a file in place.
  `npm run test:mascot-interaction` checks the name against the content.
- After a model change: add the new hashed file, update `ECHO_MODEL_URL`, re-render the standby still
  (`node scripts/render-echo-still.cjs`, then update `ECHO_STILL`). Keep older files for pages already open.
- `whale.glb` is the same bytes under the pre-2026-10-16 name (pages loaded before the rename still request it).

## Expected Asset
- **Filename**: `whale.glb`
- **Path**: `frontend/public/models/whale.glb`
- **URL**: `http://localhost:3000/models/whale.glb`
- **Target Model**: Low poly animated Cartoon Whale by Blue Colossus Studio
- **Source**: https://sketchfab.com/3d-models/low-poly-animated-cartoon-whale-4016a2fa3b4a4960a660ec65f2939470
- **License**: Creative Commons Attribution (CC BY 4.0)
- **Geometry**: 1,664 polygons, 832 vertices
- **Animations**: Looping idle, run/swim, dying, blinking blendshape

## Dynamic Activation & Fallback Priority
The English Coach `LandingMascotScene` implements a strict production priority:
1. **Priority 1 (Production)**: When `whale.glb` is placed in this directory, the application automatically loads, frames, and animates the official Blue Colossus Studio Cartoon Whale using `WhaleGLBLoader`.
2. **Priority 2 (Production Fallback)**: Matching 2D Echo fallback (`MascotFallback`) if WebGL or the GLB asset fails to load.
3. **Priority 3 (Development Only)**: `WhaleProceduralModel` strictly as a temporary development placeholder during offline asset integration.

## Legal Download Instructions
To legally acquire this asset from Sketchfab under CC BY:
1. Log into your Sketchfab account.
2. Navigate to https://sketchfab.com/3d-models/low-poly-animated-cartoon-whale-4016a2fa3b4a4960a660ec65f2939470
3. Click "Download 3D Model" and choose glTF or FBX.
4. Place the resulting `whale.glb` in this directory (`frontend/public/models/whale.glb`).
Alternatively, provide a Sketchfab API Token from https://sketchfab.com/settings/password to fetch it via the official API.
