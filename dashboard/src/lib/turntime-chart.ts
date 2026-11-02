import { createCanvas, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import path from 'path';
import { fitToSurface, holoGlowHex } from './armies';
import { SURFACE } from './chart';

const INK = '#d7dbc9';
const INK_MUTED = '#8b9180';
const GRID = '#2a2e24';
const FONT = 'ComTowerTurnTime';
let fontReady = false;
function ensureFont() {
  if (fontReady) return;
  GlobalFonts.registerFromPath(path.join(process.cwd(), 'fonts', 'noto-sans-latin.ttf'), FONT);
  fontReady = true;
}

export type TurnTimeRow = {
  name: string;
  co?: string;
  army?: string;
  eliminated?: boolean;
  turnsMs: number[];
  /** Time on the clock so far, if it is this player's turn now. */
  currentMs?: number;
};

const HOUR = 3600_000;

/** "45m", "6h", "1d", "1d 12h" — the same short spans the Signal caption uses. */
export function fmtSpan(ms: number): string {
  const min = Math.round(ms / 60000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return `${h}h`;
  return `${min % 60}m`;
}

function median(v: number[]) {
  const s = [...v].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Axis step in whole hours that gives at most ~7 ticks. */
function tickStep(maxMs: number) {
  const steps = [1, 2, 3, 6, 12, 24, 48, 72, 168].map((h) => h * HOUR);
  return steps.find((s) => maxMs / s <= 7) ?? 336 * HOUR;
}

/**
 * Who is holding up the game: one row per player, slowest average first. Every finished turn
 * is a dot, so one 3-day turn reads differently from a steady habit of long ones; the tick is
 * the median, the ring is the turn on the clock right now.
 *
 * Colours are the hologram glows, which are built to stand out on a dark field, and every row
 * is labelled by name, so identity never rests on colour alone.
 */
export function buildTurnTimePng(opts: {
  rows: TurnTimeRow[];
  title: string;
  subtitle?: string;
  /** Marked on the axis — the group's reminder threshold, so "slow" has a reference. */
  referenceMs?: number | null;
}): Buffer {
  ensureFont();
  const SCALE = 2;
  const W = 900;
  const ROW_H = 58;
  const M = { top: 70, left: 24, right: 24, bottom: 44 };
  const rows = opts.rows;
  const H = M.top + Math.max(1, rows.length) * ROW_H + M.bottom;
  const canvas = createCanvas(W * SCALE, H * SCALE);
  const ctx = canvas.getContext('2d') as SKRSContext2D;
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = SURFACE;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'left';
  ctx.font = `15px ${FONT}`;
  ctx.fillStyle = INK;
  ctx.fillText(opts.title, M.left, 30);
  if (opts.subtitle) {
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = INK_MUTED;
    ctx.fillText(opts.subtitle, M.left, 48);
  }

  // Measured columns, so a long username or CO never runs into the plot.
  ctx.font = `13px ${FONT}`;
  const nameW =
    Math.max(
      120,
      ...rows.map((r) => ctx.measureText(r.name).width),
      ...rows.map((r) => {
        ctx.font = `11px ${FONT}`;
        return ctx.measureText(subline(r)).width;
      })
    ) + 18;
  const statsW = 190;
  const x0 = M.left + nameW;
  const x1 = W - M.right - statsW;

  const all = rows.flatMap((r) => [...r.turnsMs, ...(r.currentMs ? [r.currentMs] : [])]);
  const ref = opts.referenceMs && opts.referenceMs > 0 ? opts.referenceMs : undefined;
  const maxMs = Math.max(HOUR, ...all, ref ?? 0) * 1.04;
  const x = (ms: number) => x0 + (Math.min(ms, maxMs) / maxMs) * (x1 - x0);
  const plotTop = M.top - 6;
  const plotBottom = M.top + rows.length * ROW_H;

  // Vertical grid at round spans, labelled along the bottom.
  const step = tickStep(maxMs);
  ctx.font = `10px ${FONT}`;
  ctx.textAlign = 'center';
  for (let t = 0; t <= maxMs; t += step) {
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x(t), plotTop);
    ctx.lineTo(x(t), plotBottom);
    ctx.stroke();
    ctx.fillStyle = INK_MUTED;
    ctx.fillText(t === 0 ? '0' : fmtSpan(t), x(t), plotBottom + 16);
  }
  ctx.fillText('Time per turn', (x0 + x1) / 2, H - 10);

  if (ref) {
    ctx.strokeStyle = INK_MUTED;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x(ref), plotTop);
    ctx.lineTo(x(ref), plotBottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = INK_MUTED;
    ctx.textAlign = 'left';
    ctx.fillText(`reminder ${fmtSpan(ref)}`, x(ref) + 4, plotTop + 2);
  }

  rows.forEach((r, i) => {
    const top = M.top + i * ROW_H;
    const cy = top + ROW_H / 2;
    const color = fitToSurface(holoGlowHex(r.army), SURFACE, 4.5);
    const fade = r.eliminated ? 0.45 : 1;

    if (i > 0) {
      ctx.strokeStyle = GRID;
      ctx.beginPath();
      ctx.moveTo(M.left, top);
      ctx.lineTo(W - M.right, top);
      ctx.stroke();
    }

    // Name in the army colour, CO and turn count beneath.
    ctx.globalAlpha = fade;
    ctx.textAlign = 'left';
    ctx.font = `13px ${FONT}`;
    ctx.fillStyle = color;
    ctx.fillText(r.name, M.left, cy - 3);
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = INK_MUTED;
    ctx.fillText(subline(r), M.left, cy + 13);

    const turns = r.turnsMs;
    if (turns.length) {
      const lo = Math.min(...turns);
      const hi = Math.max(...turns);
      // Min–max range, recessive.
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.3 * fade;
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x(lo), cy);
      ctx.lineTo(x(hi), cy);
      ctx.stroke();
      // One dot per turn.
      ctx.globalAlpha = 0.85 * fade;
      ctx.fillStyle = color;
      for (const t of turns) {
        ctx.beginPath();
        ctx.arc(x(t), cy, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      // Median tick.
      ctx.globalAlpha = fade;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.lineCap = 'butt';
      const mx = x(median(turns));
      ctx.beginPath();
      ctx.moveTo(mx, cy - 10);
      ctx.lineTo(mx, cy + 10);
      ctx.stroke();
    }

    // The turn in progress: a ring, labelled, because this is the one people are waiting on.
    if (r.currentMs) {
      const cx = x(r.currentMs);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = `10px ${FONT}`;
      ctx.fillStyle = color;
      ctx.textAlign = cx > x1 - 60 ? 'right' : 'center';
      ctx.fillText(`now ${fmtSpan(r.currentMs)}`, cx, cy - 13);
    }

    // Numbers on the right: average leads, since that is the ranking.
    ctx.globalAlpha = fade;
    ctx.textAlign = 'left';
    const sx = x1 + 18;
    if (turns.length) {
      const avg = turns.reduce((a, b) => a + b, 0) / turns.length;
      ctx.font = `13px ${FONT}`;
      ctx.fillStyle = INK;
      ctx.fillText(`avg ${fmtSpan(avg)}`, sx, cy - 3);
      ctx.font = `11px ${FONT}`;
      ctx.fillStyle = INK_MUTED;
      ctx.fillText(
        `min ${fmtSpan(Math.min(...turns))} · med ${fmtSpan(median(turns))} · max ${fmtSpan(Math.max(...turns))}`,
        sx,
        cy + 13
      );
    } else {
      ctx.font = `11px ${FONT}`;
      ctx.fillStyle = INK_MUTED;
      ctx.fillText('no turns timed', sx, cy + 4);
    }
    ctx.globalAlpha = 1;
  });

  return canvas.toBuffer('image/png');
}

function subline(r: TurnTimeRow) {
  const n = r.turnsMs.length;
  return [r.co, `${n} turn${n === 1 ? '' : 's'}`, r.eliminated ? 'out' : ''].filter(Boolean).join(' · ');
}
