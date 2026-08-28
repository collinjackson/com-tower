import { createCanvas, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import path from 'path';
import { ARMY_COLORS, DEFAULT_ARMY_COLOR, SERIES_DASHES, fitToSurface } from './armies';

export const SURFACE = '#12140f';
const INK = '#d7dbc9';
const INK_MUTED = '#8b9180';
const GRID = '#2a2e24';

// Register a font we ship rather than trusting the host to have one. The Vercel runtime has
// no usable system font: an earlier build rasterised every label as tofu boxes, and nothing
// about that is visible on a developer machine, where the system fonts resolve fine.
const FONT = 'ComTowerChart';
let fontReady = false;
function ensureFont() {
  if (fontReady) return;
  GlobalFonts.registerFromPath(
    path.join(process.cwd(), 'fonts', 'noto-sans-latin.ttf'),
    FONT
  );
  fontReady = true;
}

export type Sample = { day: number; order: number; value: number };
export type Series = {
  key: string;
  label: string;
  army?: string;
  eliminated?: boolean;
  points: Sample[];
};

/** Round to a readable axis step (1/2/5 x 10^n). */
function niceStep(range: number, targetTicks: number) {
  const raw = range / Math.max(1, targetTicks);
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
}

const fmtK = (v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v)));

const DASH_PATTERNS: number[][] = SERIES_DASHES.map((d) =>
  d ? d.split(' ').map(Number) : []
);

/**
 * A line chart of one measure over the course of a game, one line per player.
 *
 * Static by necessity: this is posted into Signal as an image, so there is no hover layer to
 * fall back on. Everything a tooltip would have carried is on the face of the chart — every
 * line is directly labelled with its player and latest value.
 */
