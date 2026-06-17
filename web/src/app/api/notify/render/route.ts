import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import sharp from 'sharp';

// Units we pick from for the "grunt radioing the commander" voice + matching sprite.
// All exist as animated per-army sprites at terrain/ani/<code><unit>.gif on AWBW.
const UNIT_POOL = ['infantry', 'mech', 'recon', 'tank', 'artillery', 'b-copter'] as const;

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
    // Current player's army, e.g. { code: 'os', name: 'Orange Star' }.
    const army = (body.army || {}) as { code?: string; name?: string };

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

    // Pick the unit once — both the voice and the attached sprite use it.
    const unit = UNIT_POOL[Math.floor(Math.random() * UNIT_POOL.length)];
    const armyName = army.name || '';
    const who = playerName || 'Commander';

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

        const genPrompt =
          `You are a single ${armyName ? armyName + ' ' : ''}${unit} unit in an Advance Wars By Web battle, ` +
          `radioing your commander ${who} over a crackly field radio because it's their turn and you need orders. ` +
          `Voice: a grunt soldier — clipped radio comms ("come in", "over", "say again", "five by five"), real personality ` +
          `(weary, eager, gallows humor), loyal to your army. Address the commander by name. You don't know grand strategy; ` +
          `you're holding the line and asking what to do.\n` +
          `Write the radio transmission, ideally under 160 characters. Use the exact name "${who}".${day ? ` It is day ${day}.` : ''}\n` +
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
                    `Pick the best in-character radio call from a ${armyName || ''} ${unit} grunt to commander ${who}. ` +
                    `Criteria, in priority order: most in-character and genuinely funny; clearly conveys it's ${who}'s turn ` +
                    `(grunt needs orders); lands a callback to the chatter ONLY if there's a real hook; tight (ideally under ~160 chars); ` +
                    `not cringe or mean. Keep "Over." style if present.\n` +
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

    // Attach the current army's animated unit sprite (color-correct, instant, free).
    // Upscaled with nearest-neighbor so it stays crisp/pixelly — fitting for a retro game.
    let imageData: string | null = null;
    let imageContentType: string | null = null;
    let imageFilename: string | null = null;
    if (enableFun && army.code && /^[a-z]{2,3}$/.test(army.code)) {
      try {
        const spriteUrl = `https://awbw.amarriner.com/terrain/ani/${army.code}${unit}.gif`;
        const res = await fetch(spriteUrl);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          const meta = await sharp(buf, { animated: true }).metadata();
          const baseW = meta.width || 16;
          const scale = Math.max(1, Math.round(128 / baseW)); // ~128px, integer scale = crisp pixels
          const up = await sharp(buf, { animated: true })
            .resize({ width: baseW * scale, kernel: 'nearest' })
            .gif()
            .toBuffer();
          imageData = up.toString('base64');
          imageContentType = 'image/gif';
          imageFilename = `${army.code}${unit}.gif`;
        } else {
          console.warn(`Sprite fetch failed ${res.status} for ${spriteUrl}`);
        }
      } catch (err) {
        console.error('Sprite attach failed (continuing text-only)', err);
      }
    }

    return NextResponse.json({
      text,
      unit,
      imageData: imageData || undefined,
      imageContentType: imageContentType || undefined,
      imageFilename: imageFilename || undefined,
    });
  } catch (err) {
    console.error('Render error', err);
    return NextResponse.json({ error: 'Render failed' }, { status: 500 });
  }
}
