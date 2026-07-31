# block

One block a day from [Aesthetic](https://www.are.na/ravi-vasavan/aesthetic-v0r0rusrlfq), an Are.na channel by Ravi Vasavan.

A block is the atomic value of each save on Are.na. Every day at Melbourne midnight this site picks one image block from the channel — deterministically, from the date — and becomes it: the page background is a quiet monochromatic tint of the image's dominant colour, light or dark depending on the image's own mood. The block's metadata sits across the footer. Clicking the image takes you to the block.

Live at [block.ravivasavan.com](https://block.ravivasavan.com).

## How it works

- `scripts/build.mjs` calls Are.na's [v3 REST API](https://www.are.na/developers/explore), hashes today's date (FNV-1a) to pick a block, samples the image with [sharp](https://sharp.pixelplumbing.com) for dominant colour and brightness, and writes a fully static page to `dist/`.
- `.github/workflows/deploy.yml` rebuilds daily (14:05 UTC ≈ 00:05 Melbourne) and deploys to GitHub Pages.
- The Are.na access token lives in the `ARENA_ACCESS_TOKEN` repository secret.

## Local build

```sh
npm install
ARENA_ACCESS_TOKEN=… npm run build
open dist/index.html
```
