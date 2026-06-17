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
          ? `Recent group chat (oldest first):\n` +
            recentChat
              .map((c) => `  ${(c.name || 'someone').slice(0, 24)}: ${String(c.text).slice(0, 160)}`)
              .join('\n') +
            `\nIf there's a genuinely funny hook in the chat, land a quick callback to it; if not, just be a sharp turn reminder. Don't quote verbatim, sensitive, or mean-spirited content, and don't force it.`
          : `No recent chat — just be a sharp, witty turn reminder.`;
        const genPrompt =
          `You are "Com Tower", a deadpan military-comms AI that pings Advance Wars By Web players when it's their turn.` +
          ` Voice: dry, quick, a little mischievous — a war-room operator who's seen it all. Never cringe, never mean.\n` +
          `Write a turn-reminder alert, UNDER 140 characters, telling ${who} it's their turn` +
          `${playerName ? ` (use the exact name "${playerName}")` : ''}.` +
          ` Do NOT invent player names; only use ones given.${day ? ` It is day ${day}.` : ''} ${playersList}\n` +
          `${chatBlock}\n` +
          `Output ONLY the alert text — no surrounding quotes, at most one emoji.`;

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
                    `Pick the single best turn-reminder alert for ${who}. Criteria, in priority order: ` +
                    `genuinely funny/clever; lands a natural callback to the chat ONLY if there's a real hook; ` +
                    `clearly says it's ${who}'s turn; under 140 chars; not mean or cringe; ` +
                    `prefer ones that don't open with a generic "it's your turn".\n` +
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
        if (caption && caption.length > 180) caption = caption.slice(0, 180);
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

