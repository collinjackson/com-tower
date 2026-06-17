import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { gameId, day, playerName, link, includeImage, enableFun } = body as {
      gameId?: string;
      day?: number;
      playerName?: string;
      link?: string;
      enableFun?: boolean;
      includeImage?: boolean;
    };

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

    let caption: string | null = null;

    if (useAi) {
      try {
        const client = new OpenAI({ apiKey: openaiKey });
        const model = process.env.FUN_MODE_MODEL_TEXT || 'gpt-4o-mini';
        const judgeModel = process.env.FUN_MODE_JUDGE_MODEL || model;
        const candidateCount = Math.max(1, Math.min(20, Number(process.env.FUN_MODE_CANDIDATES) || 10));
        const who = playerName || 'your opponent';
        const playersList =
          Array.isArray(body.players) && body.players.length
            ? `Players: ${body.players.join(', ')}. `
            : '';
        // Optional recent group-chat context to riff on.
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
            `\nIf there's a genuinely funny hook in the chatter, deliver a withering callback to it; otherwise just a contemptuous summons. Don't quote verbatim or punch down cruelly.`
          : `No chatter — just a contemptuous summons to take their turn.`;
        const genPrompt =
          `You are THE ADMINISTRATOR — a sardonic, imperious war-room announcer presiding over an Advance Wars By Web match as if it were your personal blood sport. You address commanders with theatrical contempt, clipped military-radio cadence, and dry menace. Use comms/brevity flavor naturally when it fits (comms check, five by five, stand by, hold, over, say again) but don't pile it on. Never warm, never cringe; your amusement is always at their expense — playful, not genuinely cruel.\n` +
          `Announce that it is ${who}'s turn, ideally under 160 characters.` +
          `${playerName ? ` Use the exact name "${playerName}".` : ''}` +
          ` Do NOT invent commander names; only use ones given.${day ? ` It is day ${day}.` : ''} ${playersList}\n` +
          `${chatBlock}\n` +
          `Output ONLY the announcement — no surrounding quotes. Emoji: none, or one at most.`;

        // Best-of-N: generate diverse candidates, then judge picks the cleverest.
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
              .filter((t) => t.length > 0 && t.length <= 220)
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
                    `You are picking the best in-character announcement from THE ADMINISTRATOR (a sardonic, imperious war-room announcer) summoning ${who} to take their turn. Criteria, in priority order: ` +
                    `most darkly funny and in-character; lands a withering callback to the chatter ONLY if there's a real hook; ` +
                    `clearly conveys it's ${who}'s turn; tight (ideally under ~160 chars); playfully contemptuous, not genuinely cruel or cringe.\n` +
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

    let imageUrl: string | null = null;
    let imageData: string | null = null;
    let imageContentType: string | null = null;
    let imageFilename: string | null = null;
    const maxBytes = 3_000_000; // allow up to ~3MB inline

    if (useAi && includeImage) {
      try {
        const client = new OpenAI({ apiKey: openaiKey });
        const style = process.env.FUN_MODE_IMAGE_STYLE || 'pixel';
        const countryHint =
          Array.isArray(body.players) && body.players.length
            ? ` Country palette inspired by ${body.players.join(', ')}.`
            : '';
        const stylePrompt =
          style === 'anime'
            ? 'Anime-style interior of a comm tower control room; country-colored infantry unit on duty inside the tower; holographic tactical displays; teal/amber glow; no exterior view; no text.' +
              countryHint
            : 'Isometric pixel-art interior of a comm tower; country-colored infantry unit guarding inside the tower; holo maps and consoles; retro AWBW vibe; no exterior; no text.' +
              countryHint;
        const img = await client.images.generate({
          model: 'dall-e-3',
          prompt: `${stylePrompt} Caption: "${text}"`,
          size: '1024x1024',
        });
        imageUrl = img.data?.[0]?.url || null;
        if (!imageUrl) {
          throw new Error('Image generation returned no URL');
        }

        // Fetch image and inline it as base64 for Signal
        const res = await fetch(imageUrl);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > maxBytes) {
          throw new Error(`Image too large (${buf.byteLength} bytes)`);
        }
        imageContentType = res.headers.get('content-type') || 'image/png';
        imageFilename =
          imageUrl.split('/').pop()?.split('?')[0] || `image-${Date.now()}.png`;
        imageData = buf.toString('base64');
      } catch (err) {
        console.error('Image generation failed', err);
        return NextResponse.json(
          { error: err instanceof Error ? err.message : 'Image generation failed' },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      text,
      imageUrl: imageUrl || undefined, // debug only
      imageData: imageData || undefined,
      imageContentType: imageContentType || undefined,
      imageFilename: imageFilename || undefined,
    });
  } catch (err) {
    console.error('Render error', err);
    return NextResponse.json({ error: 'Render failed' }, { status: 500 });
  }
}

