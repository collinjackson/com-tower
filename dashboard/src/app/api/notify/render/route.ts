import { NextRequest, NextResponse } from 'next/server';
import { holoGlow } from '@/lib/armies';
import { getAdminDb, adminAvailable } from '@/lib/firebase-admin';
import { FEATURED_LABELS, FEATURED_METRICS, pickMetric, type FeaturedMetric } from '@/lib/featured';
import { buildFeaturedGif, spriteFrames, spriteUrl } from '@/lib/featured-chart';
import { samplesToSeries, settledSamples, type Series, type TurnSampleDoc } from '@/lib/turn-series';
import type { Image } from '@napi-rs/canvas';

// Per-country facing — all units of a country face the same way (the barrel/
// front reaches the left edge of the cell for these; everyone else faces right).
// Used to put the hologram's lead room on the side it's looking.
const FACE_LEFT = new Set(['bm', 'yc', 'bh', 'rf', 'ab', 'pc', 'tg', 'ar', 'ne', 'sc']);

// Recolor curve + background + grain for a faction's hologram. Glow-on-black:
// per channel, luminance L maps linearly from a dark tinted FLOOR (L=0) to a
// bright HIGHLIGHT (L=255), so out_c = A*L + B. The highlight is a VIVID version
// of the hue (max channel pushed to 255 — brightens warm colors without washing
// them) plus a white bloom that's strong for cool colors (blue/purple read dark
// and need icy specular highlights) and near-zero for warm ones (orange/yellow
// stay saturated). The dark field + per-pixel gradient give the projection depth.
const FLOOR_FRAC = 0.22; // dark-tint floor as a fraction of the glow color
function holoSpec(code?: string) {
  const G = holoGlow(code);
  const Gv = G.map((c) => Math.min(255, Math.round((c * 255) / Math.max(...G))));
  const blueDom = (Gv[2] - (Gv[0] + Gv[1]) / 2) / 255; // +cool .. -warm
  const w = Math.max(0, Math.min(0.45, 0.22 + 0.3 * blueDom));
  const lo = G.map((c) => c * FLOOR_FRAC);
  const hi = Gv.map((c) => c + (255 - c) * w);
  return {
    A: G.map((c, i) => (hi[i] - lo[i]) / 255) as [number, number, number],
    B: lo as [number, number, number],
    bg: { r: 2, g: 6, b: 12 },
    grain: [210, 235, 255] as [number, number, number],
  };
}

// Hologram overlays, built as raw RGBA buffers ready for sharp.composite().
// Scanlines: one dark row every 3px, tiled down the frame.
function holoScanlines(w: number) {
  const period = 3;
  const buf = Buffer.alloc(w * period * 4, 0);
  for (let x = 0; x < w; x++) buf[((period - 1) * w + x) * 4 + 3] = 120; // alpha-only black line
  return { input: buf, raw: { width: w, height: period, channels: 4 as const }, tile: true, blend: 'over' as const };
}
// Grain: sparse speckles over the whole field (full height -> per-frame flicker).
function holoGrain(w: number, h: number, [gr, gg, gb]: [number, number, number]) {
  const buf = Buffer.alloc(w * h * 4, 0);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    buf[o] = gr; buf[o + 1] = gg; buf[o + 2] = gb;
    buf[o + 3] = Math.round(Math.random() ** 3 * 40); // cube bias -> mostly transparent
  }
  return { input: buf, raw: { width: w, height: h, channels: 4 as const }, blend: 'over' as const };
}

/** The turn ping's featured chart: the stat that moved most over the last round (never the one
 *  featured last time), as an animated GIF with each player's soldier riding their line. Null
 *  until a game has a few recorded turns; the ping then keeps its hologram. Best-effort. */
