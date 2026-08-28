import { ARMY_COLORS, DEFAULT_ARMY_COLOR, SERIES_DASHES, fitToSurface } from './armies';

export const SURFACE = '#12140f';
const INK = '#d7dbc9';
const INK_MUTED = '#8b9180';
const GRID = '#2a2e24';

export type Sample = { day: number; order: number; value: number };
export type Series = {
  key: string;
  label: string;
  army?: string;
  eliminated?: boolean;
  points: Sample[];
};

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Round to a readable axis step (1/2/5 x 10^n). */
function niceStep(range: number, targetTicks: number) {
  const raw = range / Math.max(1, targetTicks);
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
}

const fmtK = (v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v)));

/**
 * A line chart of one measure over the course of a game, one line per player.
 *
 * Static by necessity: this is rasterised and posted into Signal as an image, so there is no
 * hover layer to lean on. Everything a tooltip would have carried is therefore on the face of
 * the chart — every line is directly labelled with its player and latest value, and the axes
 * are labelled rather than relying on a legend lookup.
 */
export function buildChartSvg(opts: {
  series: Series[];
  title: string;
  subtitle?: string;
  yLabel: string;
  width?: number;
  height?: number;
}): string {
  const W = opts.width ?? 900;
  const H = opts.height ?? 470;
  // The right margin has to be measured, not guessed: it holds the direct labels, and a fixed
  // value clips the longest name the moment someone has a long username or a five-digit value.
  // Monospace makes this exact — every glyph is ~0.6em, so 11px text is ~6.6px per character.
  const longestLabel = Math.max(
    12,
    ...opts.series.map((s) => {
      const last = s.points[s.points.length - 1];
      return `${s.label}${s.eliminated ? ' ✕' : ''}  ${last ? fmtK(last.value) : ''}`.length;
    })
  );
  const M = { top: 54, right: Math.ceil(longestLabel * 6.7) + 20, bottom: 44, left: 66 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;

  const all = opts.series.flatMap((s) => s.points);
  if (all.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${SURFACE}"/>
  <text x="${W / 2}" y="${H / 2}" fill="${INK_MUTED}" font-family="DejaVu Sans Mono, Menlo, monospace" font-size="14" text-anchor="middle">No turns recorded yet</text>
</svg>`;
  }

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

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans Mono, Menlo, Consolas, monospace">`,
    `<rect width="${W}" height="${H}" fill="${SURFACE}"/>`,
    `<text x="${M.left}" y="26" fill="${INK}" font-size="15">${esc(opts.title)}</text>`
  );
  if (opts.subtitle) {
    parts.push(`<text x="${M.left}" y="43" fill="${INK_MUTED}" font-size="11">${esc(opts.subtitle)}</text>`);
  }

  // Recessive grid: horizontal only, so it never competes with the lines.
  // 6 target ticks rather than 5: at 5 the ladder rounds a ~250k range up to a 100k step and
  // the plot is left with two gridlines.
  const step = niceStep(yTop, 6);
  for (let v = 0; v <= yTop; v += step) {
    const gy = y(v);
    parts.push(
      `<line x1="${M.left}" y1="${gy.toFixed(1)}" x2="${M.left + plotW}" y2="${gy.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`,
      `<text x="${M.left - 8}" y="${(gy + 3.5).toFixed(1)}" fill="${INK_MUTED}" font-size="10" text-anchor="end">${fmtK(v)}</text>`
    );
  }
  parts.push(
    `<text x="${M.left - 46}" y="${M.top + plotH / 2}" fill="${INK_MUTED}" font-size="10" text-anchor="middle" transform="rotate(-90 ${M.left - 46} ${M.top + plotH / 2})">${esc(opts.yLabel)}</text>`
  );

  // X ticks on day boundaries, thinned so labels never collide.
  const dayCount = maxDay - minDay + 1;
  const dayStep = Math.max(1, Math.ceil(dayCount / 12));
  for (let d = minDay; d <= maxDay; d += dayStep) {
    const tx = x({ day: d, order: 0, value: 0 });
    parts.push(
      `<text x="${tx.toFixed(1)}" y="${M.top + plotH + 18}" fill="${INK_MUTED}" font-size="10" text-anchor="middle">${d}</text>`
    );
  }
  parts.push(
    `<text x="${M.left + plotW / 2}" y="${H - 8}" fill="${INK_MUTED}" font-size="10" text-anchor="middle">Day</text>`,
    `<line x1="${M.left}" y1="${M.top + plotH}" x2="${M.left + plotW}" y2="${M.top + plotH}" stroke="${GRID}" stroke-width="1.5"/>`
  );

  // Lines, then direct labels. Drawn in a stable order so colour follows the player, never
  // their current rank.
  const labelSlots: Array<{ yWanted: number; text: string; color: string }> = [];
  opts.series.forEach((s, i) => {
    const pts = [...s.points].sort((a, b) => a.day - b.day || a.order - b.order);
    if (pts.length === 0) return;
    const color = fitToSurface((s.army && ARMY_COLORS[s.army]) || DEFAULT_ARMY_COLOR, SURFACE);
    const dash = SERIES_DASHES[i % SERIES_DASHES.length];
    const d = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    parts.push(
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}${s.eliminated ? ' opacity="0.45"' : ''}/>`
    );
    const last = pts[pts.length - 1];
    // A marker on the latest point only — a dot on every sample would be noise.
    parts.push(
      `<circle cx="${x(last).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="3.5" fill="${color}" stroke="${SURFACE}" stroke-width="2"/>`
    );
    labelSlots.push({
      yWanted: y(last.value),
      text: `${s.label}${s.eliminated ? ' ✕' : ''}  ${fmtK(last.value)}`,
      color,
    });
  });

  // Nudge labels apart so two players at similar values do not overprint.
  labelSlots.sort((a, b) => a.yWanted - b.yWanted);
  let prev = -Infinity;
  for (const slot of labelSlots) {
    const ly = Math.max(slot.yWanted, prev + 14);
    prev = ly;
    parts.push(
      `<text x="${M.left + plotW + 10}" y="${(ly + 3.5).toFixed(1)}" fill="${slot.color}" font-size="11">${esc(slot.text)}</text>`
    );
  }

  parts.push('</svg>');
  return parts.join('\n');
}
