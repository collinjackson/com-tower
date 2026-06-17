import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

// AWBW country code -> army name (for voice flavor). Unknown codes just omit the name.
const ARMY_NAMES: Record<string, string> = {
  os: 'Orange Star', bm: 'Blue Moon', ge: 'Green Earth', yc: 'Yellow Comet', bh: 'Black Hole',
  rf: 'Red Fire', gs: 'Grey Sky', bd: 'Brown Desert', ab: 'Amber Blossom', js: 'Jade Sun',
  ci: 'Cobalt Ice', pc: 'Pink Cosmos', tg: 'Teal Galaxy', pl: 'Purple Lightning', ar: 'Acid Rain',
  wn: 'White Nova', aa: 'Azure Asteroid', ne: 'Noir Eclipse', sc: 'Silver Claw', uw: 'Umber Wilds',
};

// AWBW country code -> a short persona/theme that colors the unit's voice.
// Drawn from each nation's official lore card (terrain/cinfo_<code>_aw1.gif).
const ARMY_THEME: Record<string, string> = {
  os: 'all-American pros (USA) — earnest, heroic, academy-trained, can-do',
  bm: 'Russian winter army — cold, rugged, stoic, grind-it-out attrition',
  ge: 'German precision — hyper-efficient, organized, disciplined, by-the-book',
  yc: 'Japan/samurai pride — traditional, honor-bound, reveres the old ways',
  bh: 'otherworldly invaders — sinister, mechanized, coldly villainous',
  rf: 'British (UK) — jovial, nonchalant, improvising; cheeky, clock-tower bells, makes do',
  gs: 'dystopian-future industrial state — oppressive, faceless conscripts, shadowed eyes, grim',
  bd: 'Egyptian desert folk — headscarves, ancient ruins, sandstorms, old-world stoicism',
  ab: 'Chinese alliance of three mountain tribes (Three Kingdoms vibe) — scrappy, proud, now modern',
  js: 'Ancient-Rome legion reborn — conquest-hungry, fierce, grandiose, historic arms',
  ci: 'sentient ANTARCTIC PENGUINS running on stolen Black Hole tech — cold, waddling, chilly bravado',
  pc: 'cosmic religious zealots — fervent, certain, "purifying" the world by the universe’s grand design',
  tg: 'Latin-American revolutionaries — proud, fiery, elite beret commandos, anti-colonial',
  pl: 'French Foreign Legion of mercenaries from everywhere — professional, motley, fighting for citizenship',
  ar: 'secretive Vietnamese jungle guerillas — hardy, patient, ambushers, mysterious',
  wn: 'benevolent peace-loving ALIENS who only fight evil — noble, otherworldly, reluctant warriors',
  aa: 'sentient blue OOZE/SLIME creatures wielding modern guns — weird, gloopy, oddly competent',
  ne: 'mafia MOBSTERS of the criminal underworld — smooth, menacing, "connections", wiseguy patter',
  sc: 'intelligent high-tech DINOSAURS back from extinction — ancient, roaring, surprisingly advanced',
  uw: 'feral jungle MONKEYS & APES with scavenged gear — hoots, screeches, coconuts, rebellious attitude',
};

// The transmission's format for a given turn — weighted toward a straight call, with occasional
// rhyme/joke/gripe/praise/deadpan when there's material to play with.
const STYLES = [
  'a sharp, punchy radio call',
  'a sharp, punchy radio call',
  'a sharp, punchy radio call',
  'a short rhyming couplet (it must actually rhyme)',
  'a quick one-liner joke',
  'a good-natured gripe or complaint',
  'over-the-top praise/hype for the commander',
  'bone-dry deadpan humor',
];

