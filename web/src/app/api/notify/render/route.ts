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
        const who = playerName ? ` ${playerName}` : ' your opponent';
        const playersList =
          Array.isArray(body.players) && body.players.length
            ? ` Players in game: ${body.players.join(', ')}.`
            : '';
        // Optional recent group-chat context to riff on.
        const recentChat = Array.isArray(body.recentChat)
          ? (body.recentChat as Array<{ name?: string; text?: string }>)
              .filter((c) => c && typeof c.text === 'string' && c.text.trim())
              .slice(-6)
          : [];
        const chatBlock = recentChat.length
          ? `\nRecent group chat (oldest first):\n` +
            recentChat
              .map((c) => `${(c.name || 'someone').slice(0, 24)}: ${String(c.text).slice(0, 160)}`)
              .join('\n') +
            `\nIf there's a natural, good-natured hook in that chat, work a quick nod to it into the alert; if nothing fits, just give the turn reminder. Don't quote anything sensitive or mean-spirited, and don't force it.`
          : '';
        const prompt =
          `Write a playful, under-140-character comm-tower alert for a turn reminder in an Advance Wars By Web game.` +
          ` Mention${who} without using any placeholders; if a name is unknown, say "your opponent".` +
          ` Do NOT invent names; only use the provided player names/COs if given. Tone: witty but concise.${playersList}${chatBlock}`;
        const res = await client.chat.completions.create({
          model: process.env.FUN_MODE_MODEL_TEXT || 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 90,
          temperature: 0.85,
        });
        caption = res.choices[0]?.message?.content?.trim() || null;
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