async function featuredChart(gameId: string): Promise<{ data: Buffer; metric: FeaturedMetric } | null> {
  if (!adminAvailable) return null;
  const db = getAdminDb();
  const gameRef = db.collection('games').doc(gameId);
  const [snap, game] = await Promise.all([
    gameRef.collection('turnStats').orderBy('day', 'asc').limit(600).get(),
    gameRef.get(),
  ]);
  const docs = settledSamples(snap.docs.map((d) => d.data() as TurnSampleDoc));
  const byMetric: Partial<Record<FeaturedMetric, Series[]>> = {};
  for (const m of FEATURED_METRICS) byMetric[m] = samplesToSeries(docs, m);
  const previous = (game.data() as { lastFeaturedMetric?: string } | undefined)?.lastFeaturedMetric;
  const metric = pickMetric(byMetric, previous);
  if (!metric) return null;
  const series = byMetric[metric]!;
  const sprites = new Map<string, Image[]>();
  await Promise.all(
    series.map(async (s) => {
      if (!s.army || !/^[a-z]{2,3}$/.test(s.army)) return;
      const res = await fetch(spriteUrl(s.army));
      if (res.ok) sprites.set(s.key, await spriteFrames(new Uint8Array(await res.arrayBuffer())));
    })
  );
  const gif = await buildFeaturedGif({
    series,
    title: FEATURED_LABELS[metric],
    isMoney: metric === 'armyValue' || metric === 'income',
    sprites,
  });
  await gameRef.set({ lastFeaturedMetric: metric }, { merge: true });
  return { data: gif.data, metric };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { gameId, day, playerName, link, enableFun } = body as {
      gameId?: string;
      day?: number;
      playerName?: string;
      link?: string;
      // Attach the hologram image (unit sprite or CO portrait). The text is the same either way.
      enableFun?: boolean;
    };
    const army = (body.army || {}) as { code?: string };
    const unit = (body.unit || {}) as { name?: string };
    // The bot sends a CO instead of a unit early in the game or when a CO power is charged.
    const co = (body.co || {}) as { name?: string; imageUrl?: string };
    // Turn-reminder mode: how long the player has been sitting on their turn (e.g. "2d 4h").
    const reminderElapsed = typeof body.reminderElapsed === 'string' ? body.reminderElapsed.trim().slice(0, 20) : '';
    const isReminder = !!reminderElapsed;

    if (!gameId || !link) {
      return NextResponse.json({ error: 'gameId and link required' }, { status: 400 });
    }

    const who = playerName || 'Commander';
    // Sprite-file form of the unit name: "B-Copter" -> "b-copter", "Md.Tank" -> "md.tank".
    const unitName = (unit.name || '').trim();
    const unitFile = unitName.toLowerCase().replace(/[^a-z0-9.-]/g, '');

    const parts = isReminder
      ? [`⏰ Still your move, ${who} — ${reminderElapsed} on the clock.`, link]
      : [
          day ? `Day ${day}.` : '',
          playerName ? `${playerName}, you’re up.` : 'New turn.',
          link,
        ];
    const text = parts.filter(Boolean).join(' ').trim();

    // Attach the army's unit sprite as a Star Wars-style hologram: a cyan,
    // scanlined, grainy projection on a near-black field. Best-effort.
    // The black background means we never render a real terrain tile — which
    // sidesteps tall tiles (HQ/mountain 16x32) that broke the in-cell backdrop.
    let imageData: string | null = null;
    let imageContentType: string | null = null;
    let imageFilename: string | null = null;
    // Why no image was attached, for the bot's logs (null once an image is built).
    let imageSkipReason: string | null = enableFun
      ? unitFile || co.imageUrl
        ? null
        : 'no-unit-and-no-co-portrait'
      : 'image-off';
    // A chart of how the game is going comes first; the hologram is the fallback.
    if (enableFun && gameId) {
      try {
        const chart = await featuredChart(gameId);
        if (chart) {
          imageData = chart.data.toString('base64');
          imageContentType = 'image/gif';
          imageFilename = `${chart.metric}.gif`;
          imageSkipReason = null;
        }
      } catch (err) {
        console.warn(`Featured chart failed for game ${gameId} (falling back to the hologram)`, err);
      }
    }
    if (!imageData && enableFun && army.code && /^[a-z]{2,3}$/.test(army.code) && unitFile) {
      try {
        const sharp = (await import('sharp')).default;
        const spriteUrl = `https://awbw.amarriner.com/terrain/ani/${army.code}${unitFile}.gif`;
        const sres = await fetch(spriteUrl);
        if (sres.ok) {
          // Typed as Uint8Array (sharp accepts it) to avoid the strict Buffer<ArrayBuffer> generic.
          const orig: Uint8Array = Buffer.from(await sres.arrayBuffer());
          const meta = await sharp(orig, { animated: true }).metadata();
          const baseW = meta.width || 16;
          const pageH = meta.pageHeight || baseW;
          const pages = meta.pages || 1;
          const scale = Math.max(1, Math.round(128 / baseW));
          const outW = baseW * scale;
          const outFullH = pageH * pages * scale;

          // Recolor to the faction's hologram (desaturate to luminance, then a
          // per-channel linear curve — .linear leaves alpha alone, so no opaque
          // color box), flatten on its field, upscale nearest, then scanlines +
          // grain. Single sharp chain: the GIF is quantized only once (repeated
          // GIF re-encoding mangles the palette and kills the color).
          // Margin of the dark field around each frame so cropped chat previews
          // don't clip the unit. Asymmetric: extra lead room on the side the unit
          // faces, and the unit sits slightly below center (more headroom).
          // extend() pads per-page on animated GIFs; scanlines/grain then cover
          // the full padded frame.
          const facesRight = !(army.code && FACE_LEFT.has(army.code));
          const m = Math.round(outW * 0.22);
          const lead = Math.round(m * 1.55), back = Math.round(m * 0.45);
          const left = facesRight ? back : lead;
          const right = facesRight ? lead : back;
          const top = Math.round(m * 1.3), bottom = Math.round(m * 0.7);
          const padW = outW + left + right;
          const padFullH = outFullH + (top + bottom) * pages;
          const spec = holoSpec(army.code);
          const out = await sharp(orig, { animated: true })
            .modulate({ saturation: 0 })
            .linear(spec.A, spec.B)
            .flatten({ background: spec.bg })
            .resize({ width: outW, kernel: 'nearest' })
            .extend({ top, bottom, left, right, background: { ...spec.bg, alpha: 1 } })
            .composite([holoScanlines(padW), holoGrain(padW, padFullH, spec.grain)])
            .gif()
            .toBuffer();
          imageData = out.toString('base64');
          imageContentType = 'image/gif';
          imageFilename = `${army.code}${unitFile}.gif`;
          imageSkipReason = null;
        } else {
          imageSkipReason = `sprite-fetch-${sres.status}`;
          console.warn(`Sprite fetch failed ${sres.status} for ${spriteUrl}`);
        }
      } catch (err) {
        imageSkipReason = 'sprite-transform-error';
        console.error('Sprite attach failed (continuing text-only)', err);
      }
    } else if (enableFun && unitFile && !imageData) {
      imageSkipReason = 'missing-or-invalid-army-code';
    }

    // No unit to feature — holographize the player's CO portrait instead. Same
    // effect (desaturate -> faction-color glow -> scanlines + grain on a black
    // field); the color uses the army when known, else the default teal.
    if (!imageData && enableFun && co.imageUrl) {
      try {
        const sharp = (await import('sharp')).default;
        const cres = await fetch(co.imageUrl);
        if (cres.ok) {
          const orig: Uint8Array = Buffer.from(await cres.arrayBuffer());
          const meta = await sharp(orig).metadata();
          const baseW = meta.width || 48;
          const baseH = meta.height || baseW;
          const scale = Math.max(1, Math.round(144 / baseW));
          const outW = baseW * scale;
          const outH = baseH * scale;
          const m = Math.round(outW * 0.18); // centered margin so previews don't clip the CO
          const padW = outW + m * 2;
          const padH = outH + m * 2;
          const spec = holoSpec(army.code);
          const out = await sharp(orig)
            .modulate({ saturation: 0 })
            .linear(spec.A, spec.B)
            .flatten({ background: spec.bg })
            .resize({ width: outW, kernel: 'nearest' })
            .extend({ top: m, bottom: m, left: m, right: m, background: { ...spec.bg, alpha: 1 } })
            .composite([holoScanlines(padW), holoGrain(padW, padH, spec.grain)])
            .gif()
            .toBuffer();
          imageData = out.toString('base64');
          imageContentType = 'image/gif';
          imageFilename = `co-${(co.name || 'co').toLowerCase().replace(/[^a-z0-9]/g, '')}.gif`;
          imageSkipReason = null;
        } else {
          imageSkipReason = `co-fetch-${cres.status}`;
          console.warn(`CO portrait fetch failed ${cres.status} for ${co.imageUrl}`);
        }
      } catch (err) {
        imageSkipReason = 'co-transform-error';
        console.error('CO portrait attach failed (continuing text-only)', err);
      }
    }
    if (enableFun && !imageData) {
      console.warn(`Render for game ${gameId}: no image attached (${imageSkipReason || 'unknown'})`);
    }

    return NextResponse.json({
      text,
      unit: unitName || undefined,
      imageData: imageData || undefined,
      imageContentType: imageContentType || undefined,
      imageFilename: imageFilename || undefined,
      imageSkipReason: imageSkipReason || undefined,
    });
  } catch (err) {
    console.error('Render error', err);
    return NextResponse.json({ error: 'Render failed' }, { status: 500 });
  }
}