// Sprite-file unit name -> a fitting terrain tile to stand on.
// (Only 'plain', 'mountain', 'sea' are verified-correct AWBW tiles; 'wood' is a different image.)
function terrainForUnit(unitFile: string): string {
  if (/lander|cruiser|sub|battleship|carrier|blackboat/.test(unitFile)) return 'sea';
  if (/mech/.test(unitFile)) return 'mountain';
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
    const unit = (body.unit || {}) as {
      name?: string;
      hp?: number;
      lowFuel?: boolean;
      lowAmmo?: boolean;
      terrainTile?: string;
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

    const armyName = (army.code && ARMY_NAMES[army.code]) || '';
    const who = playerName || 'Commander';
    // Sprite-file form of the unit name: "B-Copter" -> "b-copter", "Md.Tank" -> "md.tank".
    const unitName = (unit.name || '').trim();
    const unitFile = unitName.toLowerCase().replace(/[^a-z0-9.-]/g, '');
    const hp = typeof unit.hp === 'number' ? unit.hp : undefined;
    const lowFuel = unit.lowFuel === true;
    const lowAmmo = unit.lowAmmo === true;

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

        // Convey MORALE/MOOD from the real condition — never exact HP numbers.
        const mood =
          hp !== undefined && hp <= 4
            ? 'badly shot up — grim, defiant, gallows humor'
            : hp !== undefined && hp < 10
              ? 'a bit banged up — scrappy and weary, but game'
              : 'at full strength — bored, restless, cocky, itching to move';
        const supplies = [lowFuel ? 'almost out of fuel' : '', lowAmmo ? 'low on ammo' : '']
          .filter(Boolean)
          .join(' and ');
        const persona = (army.code && ARMY_THEME[army.code]) || '';
        const style = STYLES[Math.floor(Math.random() * STYLES.length)];
        const subject = unitName
          ? `a ${armyName ? armyName + ' ' : ''}${unitName} unit`
          : `${armyName ? armyName + ' ' : 'field '}command`;

        const genPrompt =
          `You are ${subject}${persona ? ` — your army's character: ${persona}` : ''}, radioing your commander ${who} ` +
          `over a crackly field radio because it's ${who}'s turn and you need orders. You're a grunt; use clipped comms flavor ` +
          `(over, come in, say again, five by five) and let your army's character color the voice — accent, references, even sounds.\n` +
          `Convey your MOOD, never exact numbers: you're ${mood}.${supplies ? ` You're also ${supplies} — gripe about it.` : ''} ` +
          `Only use what's stated here — don't invent battles, casualties, or damage.\n` +
          `Format for THIS transmission: ${style}. (If you can't pull it off well, a sharp call is fine.)\n` +
          `${chatBlock}\n` +
          `It must clearly mean it's ${who}'s turn.${day ? ` It is day ${day}.` : ''} Use the exact name "${who}". ` +
          `Under ~160 characters. Output ONLY the transmission — no surrounding quotes, at most one emoji.`;

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
                    `Pick the best radio call from a ${armyName || ''} ${unitName || 'command'} grunt to commander ${who}. ` +
                    `Criteria, in priority order: best leans into the army's character and is genuinely funny; nails the intended format (${style}); ` +
                    `conveys mood/morale without stating HP numbers; clearly conveys it's ${who}'s turn (needs orders); ` +
                    `lands a callback to the chatter ONLY if there's a real hook; tight (ideally under ~160 chars); not cringe or mean.\n` +
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
        const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
        const spriteUrl = `https://awbw.amarriner.com/terrain/ani/${army.code}${unitFile}.gif`;
        const sres = await fetch(spriteUrl);
        if (sres.ok) {
          // Typed as Uint8Array (sharp accepts it) to avoid the strict Buffer<ArrayBuffer> generic.
          let unitBuf: Uint8Array = Buffer.from(await sres.arrayBuffer());
          const meta = await sharp(unitBuf, { animated: true }).metadata();
          const baseW = meta.width || 16;
          const uH = meta.pageHeight || baseW;
          const scale = Math.max(1, Math.round(128 / baseW));

          // Real terrain the unit stands on (worker resolves it from the map). Fall back to a
          // unit-appropriate tile. Tall tiles (HQ/city/base/mountain, 16x32) rise above the unit,
          // so we grow each frame to the tile height and stand the unit at the bottom.
          const tile = (typeof unit.terrainTile === 'string' && unit.terrainTile) || terrainForUnit(unitFile);
          let frameH = uH;
          try {
            const tres = await fetch(`https://awbw.amarriner.com/terrain/aw1/${tile}.gif`);
            const terrSrc: Uint8Array = tres.ok
              ? Buffer.from(await tres.arrayBuffer())
              : Buffer.from(
                  await (await fetch('https://awbw.amarriner.com/terrain/aw1/plain.gif')).arrayBuffer()
                );
            const tMeta = await sharp(terrSrc).metadata();
            frameH = Math.max(uH, tMeta.height || uH);

            // Stand the unit at the bottom of a frameH-tall frame (per-frame; resize is page-aware).
            if (frameH > uH) {
              unitBuf = await sharp(unitBuf, { animated: true })
                .resize({ width: baseW, height: frameH, fit: 'contain', position: 'bottom', background: transparent })
                .gif()
                .toBuffer();
            }
            const terr = await sharp(terrSrc)
              .resize(baseW, frameH, { kernel: 'nearest', fit: 'cover', position: 'bottom' })
              .png()
              .toBuffer();
            // dest-over draws terrain BEHIND the unit; tile repeats it once per animation frame.
            unitBuf = await sharp(unitBuf, { animated: true })
              .composite([{ input: terr, blend: 'dest-over', tile: true }])
              .gif()
              .toBuffer();
          } catch (terrErr) {
            console.warn('Terrain backdrop failed (unit only)', terrErr);
          }

          const out = await sharp(unitBuf, { animated: true })
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
