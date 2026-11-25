# Echo Anywhere (browser extension)

Chrome / Edge (desktop) Manifest V3 companion of English Coach. Architecture overview: [`docs/architecture/overview.md`](../../docs/architecture/overview.md).

- Source: `src/` (plain modules, no dependencies, no bundler). `manifest.base.json` (the build fills the site origin).
- Build: `node build.mjs` → `dist/unpacked/` (dev id `kfepndgiddgljieglnilcaadlcgmdghj`, pinned by `dev-key.public.json`) and the store zips in `dist/store/` (no `key`). Local test build: `node build.mjs --site https://englishcoach.io.vn:18443 --grant en.wikipedia.org,github.com --out <dir>` (open shadow root + pre-granted test hosts; never ship it).
- Store pack: `store/LISTING.md`.
- Try it unpacked: Edge → `edge://extensions` → Developer mode → Load unpacked → `dist/unpacked`. Google Chrome 137+ only loads unpacked extensions from its own extensions page (Developer mode → Load unpacked).
