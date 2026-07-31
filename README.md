# block

One block a day from an [Are.na](https://www.are.na) channel.

A block is the atomic value of each save on Are.na. Every day at local midnight this site picks one image block from a channel — deterministically, from the date — and becomes it:

- the page background is a quiet monochromatic tint of the image's dominant colour (eyedropped from the pixels, not a histogram average), light or dark depending on the image's own mood
- the block's metadata (title · added · modified · by · dimensions) sits across the footer; the image and title link to the block on Are.na, the author links to their profile
- the Open Graph preview is the image itself with a centered square — the block — set white or black by the luminance beneath it
- the favicon is a square of the day's dominant colour

The original lives at [block.ravivasavan.com](https://block.ravivasavan.com), fed by the [Aesthetic](https://www.are.na/ravi-vasavan/aesthetic-v0r0rusrlfq) channel.

## Make your own

Everything personal is configuration — no code changes needed to point this at your channel.

**1. Fork this repo** (or use it as a template).

**2. Get an Are.na personal access token.** Go to [dev.are.na](https://dev.are.na), sign in, create a new application, and copy the personal access token it gives you. Public and closed channels are readable without one, but a token avoids rate limits and is required for private channels.

**3. Add the token as a secret.** In your repo: *Settings → Secrets and variables → Actions → New repository secret*, named `ARENA_ACCESS_TOKEN`. Or with the CLI:

```sh
gh secret set ARENA_ACCESS_TOKEN
```

**4. Point it at your channel** with repository *variables* (same settings page, "Variables" tab, or `gh variable set …`):

| Variable | What it is | Example |
|---|---|---|
| `ARENA_CHANNEL` | Your channel's slug — the last part of its URL on are.na | `aesthetic-v0r0rusrlfq` |
| `SITE_URL` | Where the site will live. Drives the og tags; a non-`github.io` host also writes the `CNAME` file for a custom domain | `https://block.example.com` or `https://you.github.io/block` |
| `SITE_TZ` | IANA timezone whose midnight flips the day's block | `Europe/London` |

**5. Enable GitHub Pages.** *Settings → Pages → Source: GitHub Actions.*

**6. Run it.** Push to `main`, or *Actions → deploy → Run workflow*. The schedule in [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) rebuilds daily — adjust the cron to shortly after midnight in *your* timezone (it's UTC).

**7. (Optional) Custom domain.** Add a DNS `CNAME` record pointing your subdomain at `<username>.github.io`, then set the domain under *Settings → Pages*. `SITE_URL` takes care of the `CNAME` file in the deploy.

## Local build

```sh
npm install
ARENA_ACCESS_TOKEN=your-token ARENA_CHANNEL=your-channel npm run build
open dist/index.html
```

All output is static — `dist/` is the whole site.

## How the daily pick works

`scripts/build.mjs` hashes today's date (FNV-1a) modulo the channel's block count, walking forward past non-image blocks. Same date → same block, no state to store. Colour comes from a pixel scan: hues binned by colourfulness and scored over a 75° window, so a broad field of colour beats a small bright accent. Gifs are served from the original file (Are.na's resized renditions are stills).

## Notes

- **Font:** the type is [Labil Grotesk](https://www.letterboxtype.com) by Letterbox, licensed to Ravi Vasavan — it is *not* covered by this repo's licence. If you fork, swap `assets/fonts/` for a face you have rights to and update the `@font-face` block in `scripts/build.mjs` (the site falls back to `system-ui` cleanly).
- Only `Image` blocks are shown; text, link, and attachment blocks are skipped.
- The Are.na API in use is [v3 REST](https://www.are.na/developers/explore).
