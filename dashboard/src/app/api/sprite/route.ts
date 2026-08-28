import { NextResponse } from 'next/server';

// AWBW unit sprites are animated GIFs. The dispatch cards want a still, printed in one ink on
// paper — so the frame is pulled and treated here rather than shown as AWBW draws it.
export const revalidate = 86400;

const ALLOWED_HOST = 'awbw.amarriner.com';
// The ink the press is loaded with. Warm near-black, so it sits on the card stock rather than
// looking like a black PNG dropped onto it.
const INK = { r: 38, g: 34, b: 26 };

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get('u');
  if (!raw) return NextResponse.json({ error: 'missing u' }, { status: 400 });

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return NextResponse.json({ error: 'bad url' }, { status: 400 });
  }
  // Never a general-purpose proxy: only AWBW's own art, over https.
  if (target.protocol !== 'https:' || target.hostname !== ALLOWED_HOST) {
    return NextResponse.json({ error: 'host not allowed' }, { status: 403 });
  }

  try {
    const res = await fetch(target.toString());
    if (!res.ok) return NextResponse.json({ error: `upstream ${res.status}` }, { status: 502 });
    const input = Buffer.from(await res.arrayBuffer());

    const sharp = (await import('sharp')).default;
    // Without { animated: true } sharp decodes the first frame only — which is the point.
    const out = await sharp(input)
      .ensureAlpha()
      .grayscale()
      // Contrast, the way a press loses the midtones — but not so hard that the sprite
      // crushes to a silhouette and stops reading as a unit.
      .linear(1.35, -24)
      .tint(INK)
      // Nearest-neighbour so the pixel art stays crisp instead of turning to mush.
      .resize({ width: 96, kernel: 'nearest', fit: 'inside', withoutEnlargement: false })
      .png()
      .toBuffer();

    return new NextResponse(new Uint8Array(out), {
      headers: {
        'Content-Type': 'image/png',
        // Sprites never change, so this can be cached hard.
        'Cache-Control': 'public, max-age=86400, s-maxage=604800, immutable',
      },
    });
  } catch (err) {
    console.error('sprite render failed', err);
    return NextResponse.json({ error: 'sprite failed' }, { status: 500 });
  }
}
