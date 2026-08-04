/**
 * block — one block a day from an Are.na channel.
 *
 * Fetches the channel via Are.na's v3 REST API and picks one image block per
 * day, deterministically from the date. The channel's block count sets the
 * depth of history: N blocks → N days, scrubbable via the timeline ruler at
 * the top edge. Each day's dominant colour and mood (light/dark) are sampled
 * at build time (cached in .cache/ between runs) and the whole history is
 * baked into a fully static page in dist/. Runs daily via GitHub Actions.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// Configuration — all via environment so forks never edit code:
//   ARENA_CHANNEL      Are.na channel slug (the bit after are.na/<user>/…)
//   ARENA_ACCESS_TOKEN personal access token from dev.are.na (only needed
//                      for private channels; public/closed channels work
//                      without one)
//   SITE_URL           canonical URL, e.g. https://block.example.com — used
//                      for og tags, and a CNAME file is written when it's a
//                      custom (non-github.io) domain
//   SITE_TZ            IANA timezone whose midnight flips the day's block
//   SITE_EPOCH         YYYY-MM-DD the site launched. History accumulates one
//                      day at a time from this date (launch day shows a
//                      single block) until it reaches the channel's block
//                      count. Omit for full-depth history immediately.
//   FONT_URL           optional .woff2 URL fetched at build time and
//                      self-hosted from the site; omit to use system-ui
const CHANNEL = process.env.ARENA_CHANNEL || "aesthetic-v0r0rusrlfq";
const API = "https://api.are.na/v3";
const TOKEN = process.env.ARENA_ACCESS_TOKEN;
const SITE_URL = (process.env.SITE_URL || "").replace(/\/+$/, "");
const TZ = process.env.SITE_TZ || "Australia/Melbourne";
const EPOCH = process.env.SITE_EPOCH || "";
const FONT_URL = process.env.FONT_URL || "";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const cacheFile = path.join(root, ".cache", "palettes.json");

async function api(url) {
  const res = await fetch(url, {
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    })
  );
  return results;
}

// ---------------------------------------------------------------------------
// Picks — FNV-1a over each local date, so every day of history is stable and
// today's choice flips at local midnight. N blocks in the channel → N days
// of history ending today.

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()); // YYYY-MM-DD
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

async function fetchAllBlocks() {
  const channel = await api(`${API}/channels/${CHANNEL}`);
  const total = channel.counts.contents;
  if (!total) throw new Error("Channel is empty");
  const blocks = [];
  for (let page = 1; blocks.length < total; page++) {
    const { data } = await api(
      `${API}/channels/${CHANNEL}/contents?per=100&page=${page}`
    );
    if (!data?.length) break;
    blocks.push(...data);
  }
  return { channel, blocks };
}

function pickForDate(date, blocks) {
  let index = fnv1a(date) % blocks.length;
  // Walk forward (wrapping) until we land on an image block.
  for (let tries = 0; tries < Math.min(blocks.length, 40); tries++) {
    const block = blocks[(index + tries) % blocks.length];
    if (block?.type === "Image" && block.image?.src) return block;
  }
  return null;
}

function datesEndingToday(n) {
  const [y, m, d] = today().split("-").map(Number);
  const base = Date.UTC(y, m - 1, d);
  return Array.from({ length: n }, (_, i) =>
    new Date(base - (n - 1 - i) * 86400000).toISOString().slice(0, 10)
  );
}

// ---------------------------------------------------------------------------
// Colour — dominant hue from the image, tinted near-white or near-black
// depending on the image's own brightness (its mood).

function rgbToHsl(r, g, b) {
  (r /= 255), (g /= 255), (b /= 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) {
    case r: h = (g - b) / d + (g < b ? 6 : 0); break;
    case g: h = (b - r) / d + 2; break;
    default: h = (r - g) / d + 4;
  }
  return { h: h * 60, s, l };
}

const hsl = (h, s, l) => `hsl(${h.toFixed(1)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%)`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

async function paletteFrom(buffer) {
  // Eyedrop the image ourselves: sharp's stats().dominant averages a coarse
  // histogram and lands on washed-out midtones. Instead, bin every pixel's
  // hue weighted by its colourfulness (chroma), and take the strongest hue
  // with its true average saturation.
  const { data, info } = await sharp(buffer)
    .resize(96, 96, { fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const BINS = 24;
  const w = new Array(BINS).fill(0);
  const sx = new Array(BINS).fill(0); // hue as unit vectors, weight-summed
  const sy = new Array(BINS).fill(0);
  const ss = new Array(BINS).fill(0);
  const sr = new Array(BINS).fill(0);
  const sg = new Array(BINS).fill(0);
  const sb = new Array(BINS).fill(0);
  let lumaSum = 0;
  const n = info.width * info.height;

  for (let i = 0; i < n; i++) {
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    lumaSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const { h, s, l } = rgbToHsl(r, g, b);
    const colorfulness = s * (1 - Math.abs(2 * l - 1)); // ≈ chroma
    if (colorfulness < 0.03) continue;
    const bin = Math.floor((h / 360) * BINS) % BINS;
    const rad = (h * Math.PI) / 180;
    w[bin] += colorfulness;
    sx[bin] += Math.cos(rad) * colorfulness;
    sy[bin] += Math.sin(rad) * colorfulness;
    ss[bin] += s * colorfulness;
    sr[bin] += r * colorfulness;
    sg[bin] += g * colorfulness;
    sb[bin] += b * colorfulness;
  }

  const luma = lumaSum / n;
  const mood = luma < 118 ? "dark" : "light";

  // A hue family is wide (~75°), so score a ±2-bin window; narrower windows
  // let a compact accent (orange stars) outvote a broad field (hot pink).
  const OFFSETS = [-2, -1, 0, 1, 2];
  const score = w.map((_, i) =>
    OFFSETS.reduce((acc, o) => acc + w[(i + o + BINS) % BINS], 0)
  );
  const best = score.indexOf(Math.max(...score));
  const win = OFFSETS.map((o) => (best + o + BINS) % BINS);
  const sum = (arr) => win.reduce((acc, i) => acc + arr[i], 0);
  const wSum = sum(w);

  const colourful = wSum / n > 0.02; // else effectively grayscale
  const h = colourful
    ? ((Math.atan2(sum(sy), sum(sx)) * 180) / Math.PI + 360) % 360
    : 0;
  const s = colourful ? sum(ss) / wSum : 0;
  const dominant = colourful
    ? `rgb(${Math.round(sum(sr) / wSum)} ${Math.round(sum(sg) / wSum)} ${Math.round(sum(sb) / wSum)})`
    : `hsl(0 0% ${mood === "dark" ? "20%" : "80%"})`;

  // Monochromatic, analogous to the dominant colour: same hue throughout,
  // a light (or dark) tint that still unmistakably reads as the image.
  return mood === "dark"
    ? {
        mood,
        dominant,
        bg: hsl(h, clamp(s * 0.8, 0.12, 0.45), 0.1),
        fg: hsl(h, clamp(s * 0.4, 0.06, 0.25), 0.92),
        edge: `hsl(${h.toFixed(1)} 20% 92% / 0.1)`,
      }
    : {
        mood,
        dominant,
        bg: hsl(h, clamp(s * 0.9, 0.2, 0.65), 0.915),
        fg: hsl(h, clamp(s * 0.7, 0.15, 0.5), 0.13),
        edge: `hsl(${h.toFixed(1)} 40% 13% / 0.09)`,
      };
}

const NEUTRAL = {
  mood: "light",
  dominant: "hsl(0 0% 80%)",
  bg: "hsl(0 0% 91.5%)",
  fg: "hsl(0 0% 13%)",
  edge: "hsl(0 0% 13% / 0.09)",
};

// ---------------------------------------------------------------------------
// Open Graph image — the day's block cropped to 1200×630 with a centered
// square (the block) at half height, white or black by what's underneath it.

async function ogImage(buffer, outPath) {
  const W = 1200, H = 630;
  const side = Math.round(H * 0.5);
  const x = Math.round((W - side) / 2);
  const y = Math.round((H - side) / 2);

  const base = await sharp(buffer)
    .resize(W, H, { fit: "cover" })
    .removeAlpha()
    .toBuffer();

  const under = await sharp(base)
    .extract({ left: x, top: y, width: side, height: side })
    .stats();
  const [r, g, b] = under.channels.map((c) => c.mean);
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const fill = luma < 128 ? "#ffffff" : "#000000";

  const square = Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect x="${x}" y="${y}" width="${side}" height="${side}" fill="${fill}"/></svg>`
  );
  await sharp(base)
    .composite([{ input: square }])
    .jpeg({ quality: 88 })
    .toFile(outPath);
  return fill;
}

// ---------------------------------------------------------------------------
// Relative time, in Are.na's voice ("over 1 year ago", "2 minutes ago").

function relative(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const m = s / 60, h = m / 60, d = h / 24, mo = d / 30.4, y = d / 365.25;
  if (m < 1) return "just now";
  if (h < 1) return `${Math.round(m)} minute${Math.round(m) === 1 ? "" : "s"} ago`;
  if (d < 1) return `about ${Math.round(h)} hour${Math.round(h) === 1 ? "" : "s"} ago`;
  if (mo < 1) return `${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"} ago`;
  if (y < 1) return `${Math.round(mo)} month${Math.round(mo) === 1 ? "" : "s"} ago`;
  const years = Math.floor(y);
  return y - years > 0.25
    ? `over ${years} year${years === 1 ? "" : "s"} ago`
    : `${years} year${years === 1 ? "" : "s"} ago`;
}

const esc = (str = "") =>
  String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const faviconFor = (colour) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="${colour}"/></svg>`
  )}`;

function dayEntry(date, block, palette) {
  const img = block.image;
  // Resized renditions are re-encoded stills — serve gifs from the original
  // so they keep animating.
  const isGif = img.content_type === "image/gif";
  return {
    d: date.replaceAll("-", ""),
    id: block.id,
    t: block.title || img.filename || "Untitled",
    by: block.user?.name ?? "unknown",
    bys: block.user?.slug ?? "",
    a: relative(block.created_at),
    m: relative(block.updated_at),
    w: img.width,
    h: img.height,
    src: isGif ? img.src : img.large?.src ?? img.src,
    bg: palette.bg,
    fg: palette.fg,
    e: palette.edge,
    dm: palette.dominant,
  };
}

// ---------------------------------------------------------------------------

function render({ days, channel, hasFont, date }) {
  const t = days[days.length - 1]; // today
  const blockUrl = `https://www.are.na/block/${t.id}`;
  const description = `One block a day from ${channel.title}, an Are.na channel by ${channel.owner?.name ?? "its owner"}.`;
  const ogImg = `${SITE_URL}/og.jpg?${date}`;
  const daysJson = JSON.stringify(days).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>block</title>
  <meta name="description" content="${esc(description)}">
  <meta property="og:title" content="block">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:image" content="${esc(ogImg)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
${SITE_URL ? `  <meta property="og:url" content="${esc(SITE_URL)}">\n` : ""}  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${esc(ogImg)}">
  <meta name="theme-color" content="${t.bg}">
  <link rel="icon" id="favicon" href="${faviconFor(t.dm)}">
  <style>
${hasFont ? `    @font-face {
      font-family: "Body";
      src: url("/assets/fonts/body.woff2") format("woff2");
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }
` : ""}
    :root {
      --bg: ${t.bg};
      --fg: ${t.fg};
      --edge: ${t.e};
    }

    *, *::before, *::after { box-sizing: border-box; }

    html, body { margin: 0; padding: 0; }
    html { background: var(--bg); }

    body {
      background: var(--bg);
      color: var(--fg);
      font-family: ${hasFont ? `"Body", ` : ""}system-ui, sans-serif;
      font-size: 16px;
      line-height: 1.3;
      min-height: 100svh;
      display: flex;
      flex-direction: column;
      transition: background-color 400ms ease, color 400ms ease;
    }

    a { color: inherit; text-decoration: none; }

    /* Timeline ruler — one tick per day at a fixed 8px pitch, day 1 first,
       today last. The strip is wider than the viewport and pans under the
       pointer faster than the pointer moves (parallax), so the whole
       history is always reachable. */
    #scrub {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 72px;
      z-index: 10;
      cursor: ew-resize;
      touch-action: none;
      -webkit-user-select: none;
      user-select: none;
      outline: none;
    }

    /* The strip is wider than the viewport — clip it without clipping the
       date label, which hangs below the scrub zone. */
    #clip {
      position: absolute;
      inset: 0;
      overflow: hidden;
    }

    #ticks {
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      will-change: transform;
    }

    #ticks i {
      position: absolute;
      top: 0;
      width: 1px;
      height: 13px;
      background: currentColor;
      opacity: 0.26;
      transform-origin: top center;
      animation: tick-in 600ms ease-out backwards;
    }

    @keyframes tick-in {
      from { transform: scaleY(0); }
    }

    #sel-tick {
      position: absolute;
      top: 0;
      left: 0;
      width: 1px;
      height: 30px;
      background: currentColor;
      opacity: 0.85;
      will-change: transform;
    }

    #sel-label {
      position: absolute;
      top: 38px;
      left: 0;
      writing-mode: vertical-rl;
      font-size: 11px;
      letter-spacing: 0.1em;
      opacity: 0.5;
      white-space: nowrap;
      will-change: transform;
    }

    @media (prefers-reduced-motion: reduce) {
      #ticks i { animation: none; }
    }

    main {
      flex: 1;
      display: grid;
      place-items: center;
      padding: 96px 24px 24px;
    }

    .block {
      display: block;
      animation: appear 0.9s ease-out both;
    }

    .block img {
      display: block;
      max-width: min(88vw, 720px);
      max-height: 66svh;
      width: auto;
      height: auto;
      box-shadow: 0 0 0 1px var(--edge);
      transition: opacity 240ms ease;
    }

    @keyframes appear {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    @media (prefers-reduced-motion: reduce) {
      .block { animation: none; }
      .block img { transition: none; }
    }

    /* Five equal columns, not space-between: each field's width came from its
       own content, so scrubbing days shuffled the whole row sideways — a new
       title length moved "added", "by" and the dimensions with it. Fixed
       columns hold every field still while the day changes underneath. The
       title pays for it (Are.na falls back to the upload's filename, which
       can be long) and truncates at its column edge — the full string stays
       in its title attribute. */
    footer {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      align-items: baseline;
      gap: 8px 24px;
      padding: 20px 24px;
      font-size: 13px;
      white-space: nowrap;
      opacity: 0.45;
      transition: opacity 240ms ease;
    }

    footer:hover { opacity: 0.85; }

    /* Grid blockifies these, so text-overflow applies; minmax(0, 1fr) above
       is what lets a column shrink below its content instead of pushing the
       row wider than the viewport. */
    footer > * {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Equal columns leave the row short of the right edge, since content sits
       at the start of its cell. Anchoring the last one keeps the metadata
       spanning the footer the way space-between did. */
    footer > :last-child { text-align: right; }

    footer a:hover { text-decoration: underline; }

    footer .label { opacity: 0.6; margin-right: 0.35em; }

    /* Five columns squeeze the relative times ("about 2 hours ago") to
       nothing well before the layout folds — drop to two, with the title
       across the top. Still equal, still stable. Two columns already reach
       the right edge, and right-aligning there would only break the
       dimensions out of line with "modified" above it. */
    @media (max-width: 900px) {
      footer { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      footer .title { grid-column: 1 / -1; }
      footer > :last-child { text-align: left; }
    }
  </style>
</head>
<body>
  <nav id="scrub" role="slider" tabindex="0" aria-label="Timeline — one block a day, back to day one"
       aria-valuemin="0" aria-valuemax="${days.length - 1}" aria-valuenow="${days.length - 1}" aria-valuetext="${t.d}">
    <div id="clip"><div id="ticks"></div></div>
    <div id="sel-tick"></div>
    <div id="sel-label">${t.d}</div>
  </nav>
  <main>
    <a class="block" id="block-link" href="${blockUrl}" aria-label="Open this block on Are.na">
      <img id="block-img" src="${esc(t.src)}" width="${t.w}" height="${t.h}" alt="${esc(t.t)}">
    </a>
  </main>
  <footer>
    <a class="title" id="m-title" href="${blockUrl}" title="${esc(t.t)}">${esc(t.t)}</a>
    <span><span class="label">added</span><span id="m-added">${esc(t.a)}</span></span>
    <span><span class="label">modified</span><span id="m-modified">${esc(t.m)}</span></span>
    <a id="m-by" href="https://www.are.na/${esc(t.bys)}"><span class="label">by</span><span id="m-by-name">${esc(t.by)}</span></a>
    <span id="m-dims">${t.w} × ${t.h}</span>
  </footer>
  <script>
  (function () {
    var DAYS = ${daysJson};
    var N = DAYS.length;
    var reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    var scrub = document.getElementById("scrub");
    var ruler = document.getElementById("ticks");
    var indicator = document.getElementById("sel-tick");
    var label = document.getElementById("sel-label");
    var img = document.getElementById("block-img");
    var link = document.getElementById("block-link");
    var elTitle = document.getElementById("m-title");
    var elAdded = document.getElementById("m-added");
    var elMod = document.getElementById("m-modified");
    var elBy = document.getElementById("m-by");
    var elByName = document.getElementById("m-by-name");
    var elDims = document.getElementById("m-dims");
    var favicon = document.getElementById("favicon");
    var rootStyle = document.documentElement.style;

    var SPACING = 8;   // ticks sit on a fixed 8px pitch
    var INSET = 28;

    var sel = N - 1;
    var ticks = [], scales = [];
    var stripX = 0, stripTarget = 0;
    var px = -1, hovering = false, dragging = false, raf = 0, loadTimer = 0, resizeTimer = 0;

    function frac(i) { return N === 1 ? 0 : i / (N - 1); }
    function clamp01(v) { return Math.max(0, Math.min(1, v)); }
    function usable() { return Math.max(1, scrub.clientWidth - INSET * 2); }
    function overflow() { return (N - 1) * SPACING > usable(); }

    // Where the strip rests when the pointer is away: the selected tick at
    // its proportional spot in the viewport (or simply left-anchored while
    // the strip still fits).
    function restX() {
      if (!overflow()) return INSET;
      return INSET + frac(sel) * usable() - sel * SPACING;
    }

    // Pan target while the pointer is at x: the pointer's fraction of the
    // viewport maps to the full history, so the strip slides past faster
    // than the pointer moves — the day under the pointer is the day you get.
    function panFor(x) {
      if (!overflow()) return INSET;
      return x - clamp01((x - INSET) / usable()) * (N - 1) * SPACING;
    }

    function dayAt(x) {
      if (!overflow())
        return Math.max(0, Math.min(N - 1, Math.round((x - INSET) / SPACING)));
      return Math.round(clamp01((x - INSET) / usable()) * (N - 1));
    }

    function buildTicks() {
      ruler.textContent = "";
      ticks = [];
      ruler.style.width = ((N - 1) * SPACING + 1) + "px";
      for (var i = 0; i < N; i++) {
        var el = document.createElement("i");
        el.style.left = i * SPACING + "px";
        el.style.animationDelay = (frac(i) * 400).toFixed(0) + "ms";
        ruler.appendChild(el);
        ticks.push(el);
      }
      scales = ticks.map(function () { return 1; });
      stripX = stripTarget = restX();
      label.textContent = DAYS[sel].d;
      paint();
    }

    function paint() {
      ruler.style.transform = "translateX(" + stripX.toFixed(2) + "px)";
      var x = (stripX + sel * SPACING).toFixed(2);
      indicator.style.transform = "translateX(" + x + "px)";
      label.style.transform = "translateX(" + x + "px) translateX(-50%)";
    }

    function swapImage(day) {
      var pre = new Image();
      pre.onload = function () {
        if (DAYS[sel] !== day) return;
        img.src = day.src;
        img.width = day.w;
        img.height = day.h;
        img.alt = day.t;
        img.style.opacity = 1;
      };
      pre.src = day.src;
    }

    function apply(i) {
      var day = DAYS[i];
      rootStyle.setProperty("--bg", day.bg);
      rootStyle.setProperty("--fg", day.fg);
      rootStyle.setProperty("--edge", day.e);
      var url = "https://www.are.na/block/" + day.id;
      link.href = url;
      elTitle.href = url;
      elTitle.textContent = day.t;
      elTitle.title = day.t;
      elAdded.textContent = day.a;
      elMod.textContent = day.m;
      elBy.href = "https://www.are.na/" + day.bys;
      elByName.textContent = day.by;
      elDims.textContent = day.w + " \\u00d7 " + day.h;
      favicon.href = "data:image/svg+xml," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="' + day.dm + '"/></svg>'
      );
      scrub.setAttribute("aria-valuenow", i);
      scrub.setAttribute("aria-valuetext", day.d);
      img.style.opacity = 0;
      clearTimeout(loadTimer);
      loadTimer = setTimeout(function () { swapImage(day); }, reduced ? 0 : 140);
    }

    function select(i) {
      i = Math.max(0, Math.min(N - 1, i));
      if (i === sel) return;
      sel = i;
      label.textContent = DAYS[sel].d;
      apply(i);
      if (!hovering) stripTarget = restX();
    }

    // Every frame: glide the strip toward its target (the parallax), and
    // stretch ticks near the pointer with a gaussian falloff (the magnify).
    function loop() {
      raf = 0;
      var active = false;

      var nx = stripX + (stripTarget - stripX) * (reduced ? 1 : 0.16);
      if (Math.abs(stripTarget - nx) > 0.1) active = true;
      else nx = stripTarget;
      stripX = nx;

      for (var k = 0; k < ticks.length; k++) {
        var target = 1;
        if (hovering && !reduced) {
          var dx = (stripX + k * SPACING - px) / 32;
          target = 1 + 1.5 * Math.exp(-dx * dx);
        }
        var s = scales[k] + (target - scales[k]) * 0.16;
        if (Math.abs(target - s) > 0.004) active = true;
        if (Math.abs(s - scales[k]) > 0.001) {
          scales[k] = s;
          ticks[k].style.transform = "scaleY(" + s.toFixed(3) + ")";
        }
      }

      paint();
      if (active || hovering) raf = requestAnimationFrame(loop);
    }

    function wake() { if (!raf) raf = requestAnimationFrame(loop); }

    scrub.addEventListener("pointermove", function (e) {
      px = e.clientX;
      hovering = true;
      stripTarget = panFor(e.clientX);
      if (dragging) select(dayAt(e.clientX));
      wake();
    });
    scrub.addEventListener("pointerdown", function (e) {
      dragging = true;
      px = e.clientX;
      hovering = true;
      stripTarget = panFor(e.clientX);
      select(dayAt(e.clientX));
      try { scrub.setPointerCapture(e.pointerId); } catch (err) {}
      wake();
      e.preventDefault();
    });
    scrub.addEventListener("pointerup", function () { dragging = false; });
    scrub.addEventListener("pointercancel", function () { dragging = false; hovering = false; stripTarget = restX(); wake(); });
    scrub.addEventListener("pointerleave", function () { if (!dragging) { hovering = false; stripTarget = restX(); wake(); } });
    scrub.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") { select(sel - 1); e.preventDefault(); }
      else if (e.key === "ArrowRight") { select(sel + 1); e.preventDefault(); }
      else if (e.key === "Home") { select(0); e.preventDefault(); }
      else if (e.key === "End") { select(N - 1); e.preventDefault(); }
    });
    addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        stripX = stripTarget = restX();
        paint();
        wake();
      }, 150);
    });

    buildTicks();
  })();
  </script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------

