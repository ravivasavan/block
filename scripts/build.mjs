/**
 * block — one block a day from the Are.na "Aesthetic" channel.
 *
 * Fetches the channel via Are.na's v3 REST API, picks one image block
 * deterministically from today's date (Australia/Melbourne), samples the
 * image's dominant colour and mood (light/dark), and writes a fully static
 * page to dist/. Runs daily via GitHub Actions.
 */

import { mkdir, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const CHANNEL = "aesthetic-v0r0rusrlfq";
const API = "https://api.are.na/v3";
const TOKEN = process.env.ARENA_ACCESS_TOKEN;
const DOMAIN = "block.ravivasavan.com";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

async function api(url) {
  const res = await fetch(url, {
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Pick of the day — FNV-1a over the local date so the choice is stable for
// the whole day and changes at Melbourne midnight.

function todayInMelbourne() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
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

async function pickBlock() {
  const channel = await api(`${API}/channels/${CHANNEL}`);
  const total = channel.counts.contents;
  if (!total) throw new Error("Channel is empty");

  const date = todayInMelbourne();
  let index = fnv1a(date) % total;

  // Walk forward (wrapping) until we land on an image block.
  for (let tries = 0; tries < Math.min(total, 40); tries++) {
    const page = (index % total) + 1; // per=1 → page number is 1-based index
    const { data } = await api(
      `${API}/channels/${CHANNEL}/contents?per=1&page=${page}`
    );
    const block = data?.[0];
    if (block?.type === "Image" && block.image?.src) return { block, date };
    index++;
  }
  throw new Error("No image block found near today's index");
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
  const stats = await sharp(buffer).stats();
  const { r, g, b } = stats.dominant;
  const [mr, mg, mb] = stats.channels.map((c) => c.mean);
  const luma = 0.2126 * mr + 0.7152 * mg + 0.0722 * mb;
  const mood = luma < 118 ? "dark" : "light";
  const { h, s } = rgbToHsl(r, g, b);

  // Monochromatic, analogous to the dominant colour: same hue throughout,
  // saturation kept quiet so the tint reads as atmosphere, not colour.
  const sat = clamp(s, 0.05, 0.22);
  return mood === "dark"
    ? {
        mood,
        dominant: `rgb(${r} ${g} ${b})`,
        bg: hsl(h, sat, 0.09),
        fg: hsl(h, clamp(s, 0.03, 0.12), 0.92),
        edge: `hsl(${h.toFixed(1)} ${(sat * 100).toFixed(1)}% 92% / 0.08)`,
      }
    : {
        mood,
        dominant: `rgb(${r} ${g} ${b})`,
        bg: hsl(h, sat, 0.955),
        fg: hsl(h, clamp(s, 0.08, 0.3), 0.13),
        edge: `hsl(${h.toFixed(1)} ${(sat * 100).toFixed(1)}% 13% / 0.07)`,
      };
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

// ---------------------------------------------------------------------------

function render({ block, date, palette }) {
  const img = block.image;
  // Resized renditions are re-encoded stills — serve gifs from the original
  // so they keep animating.
  const isGif = img.content_type === "image/gif";
  const src = isGif ? img.src : img.large?.src ?? img.src;
  const src2x = isGif ? img.src : img.large?.src_2x ?? img.src;
  const blockUrl = `https://www.are.na/block/${block.id}`;
  const title = block.title || img.filename || "Untitled";
  const alt = img.alt_text || title;
  const favicon = `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="${palette.dominant}"/></svg>`
  )}`;

  const meta = [
    { label: null, value: title, href: blockUrl },
    { label: "added", value: relative(block.created_at) },
    { label: "modified", value: relative(block.updated_at) },
    { label: "by", value: block.user?.name ?? "unknown" },
    { label: null, value: `${img.width} × ${img.height}` },
  ];

  return `<!doctype html>
<html lang="en" data-mood="${palette.mood}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>block</title>
  <meta name="description" content="One block a day from Aesthetic — an Are.na channel by Ravi Vasavan.">
  <meta property="og:title" content="block">
  <meta property="og:description" content="One block a day from Aesthetic — an Are.na channel by Ravi Vasavan.">
  <meta property="og:image" content="${esc(img.medium?.src ?? src)}">
  <meta property="og:url" content="https://${DOMAIN}">
  <meta name="theme-color" content="${palette.bg}">
  <link rel="icon" href="${favicon}">
  <style>
    @font-face {
      font-family: "Labil Grotesk";
      src: url("/assets/fonts/LabilGrotesk-Regular.woff2") format("woff2");
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }

    :root {
      --bg: ${palette.bg};
      --fg: ${palette.fg};
      --edge: ${palette.edge};
    }

    *, *::before, *::after { box-sizing: border-box; }

    html, body { margin: 0; padding: 0; }
    html { background: var(--bg); }

    body {
      background: var(--bg);
      color: var(--fg);
      font-family: "Labil Grotesk", system-ui, sans-serif;
      font-size: 16px;
      line-height: 1.3;
      min-height: 100svh;
      display: flex;
      flex-direction: column;
    }

    a { color: inherit; text-decoration: none; }

    main {
      flex: 1;
      display: grid;
      place-items: center;
      padding: 48px 24px 24px;
    }

    .block {
      display: block;
      animation: appear 0.9s ease-out both;
    }

    .block img {
      display: block;
      max-width: min(88vw, 720px);
      max-height: 72svh;
      width: auto;
      height: auto;
      box-shadow: 0 0 0 1px var(--edge);
    }

    @keyframes appear {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    @media (prefers-reduced-motion: reduce) {
      .block { animation: none; }
    }

    footer {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px 24px;
      padding: 20px 24px;
      font-size: 13px;
      white-space: nowrap;
      opacity: 0.45;
      transition: opacity 240ms ease;
    }

    footer:hover { opacity: 0.85; }

    footer .title {
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 38ch;
    }

    footer a:hover { text-decoration: underline; }

    footer .label { opacity: 0.6; margin-right: 0.35em; }

    @media (max-width: 560px) {
      footer { justify-content: flex-start; }
    }
  </style>
</head>
<body>
  <main>
    <a class="block" href="${blockUrl}" aria-label="Open this block on Are.na">
      <img src="${esc(src)}" srcset="${esc(src)} 1x, ${esc(src2x)} 2x"
           width="${img.width}" height="${img.height}" alt="${esc(alt)}">
    </a>
  </main>
  <footer>
${meta
  .map(({ label, value, href }) => {
    const inner = `${label ? `<span class="label">${label}</span>` : ""}${esc(value)}`;
    return href
      ? `    <a class="title" href="${esc(href)}" title="${esc(value)}">${inner}</a>`
      : `    <span>${inner}</span>`;
  })
  .join("\n")}
  </footer>
  <!-- ${date} · block ${block.id} · ${palette.mood} · ${palette.dominant} -->
</body>
</html>
`;
}

// ---------------------------------------------------------------------------

const { block, date } = await pickBlock();
const imageUrl = block.image.medium?.src ?? block.image.src;
const buffer = Buffer.from(await (await fetch(imageUrl)).arrayBuffer());
const palette = await paletteFrom(buffer);

await mkdir(path.join(dist, "assets/fonts"), { recursive: true });
await copyFile(
  path.join(root, "assets/fonts/LabilGrotesk-Regular.woff2"),
  path.join(dist, "assets/fonts/LabilGrotesk-Regular.woff2")
);
await writeFile(path.join(dist, "index.html"), render({ block, date, palette }));
await writeFile(path.join(dist, "CNAME"), `${DOMAIN}\n`);
await writeFile(path.join(dist, ".nojekyll"), "");

console.log(
  `${date} → block ${block.id} "${block.title}" by ${block.user?.name} · ${palette.mood} · ${palette.dominant}`
);
