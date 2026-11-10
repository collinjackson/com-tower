import { createCanvas, GlobalFonts, loadImage, type Image } from '@napi-rs/canvas';
import path from 'path';
import { fitToSurface, holoGlowHex } from './armies.ts';
import type { Series } from './turn-series.ts';

// The featured chart on a turn ping: an animated GIF whose lines draw in day by day while each
// player's own unit sprite (AWBW's animated map sprite, in their army's colours) rides the head
// of their line. The sprite is the legend: players recognise their army's soldier faster than
// a colour swatch. Faint scanlines keep the radio-transmission look of the hologram pings.

// Same surface as chart.ts's SURFACE (not imported: chart.ts's extensionless imports don't
// load under node --test, where this file is tested).
const SURFACE = '#12140f';
const INK = '#d7dbc9';
const MUTED = '#8b9180';
const GRID = '#2a2e24';
const FONT = 'ComTowerFeatured';
let fontReady = false;
function ensureFont() {
  if (fontReady) return;
  GlobalFonts.registerFromPath(path.join(process.cwd(), 'fonts', 'noto-sans-latin.ttf'), FONT);
  fontReady = true;
}

/** The sprite AWBW serves for an army's unit, e.g. ("os", "infantry"). */
export const spriteUrl = (army: string, unit = 'infantry') =>
  `https://awbw.amarriner.com/terrain/ani/${army}${unit}.gif`;

/** An animated sprite GIF as frames, scaled up 2x with nearest-neighbour (pixel art). */
export async function spriteFrames(gif: Uint8Array): Promise<Image[]> {
  const sharp = (await import('sharp')).default;
  const meta = await sharp(gif, { animated: true }).metadata();
  const frames: Image[] = [];
  for (let i = 0; i < (meta.pages || 1); i++) {
    const png = await sharp(gif, { page: i }).resize({ width: (meta.width || 16) * 2, kernel: 'nearest' }).png().toBuffer();
    frames.push(await loadImage(png));
  }
  return frames;
}

function niceTop(v: number): { top: number; step: number } {
  const raw = Math.max(v, 1) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  return { top: step * Math.ceil(v / step), step };
}

const money = (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${Math.round(v)}`);

export type FeaturedGif = { data: Buffer; frames: number; width: number; height: number };

/**
 * Lines grow over `steps` frames, then the last frame holds. `sprites` maps a series key to its
 * animation frames; a series without one gets a dot. `isMoney` formats values as 12k.
 */
export async function buildFeaturedGif(opts: {
  series: Series[];
  title: string;
  isMoney: boolean;
  sprites?: Map<string, Image[]>;
  width?: number;
  height?: number;
  steps?: number;
  hold?: number;
}): Promise<FeaturedGif> {
  ensureFont();
  const W = opts.width ?? 640;
  const H = opts.height ?? 360;
  const pad = { l: 58, r: 78, t: 54, b: 34 };
  const series = opts.series.filter((s) => s.points.length);
  const at = (p: { day: number; turn: number }) => p.day + p.turn;
  const all = series.flatMap((s) => s.points);
  const t0 = Math.min(...all.map(at));
  const t1 = Math.max(...all.map(at));
  const { top, step } = niceTop(Math.max(...all.map((p) => p.value)) * 1.05);
  const x = (t: number) => pad.l + ((t - t0) / Math.max(1e-9, t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (v / top) * (H - pad.t - pad.b);
  const fmt = (v: number) => (opts.isMoney ? money(v) : `${Math.round(v)}`);
  const color = new Map(series.map((s) => [s.key, fitToSurface(holoGlowHex(s.army), SURFACE)]));

  const nSteps = Math.max(2, opts.steps ?? 24);
  const hold = opts.hold ?? 6;
  const raws: Buffer[] = [];
  for (let f = 0; f < nSteps + hold; f++) {
    const cut = t0 + (t1 - t0) * Math.min(1, (f + 1) / nSteps); // time drawn so far
    const c = createCanvas(W, H);
    const g = c.getContext('2d');
    g.fillStyle = SURFACE;
    g.fillRect(0, 0, W, H);
    g.font = `12px ${FONT}`;
    g.lineWidth = 1;
    for (let v = 0; v <= top + 1e-9; v += step) {
      g.strokeStyle = GRID;
      g.beginPath();
      g.moveTo(pad.l, y(v));
      g.lineTo(W - pad.r, y(v));
      g.stroke();
      g.fillStyle = MUTED;
      g.fillText(fmt(v), 10, y(v) + 4);
    }
    const shownDay = Math.floor(cut);
    g.fillStyle = MUTED;
    g.fillText(`Day ${Math.floor(t0)}`, pad.l, H - 12);
    g.fillText(`Day ${shownDay}`, Math.min(W - pad.r - 30, x(cut) - 20), H - 12);
    g.fillStyle = INK;
    g.font = `bold 18px ${FONT}`;
    g.fillText(`${opts.title}, day ${shownDay}`, pad.l, 32);

    // Heads first, so sprites can be nudged apart where lines meet.
    const heads = series.map((s) => {
      const pts = s.points.filter((p) => at(p) <= cut + 1e-9);
      return { s, pts, head: pts[pts.length - 1] ?? s.points[0] };
    });
    const placed: number[] = [];
    for (const { s, pts, head } of [...heads].sort((a, b) => b.head.value - a.head.value)) {
      const col = color.get(s.key)!;
      g.save();
      g.globalAlpha = s.eliminated ? 0.45 : 1;
      g.strokeStyle = col;
      g.lineWidth = 3;
      g.shadowColor = col;
      g.shadowBlur = 8;
      g.beginPath();
      pts.forEach((p, j) => (j ? g.lineTo(x(at(p)), y(p.value)) : g.moveTo(x(at(p)), y(p.value))));
      g.stroke();
      g.restore();
      let hy = y(head.value);
      for (const py of placed) if (Math.abs(hy - py) < 22) hy = py + 22; // keep sprites apart
      placed.push(hy);
      const hx = x(at(head));
      const frames = opts.sprites?.get(s.key);
      if (frames?.length) {
        const sp = frames[f % frames.length];
        g.drawImage(sp, hx - sp.width / 2, hy - sp.height + 6);
      } else {
        g.fillStyle = col;
        g.beginPath();
        g.arc(hx, hy, 5, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = col;
      g.font = `bold 13px ${FONT}`;
      g.fillText(fmt(head.value), hx + 18, hy - 4);
    }
    g.fillStyle = 'rgba(0,0,0,0.18)';
    for (let yy = 0; yy < H; yy += 3) g.fillRect(0, yy, W, 1);
    raws.push(Buffer.from(g.getImageData(0, 0, W, H).data.buffer));
  }
  const sharp = (await import('sharp')).default;
  const frames = raws.length;
  const delay = raws.map((_, i) => (i < nSteps ? 90 : i === frames - 1 ? 3000 : 250));
  const data = await sharp(Buffer.concat(raws), { raw: { width: W, height: H * frames, channels: 4, pageHeight: H } })
    .gif({ delay, loop: 0, effort: 7 })
    .toBuffer();
  return { data, frames, width: W, height: H };
}
