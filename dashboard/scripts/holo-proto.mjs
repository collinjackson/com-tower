// Prototype: Star Wars hologram on an AWBW unit sprite, in the FACTION color.
// Bright armies -> glowing color on near-black. Very dark armies (Black Hole,
// Noir) -> the color reads as ink on a white field instead.
import sharp from 'sharp';
import { writeFileSync } from 'fs';

const SPRITE = process.argv[2] || 'osinfantry';
const CODE = process.argv[3] || SPRITE.slice(0, 2);

// AWBW faction glow colors (approx palette).
const ARMY_COLOR = {
  os: [255, 120, 40], bm: [70, 130, 240], ge: [70, 190, 90], yc: [245, 215, 70],
  bh: [125, 90, 150], rf: [230, 60, 60], gs: [150, 160, 170], bd: [175, 115, 60],
  ab: [240, 170, 60], js: [60, 200, 150], ci: [80, 170, 230], pc: [245, 130, 200],
  tg: [40, 200, 190], pl: [170, 90, 220], ar: [170, 210, 70], wn: [235, 240, 245],
  aa: [90, 200, 235], ne: [70, 70, 90], sc: [190, 200, 210], uw: [125, 85, 55],
};
const DEFAULT_COLOR = [130, 240, 255]; // teal fallback for unknown codes
const UPSCALE = 8;

// Brighten a faction color into a glow: scale so the brightest channel hits
// ~235, preserving hue. Dark armies (Black Hole, Noir) become vivid/ghostly
// glows instead of vanishing -> everyone stays holographic on black.
function glowColor(C) {
  const s = 235 / Math.max(...C);
  return C.map((c) => Math.min(255, Math.round(c * s)));
}

// Recolor curve + background + grain. GLOW ON BLACK for all factions: per
// channel, luminance L is mapped linearly from a dark tinted FLOOR (at L=0) to a
// near-white HIGHLIGHT (at L=255). Lerping toward white at the top end desaturates
// the highlights -> a brighter, specular sheen instead of flat saturated color.
// out_c = A*L + B, A=(hi-lo)/255, B=lo. (.linear keeps alpha, so no color box.)
const FLOOR_FRAC = 0.22; // dark-tint floor as a fraction of the glow color
function holoSpec(code) {
  const G = glowColor(ARMY_COLOR[code] || DEFAULT_COLOR);
  // Highlight = a VIVID version of the hue (max channel pushed to 255, which
  // brightens warm colors without washing them out), PLUS a white bloom that's
  // strong for cool colors (blue/purple, which read dark and need icy
  // highlights) and near-zero for warm ones (orange/yellow stay saturated).
  const Gv = G.map((c) => Math.min(255, Math.round((c * 255) / Math.max(...G))));
  const blueDom = (Gv[2] - (Gv[0] + Gv[1]) / 2) / 255; // +cool .. -warm
  const w = Math.max(0, Math.min(0.45, 0.22 + 0.3 * blueDom));
  const lo = G.map((c) => c * FLOOR_FRAC);
  const hi = Gv.map((c) => c + (255 - c) * w);
  return {
    A: G.map((c, i) => (hi[i] - lo[i]) / 255),
    B: lo,
    bg: { r: 2, g: 6, b: 12 },
    grain: [210, 235, 255],
  };
}

function scanlineTile(w) {
  const h = 3;
  const buf = Buffer.alloc(w * h * 4, 0);
  for (let x = 0; x < w; x++) buf[((h - 1) * w + x) * 4 + 3] = 120; // alpha-only black line
  return { input: buf, raw: { width: w, height: h, channels: 4 }, tile: true, blend: 'over' };
}
function grainImage(w, h, [gr, gg, gb]) {
  const buf = Buffer.alloc(w * h * 4, 0);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    buf[o] = gr; buf[o + 1] = gg; buf[o + 2] = gb;
    buf[o + 3] = Math.round(Math.random() ** 3 * 40);
  }
  return { input: buf, raw: { width: w, height: h, channels: 4 }, blend: 'over' };
}

const res = await fetch(`https://awbw.amarriner.com/terrain/ani/${SPRITE}.gif`);
if (!res.ok) throw new Error(`fetch ${SPRITE} -> ${res.status}`);
const orig = Buffer.from(await res.arrayBuffer());
const meta = await sharp(orig, { animated: true }).metadata();
const w = meta.width, pageH = meta.pageHeight || meta.height, pages = meta.pages || 1;
const outW = w * UPSCALE, outFullH = pageH * pages * UPSCALE;

// Per-country facing (all units of a country face the same way). R = barrel
// reaches the right edge of the cell, L = left. Lead room goes on the facing side.
const FACE_LEFT = new Set(['bm', 'yc', 'bh', 'rf', 'ab', 'pc', 'tg', 'ar', 'ne', 'sc']);
const facesRight = !FACE_LEFT.has(CODE);

const spec = holoSpec(CODE);
// Margin of the dark field around each frame so cropped previews don't clip the
// unit. Asymmetric: more lead room on the side it's looking, and the unit sits
// slightly below center (more headroom). extend() pads per-page on animated GIFs.
const M = Math.round(outW * 0.22);
const lead = Math.round(M * 1.55), back = Math.round(M * 0.45);
const left = facesRight ? back : lead;
const right = facesRight ? lead : back;
const top = Math.round(M * 1.3), bottom = Math.round(M * 0.7);
const padW = outW + left + right;
const padFullH = outFullH + (top + bottom) * pages;
const out = await sharp(orig, { animated: true })
  .modulate({ saturation: 0 })
  .linear(spec.A, spec.B)
  .flatten({ background: spec.bg })
  .resize({ width: outW, kernel: 'nearest' })
  .extend({ top, bottom, left, right, background: { ...spec.bg, alpha: 1 } })
  .composite([scanlineTile(padW), grainImage(padW, padFullH, spec.grain)])
  .gif()
  .toBuffer();
writeFileSync(`/tmp/holo_${SPRITE}.gif`, out);
writeFileSync(`/tmp/holo_${SPRITE}.png`, await sharp(out, { pages: 1 }).png().toBuffer());
console.log(`wrote /tmp/holo_${SPRITE}.png  code=${CODE} glow=${glowColor(ARMY_COLOR[CODE] || DEFAULT_COLOR)}`);
