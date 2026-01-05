import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { gameId, day, playerName, link } = body as {
      gameId?: string;
      day?: number;
      playerName?: string;
      link?: string;
    };

    if (!gameId || !link) {
      return NextResponse.json({ error: 'gameId and link required' }, { status: 400 });
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    const useAi = !!openaiKey;
    let caption: string | null = null;

    if (useAi) {
      try {
        const client = new OpenAI({ apiKey: openaiKey });
        const dayPart = day ? ` It is day ${day}.` : '';
        const who = playerName ? ` ${playerName}` : ' your opponent';
        const prompt =
          `Write a playful, under-140-character comm-tower alert for a turn reminder in an Advance Wars By Web game.${dayPart}` +
          ` Mention${who} without using any numbers, and do NOT include URLs or game IDs. Tone: witty but concise.`;
        const res = await client.chat.completions.create({
          model: process.env.FUN_MODE_MODEL_TEXT || 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 80,
          temperature: 0.8,
        });
        caption = res.choices[0]?.message?.content?.trim() || null;
        if (caption && caption.length > 180) caption = caption.slice(0, 180);
      } catch (err) {
        console.error('AI render failed', err);
        caption = null;
      }
    }

    const parts = caption
      ? [caption, link]
      : [
          'Next turn is up.',
          day ? `Day ${day}.` : '',
          playerName ? `${playerName}, you’re up.` : '',
          link,
        ];

    const text = parts.filter(Boolean).join(' ').trim();

    return NextResponse.json({ text });
  } catch (err) {
    console.error('Render error', err);
    return NextResponse.json({ error: 'Render failed' }, { status: 500 });
  }
}