const dayMs = 86400000;
const utcOf = (ymd) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};

const { channel, blocks } = await fetchAllBlocks();
// History depth: everything, or — with an epoch — one day per day since
// launch, capped at the channel's block count.
let depth = blocks.length;
if (EPOCH) {
  const elapsed = Math.floor((utcOf(today()) - utcOf(EPOCH)) / dayMs) + 1;
  depth = Math.min(depth, Math.max(1, elapsed));
}
const dates = datesEndingToday(depth);
const picks = dates
  .map((date) => ({ date, block: pickForDate(date, blocks) }))
  .filter((p) => p.block);
const todayPick = picks[picks.length - 1];

// Palettes are sampled from the small rendition and cached between builds —
// only blocks new to the history get downloaded.
let cache = {};
try {
  cache = JSON.parse(await readFile(cacheFile, "utf8"));
} catch {}
const uniq = [...new Map(picks.map((p) => [p.block.id, p.block])).values()];
const missing = uniq.filter((b) => !cache[b.id]);
if (missing.length) console.log(`sampling ${missing.length} new palettes…`);
await mapLimit(missing, 8, async (b) => {
  try {
    const buf = await fetchBuffer(b.image.small?.src ?? b.image.src);
    cache[b.id] = await paletteFrom(buf);
  } catch (err) {
    console.warn(`palette failed for block ${b.id}: ${err.message}`);
    cache[b.id] = NEUTRAL;
  }
});
await mkdir(path.dirname(cacheFile), { recursive: true });
await writeFile(cacheFile, JSON.stringify(cache));

