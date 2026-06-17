import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

// AWBW country code -> army name (for voice flavor). Unknown codes just omit the name.
const ARMY_NAMES: Record<string, string> = {
  os: 'Orange Star', bm: 'Blue Moon', ge: 'Green Earth', yc: 'Yellow Comet', bh: 'Black Hole',
  rf: 'Red Fire', gs: 'Grey Sky', bd: 'Brown Desert', ab: 'Amber Blaze', js: 'Jade Sun',
  ci: 'Cobalt Ice', pc: 'Pink Cosmos', tg: 'Teal Galaxy', pl: 'Purple Lightning', ar: 'Acid Rain',
  wn: 'White Nova', sc: 'Silver Claw',
};

// Sprite-file unit name -> a fitting terrain tile to stand on.
function terrainForUnit(unitFile: string): string {
  if (/lander|cruiser|sub|battleship|carrier|blackboat/.test(unitFile)) return 'sea';
  if (/mech/.test(unitFile)) return 'mountain';
  if (/infantry/.test(unitFile)) return 'wood';
  return 'plain';
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { gameId, day, playerName, link, enableFun } = body as {
      gameId?: string;
      day?: number;
      playerName?: string;
      link?: string;
      enableFun?: boolean;
    };
    const army = (body.army || {}) as { code?: string };
    const unit = (body.unit || {}) as { name?: string; hp?: number; fuel?: number };

    if (!gameId || !link) {
      return NextResponse.json({ error: 'gameId and link required' }, { status: 400 });
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    const useAi = !!openaiKey && !!enableFun;
    if (enableFun && !openaiKey) {
      console.error('Render error: enableFun requested but OPENAI_API_KEY missing');
      return NextResponse.json(
        { error: 'Fun mode requested but OPENAI_API_KEY is not configured' },
        { status: 500 }
      );
    }

    const armyName = (army.code && ARMY_NAMES[army.code]) || '';
    const who = playerName || 'Commander';
    // Sprite-file form of the unit name: "B-Copter" -> "b-copter", "Md.Tank" -> "md.tank".
    const unitName = (unit.name || '').trim();
    const unitFile = unitName.toLowerCase().replace(/[^a-z0-9.-]/g, '');
    const hp = typeof unit.hp === 'number' ? unit.hp : undefined;
    const lowFuel = typeof unit.fuel === 'number' && unit.fuel <= 12;

    let caption: string | null = null;

    if (useAi) {
      try {
        const client = new OpenAI({ apiKey: openaiKey });
        const model = process.env.FUN_MODE_MODEL_TEXT || 'gpt-4o-mini';
        const judgeModel = process.env.FUN_MODE_JUDGE_MODEL || model;
        const candidateCount = Math.max(1, Math.min(20, Number(process.env.FUN_MODE_CANDIDATES) || 10));

        const recentChat = Array.isArray(body.recentChat)
          ? (body.recentChat as Array<{ name?: string; text?: string }>)
              .filter((c) => c && typeof c.text === 'string' && c.text.trim())
              .slice(-6)
          : [];
        const chatBlock = recentChat.length
          ? `Recent chatter (oldest first):\n` +
            recentChat
              .map((c) => `  ${(c.name || 'someone').slice(0, 24)}: ${String(c.text).slice(0, 160)}`)
              .join('\n') +
            `\nIf there's a genuinely funny hook in the chatter, the grunt can gripe or joke about it; otherwise just call in for orders. No verbatim quoting or cruelty.`
          : `No chatter — just call in for orders.`;

        // Ground the mood in the unit's REAL condition. Never invent damage/combat.
        const condition =
          hp !== undefined && hp < 10
            ? `You've taken a beating (down to ${hp}/10 HP) — you may sound weary, rattled, or scraped up, but do NOT invent specific casualties or battles.`
            : `You are at FULL strength and unscratched. Do NOT claim any damage, casualties, low ammo, or combat. Pick a mood befitting an idle soldier awaiting orders: bored, restless, cocky, antsy, over-caffeinated, itching to move.`;
        const subject = unitName
          ? `a single ${armyName ? armyName + ' ' : ''}${unitName} unit`
          : `${armyName ? armyName + ' ' : 'field'} command`;

        const genPrompt =
          `You are ${subject} in an Advance Wars By Web battle, radioing your commander ${who} over a crackly ` +
          `field radio because it's ${who}'s turn and you need orders. Voice: a grunt soldier — clipped radio comms ` +
          `("come in", "over", "say again", "five by five"), real personality, loyal to your army. Address the commander by name. ` +
          `You don't know grand strategy; you just need to know what to do.\n` +
          `GROUND IT IN REALITY — only use what's stated here, invent nothing about the battle: ${condition}` +
          `${lowFuel ? ' Fuel is running low.' : ''}\n` +
          `Write the transmission, ideally under 160 characters. Use the exact name "${who}".${day ? ` It is day ${day}.` : ''}\n` +
          `${chatBlock}\n` +
          `Output ONLY the transmission — no surrounding quotes. Emoji: none, or one at most.`;

        const gen = await client.chat.completions.create({
          model,
          n: candidateCount,
          messages: [{ role: 'user', content: genPrompt }],
          max_tokens: 70,
          temperature: 1.05,
        });
        const candidates = Array.from(
          new Set(
            gen.choices
              .map((c) => (c.message?.content || '').trim().replace(/^["']|["']$/g, ''))
              .filter((t) => t.length > 0 && t.length <= 240)
          )
        );

        if (candidates.length === 1) {
          caption = candidates[0];
        } else if (candidates.length > 1) {
          try {
            const list = candidates.map((c, i) => `${i}. ${c}`).join('\n');
            const judgeRes = await client.chat.completions.create({
              model: judgeModel,
              temperature: 0.2,
              max_tokens: 60,
              response_format: { type: 'json_object' },
              messages: [
                {
                  role: 'user',
                  content:
                    `Pick the best in-character radio call from a ${armyName || ''} ${unitName || 'command'} grunt to commander ${who}. ` +
                    `Criteria, in priority order: most in-character and genuinely funny; stays true to the stated condition (no invented damage/combat); ` +
                    `clearly conveys it's ${who}'s turn (needs orders); lands a callback to the chatter ONLY if there's a real hook; tight (ideally under ~160 chars); not cringe or mean.\n` +
                    `Candidates:\n${list}\n` +
                    `Reply as JSON: {"best": <index>}`,
                },
              ],
            });
            const pick = JSON.parse(judgeRes.choices[0]?.message?.content || '{}');
            const idx = Number(pick.best);
            caption = candidates[Number.isInteger(idx) && candidates[idx] ? idx : 0];
          } catch (judgeErr) {
            console.warn('Fun-mode judge failed; using first candidate', judgeErr);
            caption = candidates[0];
          }
        }
        if (caption && caption.length > 240) caption = caption.slice(0, 240);
      } catch (err) {
        console.error('AI render failed', err);
        return NextResponse.json(
          { error: err instanceof Error ? err.message : 'AI render failed' },
          { status: 500 }
        );
      }
    }

    const parts = caption
      ? [caption, link]
      : ['Next turn is up.', playerName ? `${playerName}, you’re up.` : '', link];
    const text = parts.filter(Boolean).join(' ').trim();

    // Attach the army's animated unit sprite standing on a fitting terrain tile.
    // Real AWBW art, color-correct, nearest-neighbor upscaled (pixelly, retro). Best-effort.
    let imageData: string | null = null;
    let imageContentType: string | null = null;
    let imageFilename: string | null = null;
    if (enableFun && army.code && /^[a-z]{2,3}$/.test(army.code) && unitFile) {
      try {
        const sharp = (await import('sharp')).default;
        const spriteUrl = `https://awbw.amarriner.com/terrain/ani/${army.code}${unitFile}.gif`;
        const sres = await fetch(spriteUrl);
        if (sres.ok) {
          const unitBuf = Buffer.from(await sres.arrayBuffer());
          const meta = await sharp(unitBuf, { animated: true }).metadata();
          const baseW = meta.width || 16;
          const pageH = meta.pageHeight || baseW;
          const scale = Math.max(1, Math.round(128 / baseW));

          // Terrain backdrop tile, sized to one frame.
          let unitImg = sharp(unitBuf, { animated: true });
          try {
            const terrName = terrainForUnit(unitFile);
            const tres = await fetch(`https://awbw.amarriner.com/terrain/aw1/${terrName}.gif`);
            if (tres.ok) {
              const terr = await sharp(Buffer.from(await tres.arrayBuffer()))
                .resize(baseW, pageH, { kernel: 'nearest', fit: 'cover', position: 'bottom' })
                .png()
                .toBuffer();
              // dest-over draws the terrain BEHIND the unit; tile fills every animation frame.
              unitImg = unitImg.composite([{ input: terr, blend: 'dest-over', tile: true }]);
            }
          } catch (terrErr) {
            console.warn('Terrain backdrop failed (unit only)', terrErr);
          }

          const out = await unitImg
            .resize({ width: baseW * scale, kernel: 'nearest' })
            .gif()
            .toBuffer();
          imageData = out.toString('base64');
          imageContentType = 'image/gif';
          imageFilename = `${army.code}${unitFile}.gif`;
        } else {
          console.warn(`Sprite fetch failed ${sres.status} for ${spriteUrl}`);
        }
      } catch (err) {
        console.error('Sprite attach failed (continuing text-only)', err);
      }
    }

    return NextResponse.json({
      text,
      unit: unitName || undefined,
      imageData: imageData || undefined,
      imageContentType: imageContentType || undefined,
      imageFilename: imageFilename || undefined,
    });
  } catch (err) {
    console.error('Render error', err);
    return NextResponse.json({ error: 'Render failed' }, { status: 500 });
  }
}