export function buildChartPng(opts: {
  series: Series[];
  title: string;
  subtitle?: string;
  yLabel: string;
  width?: number;
  height?: number;
}): Buffer {
  ensureFont();
  // With a single sample there is no change over time to draw, and a line chart of one point
  // per player is a scatter of dots pretending to be a trend. The job is then comparing
  // magnitudes between players, which is a bar chart.
  const samplesPerSeries = Math.max(0, ...opts.series.map((s) => s.points.length));
  if (samplesPerSeries === 1) return buildSnapshotPng(opts);
  // 2x for a crisp image on phone screens, where these are actually read.
  const SCALE = 2;
  const W = opts.width ?? 900;
  const H = opts.height ?? 470;
  const canvas = createCanvas(W * SCALE, H * SCALE);
  const ctx = canvas.getContext('2d') as SKRSContext2D;
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = SURFACE;
  ctx.fillRect(0, 0, W, H);

  const all = opts.series.flatMap((s) => s.points);
  if (all.length === 0) {
    ctx.font = `14px ${FONT}`;
    ctx.fillStyle = INK_MUTED;
    ctx.textAlign = 'center';
    ctx.fillText('No turns recorded yet', W / 2, H / 2);
    return canvas.toBuffer('image/png');
  }

  // Measured, not guessed: a fixed right margin clips the moment someone has a long username.
  ctx.font = `11px ${FONT}`;
  const labels = opts.series.map((s) => {
    const last = s.points[s.points.length - 1];
    return `${s.label}${s.eliminated ? ' (out)' : ''}  ${last ? fmtK(last.value) : ''}`;
  });
  const labelW = Math.max(80, ...labels.map((t) => ctx.measureText(t).width));
  const M = { top: 54, right: Math.ceil(labelW) + 22, bottom: 44, left: 66 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;

  const minDay = Math.min(...all.map((p) => p.day));
  const maxDay = Math.max(...all.map((p) => p.day));
  const maxVal = Math.max(...all.map((p) => p.value));
  // Baseline at zero: this is a magnitude, and a truncated axis would overstate every swing.
  const yTop = Math.max(1, maxVal * 1.08);

  // Fractional day so several samples within one day (one per player's turn) stay in order
  // instead of stacking on the same x.
  const x = (p: Sample) =>
    M.left + ((p.day + p.order / 8 - minDay) / Math.max(0.5, maxDay + 1 - minDay)) * plotW;
  const y = (v: number) => M.top + plotH - (v / yTop) * plotH;

  ctx.textAlign = 'left';
  ctx.font = `15px ${FONT}`;
  ctx.fillStyle = INK;
  ctx.fillText(opts.title, M.left, 26);
  if (opts.subtitle) {
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = INK_MUTED;
    ctx.fillText(opts.subtitle, M.left, 43);
  }

  // Recessive grid: horizontal only, so it never competes with the lines.
  const step = niceStep(yTop, 6);
  ctx.lineWidth = 1;
  ctx.font = `10px ${FONT}`;
  for (let v = 0; v <= yTop; v += step) {
    const gy = y(v);
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(M.left, gy);
    ctx.lineTo(M.left + plotW, gy);
    ctx.stroke();
    ctx.fillStyle = INK_MUTED;
    ctx.textAlign = 'right';
    ctx.fillText(fmtK(v), M.left - 8, gy + 3.5);
  }

  ctx.save();
  ctx.translate(M.left - 48, M.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = INK_MUTED;
  ctx.fillText(opts.yLabel, 0, 0);
  ctx.restore();

  // X ticks on day boundaries, thinned so labels never collide.
  const dayStep = Math.max(1, Math.ceil((maxDay - minDay + 1) / 12));
  ctx.textAlign = 'center';
  ctx.fillStyle = INK_MUTED;
  for (let d = minDay; d <= maxDay; d += dayStep) {
    ctx.fillText(String(d), x({ day: d, order: 0, value: 0 }), M.top + plotH + 18);
  }
  ctx.fillText('Day', M.left + plotW / 2, H - 8);
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(M.left, M.top + plotH);
  ctx.lineTo(M.left + plotW, M.top + plotH);
  ctx.stroke();

  // Lines, then direct labels. Drawn in a stable order so colour follows the player, never
  // their current rank.
  const slots: Array<{ yWanted: number; text: string; color: string }> = [];
  opts.series.forEach((s, i) => {
    const pts = [...s.points].sort((a, b) => a.day - b.day || a.order - b.order);
    if (pts.length === 0) return;
    const color = fitToSurface((s.army && ARMY_COLORS[s.army]) || DEFAULT_ARMY_COLOR, SURFACE);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.globalAlpha = s.eliminated ? 0.45 : 1;
    ctx.setLineDash(DASH_PATTERNS[i % DASH_PATTERNS.length]);
    ctx.beginPath();
    pts.forEach((p, k) => (k ? ctx.lineTo(x(p), y(p.value)) : ctx.moveTo(x(p), y(p.value))));
    ctx.stroke();
    ctx.setLineDash([]);

    // A marker on the latest point only — a dot on every sample would be noise.
    const last = pts[pts.length - 1];
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x(last), y(last.value), 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = SURFACE;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;
    slots.push({ yWanted: y(last.value), text: labels[i], color });
  });

  // Nudge labels apart so two players at similar values do not overprint.
  slots.sort((a, b) => a.yWanted - b.yWanted);
  ctx.textAlign = 'left';
  ctx.font = `11px ${FONT}`;
  let prev = -Infinity;
  for (const slot of slots) {
    const ly = Math.max(slot.yWanted, prev + 14);
    prev = ly;
    ctx.fillStyle = slot.color;
    ctx.fillText(slot.text, M.left + plotW + 10, ly + 3.5);
  }

  return canvas.toBuffer('image/png');
}


/** Current standing, one bar per player — used when only a single sample exists. */
function buildSnapshotPng(opts: {
  series: Series[];
  title: string;
  subtitle?: string;
  yLabel: string;
  width?: number;
  height?: number;
}): Buffer {
  ensureFont();
  const SCALE = 2;
  const W = opts.width ?? 900;
  const rows = opts.series.filter((s) => s.points.length > 0);
  const ROW_H = 42;
  const H = Math.max(200, 96 + rows.length * ROW_H);
  const canvas = createCanvas(W * SCALE, H * SCALE);
  const ctx = canvas.getContext('2d') as SKRSContext2D;
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = SURFACE;
  ctx.fillRect(0, 0, W, H);

  const M = { top: 72, left: 24, right: 24 };
  ctx.textAlign = 'left';
  ctx.font = `15px ${FONT}`;
  ctx.fillStyle = INK;
  ctx.fillText(opts.title, M.left, 30);
  if (opts.subtitle) {
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = INK_MUTED;
    ctx.fillText(opts.subtitle, M.left, 48);
  }

  // Sorted by magnitude because that is the comparison being made. Colour still follows the
  // player's army, never their position in this ordering.
  const sorted = [...rows].sort((a, b) => b.points[0].value - a.points[0].value);
  const maxVal = Math.max(1, ...sorted.map((s) => s.points[0].value));

  ctx.font = `12px ${FONT}`;
  const nameW = Math.max(90, ...sorted.map((s) => ctx.measureText(s.label).width)) + 12;
  const valueW = 66;
  const barMax = W - M.left - M.right - nameW - valueW;

  sorted.forEach((s, i) => {
    const v = s.points[0].value;
    const top = M.top + i * ROW_H;
    const color = fitToSurface((s.army && ARMY_COLORS[s.army]) || DEFAULT_ARMY_COLOR, SURFACE);

    ctx.font = `12px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = s.eliminated ? INK_MUTED : INK;
    ctx.fillText(`${s.label}${s.eliminated ? ' (out)' : ''}`, M.left, top + 16);

    const barX = M.left + nameW;
    const barW = Math.max(2, (v / maxVal) * barMax);
    const barY = top + 5;
    const barH = 15;
    // Rounded at the data end only — the other end is anchored to the baseline.
    ctx.fillStyle = color;
    ctx.globalAlpha = s.eliminated ? 0.45 : 1;
    ctx.beginPath();
    const r = Math.min(4, barW);
    ctx.moveTo(barX, barY);
    ctx.lineTo(barX + barW - r, barY);
    ctx.quadraticCurveTo(barX + barW, barY, barX + barW, barY + r);
    ctx.lineTo(barX + barW, barY + barH - r);
    ctx.quadraticCurveTo(barX + barW, barY + barH, barX + barW - r, barY + barH);
    ctx.lineTo(barX, barY + barH);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.textAlign = 'left';
    ctx.fillStyle = INK_MUTED;
    ctx.fillText(fmtK(v), barX + barW + 8, barY + 12);
  });

  return canvas.toBuffer('image/png');
}