const days = picks.map((p) => dayEntry(p.date, p.block, cache[p.block.id]));

await mkdir(path.join(dist, "assets/fonts"), { recursive: true });

const ogBuffer = await fetchBuffer(
  todayPick.block.image.medium?.src ?? todayPick.block.image.src
);
await ogImage(ogBuffer, path.join(dist, "og.jpg"));

let hasFont = false;
if (FONT_URL) {
  const res = await fetch(FONT_URL);
  if (res.ok) {
    await writeFile(
      path.join(dist, "assets/fonts/body.woff2"),
      Buffer.from(await res.arrayBuffer())
    );
    hasFont = true;
  } else {
    console.warn(`font fetch failed (${res.status}) — falling back to system-ui`);
  }
}

await writeFile(
  path.join(dist, "index.html"),
  render({ days, channel, hasFont, date: todayPick.date })
);
const host = SITE_URL ? new URL(SITE_URL).host : "";
if (host && !host.endsWith("github.io"))
  await writeFile(path.join(dist, "CNAME"), `${host}\n`);
await writeFile(path.join(dist, ".nojekyll"), "");

const todayDay = days[days.length - 1];
console.log(
  `${todayPick.date} → block ${todayDay.id} "${todayDay.t}" by ${todayDay.by} · ${cache[todayDay.id].mood} · ${todayDay.dm} · ${days.length} days of history`
);
