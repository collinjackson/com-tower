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
  bm: 'Soviet-bloc war machine — rugged, stoic, disciplined; grind-it-out attrition, iron resolve, vodka-dry humor (NO ice/snow/cold shtick — that\'s Cobalt Ice)',
  ge: 'German precision — hyper-efficient, organized, disciplined, by-the-book',
  yc: 'Japan/samurai pride — traditional, honor-bound, reveres the old ways',
  bh: 'otherworldly invaders — sinister, mechanized, coldly villainous',
  rf: 'British (UK) — jovial, nonchalant, improvising; cheeky, clock-tower bells, makes do',
  gs: 'dystopian-future industrial state — oppressive, faceless conscripts, shadowed eyes, grim',
  bd: 'Egyptian desert folk — headscarves, ancient ruins, sandstorms, old-world stoicism',
  ab: 'Chinese alliance of three mountain tribes (Three Kingdoms vibe) — scrappy, proud, now modern',
  js: 'Ancient-Rome legion reborn — conquest-hungry, fierce, grandiose, historic arms',
  ci: 'sentient ANTARCTIC PENGUINS on stolen Black Hole tech — waddling, tuxedoed, fish/iceberg/belly-slide references, chilly cobalt-ice cool, squawky bravado',
  pc: 'cosmic religious zealots — fervent, certain, "purifying" the world by the universe’s grand design',
  tg: 'Latin-American revolutionaries — proud, fiery, elite beret commandos, anti-colonial',
  pl: 'French Foreign Legion of mercenaries from everywhere — professional, motley, fighting for citizenship',
  ar: 'secretive Vietnamese jungle guerillas — hardy, patient, ambushers, mysterious',
  wn: 'benevolent peace-loving ALIENS who only fight evil — noble, otherworldly, reluctant warriors',
  aa: 'sentient blue OOZE/SLIME creatures wielding modern guns — weird, gloopy, oddly competent',
  ne: 'mafia MOBSTERS of the criminal underworld — smooth, menacing, "connections", wiseguy patter',
  sc: 'intelligent high-tech DINOSAURS back from extinction — ancient, roaring, surprisingly advanced',
  uw: 'feral jungle MONKEYS & APES with jury-rigged scavenged gear — hoots, screeches, chest-thumping, swinging in on vines, fierce troop/tribe loyalty, gleeful chaos, rebellious raiders (bananas are the lazy gag — basically never reach for them; you have a whole jungle of material)',
};

// CO personalities (Advance Wars + Days of Ruin), so the CO voice is grounded in
// the real character rather than the model guessing. Keyed by lowercase co_name.
// Sourced from the Advance Wars wikis (advancewars.fandom.com / warswiki.org).
const CO_LORE: Record<string, string> = {
  // Orange Star
  andy: 'young gung-ho mechanic — loves machines and wrenches, naive and impulsive, endlessly upbeat rookie',
  max: 'beefy hot-blooded brawler — blunt, proud, all about raw firepower and close combat, not subtlety',
  sami: 'Orange Star special forces — serious, disciplined, fiercely infantry-proud, competitive, soldier-first',
  nell: 'Orange Star’s easygoing chief CO — confident, teasing, leans on luck, warm mentor',
  rachel: 'Nell’s younger sister — responsible and fierce, no-nonsense, scolds but cares deeply',
  hachi: 'jolly old shopkeeper-general — money-minded, wily, grandfatherly bargain-hawking',
  jake: 'young streetwise hotshot — skater slang ("totally"), cool and eager, reads the battle like a beat',
  // Blue Moon
  olaf: 'gruff blustery Blue Moon veteran — obsessed with snow and winter, quick-tempered, comedic grump',
  grit: 'laid-back country sniper — slow drawl ("well now"), relaxed and lazy but a deadly marksman',
  colin: 'timid young rich noble — insecure and apologetic, wins by throwing money at problems',
  sasha: 'Colin’s elegant composed sister — poised, political, money-savvy, gracious but shrewd',
  // Green Earth
  eagle: 'proud ace pilot — hot-blooded about honor and air power, intense, impatient, rivalry-driven',
  drake: 'big burly good-natured admiral — jovial, salt-of-the-sea, commands weather and waves',
  jess: 'serious dutiful tank commander — blunt and mission-focused, soft heart under the armor',
  javier: 'chivalrous knight — archaic formal speech, forever invoking "vision", defense and honor',
  // Yellow Comet
  kanbei: 'proud samurai emperor — bombastic, honor-bound, dignified, splurges on elite units',
  sonja: 'Kanbei’s brainy daughter — calm, analytical, intel-obsessed, quietly outsmarts everyone',
  sensei: 'beloved jolly old master — warm, humble, comedic hero, loves infantry and copters',
  grimm: 'cheerful reckless gunner — all-out attack, carefree "yeehaw" energy, no thought for defense',
  // Black Hole
  flak: 'brutish dim thug — loud, relies on dumb luck and raw muscle, comedic lunkhead',
  lash: 'gleeful child prodigy — hyper and giggly, sadistic, loves terrain tricks and her own genius',
  adder: 'smug slimy snake — arrogant, condescending, a cowardly schemer who gloats',
  hawke: 'stoic dark commander — brooding, honorable menace, calm and crushing',
  sturm: 'cold alien overlord — terse, destructive, meteor-summoning, the ultimate detached villain',
  jugger: 'battle android — speaks in glitchy beeps and garbled bursts, luck-driven, eerie and mechanical',
  koal: 'cool collected road-loving officer — calm, professional, terse, all business',
  kindle: 'haughty glamorous diva — vain, cruel, posh, looks down on everyone',
  'von bolt': 'ancient wheelchair-bound tyrant — raspy and decrepit, greedy for life and power, sinister geezer',
  // Days of Ruin / Dark Conflict
  will: 'earnest young cadet — idealistic, determined, never-give-up rookie hero',
  brenner: 'noble fatherly commander — compassionate, protects the weak, steady and brave',
  lin: 'sharp loyal lieutenant — disciplined, observant, level-headed second-in-command',
  isabella: 'gentle mysterious amnesiac — calm, kind, quietly resolute',
  tasha: 'hotshot fighter pilot — brash and vengeful, fast and fierce, avenging her brother',
  gage: 'quiet naval sniper — stoic, precise, melancholy man of few words',
  forsythe: 'honorable old general — dignified, principled warrior who respects a fair fight',
  waylon: 'vain cowardly ace — preening and flashy, self-serving, bolts when it counts',
  greyfield: 'corrupt gluttonous admiral — pompous, power-hungry, self-righteous tyrant',
  penny: 'eerie childlike girl — sing-song and innocent-creepy, speaks through her teddy "Mr. Bear"',
  tabitha: 'cold proud aristocrat — haughty, ruthless perfectionist (Caulder’s daughter)',
  caulder: 'amoral mad scientist — coldly cheerful, treats war as an experiment, utterly inhuman',
  davis: 'ruthless coup commander — calculating, militaristic, ambitious traitor',
};

// Per-unit-type attitude. The descriptors are PURE VIBE — no proper nouns —
// because this string is fed to the model and it'll parrot any name it sees.
// The SC2 Terran analog is noted in a trailing comment for maintainer reference
// ONLY (inspiration, not output). Keyed by substring of the sprite-file unit
// name; ordered so specific units win (megatank before tank, blackbomb before
// bomber, anti-air before air, etc.).
function unitVoice(f: string): string {
  if (/megatank/.test(f)) return 'a lumbering super-heavy juggernaut — slow, booming, overwhelming firepower, big-guns-big-fun bravado'; // Thor
  if (/neotank/.test(f)) return 'a top-of-the-line elite war machine — confident, unstoppable, latest-and-greatest swagger'; // Thor
  if (/md\.?tank|medium/.test(f)) return 'an upgunned heavy-armor crew — heavier, dug-in, crank-it-up loud'; // upgunned Siege Tank
  if (/tank/.test(f)) return 'a tank crew — loud, dug-in, hooah, ready-to-roll-out energy'; // Siege Tank
  if (/recon/.test(f)) return 'a fast scout buggy — pyro hot-rodder, need-for-speed, hit-and-run cocky'; // Hellion
  if (/\bapc\b|apc/.test(f)) return 'an armored transport and supply rig — blue-collar taxi, "need a lift?", keeps the boys moving'; // Medivac/SCV
  if (/mech/.test(f)) return 'an anti-armor heavy trooper — bruiser who loves wrecking armor, demolition jock'; // Marauder
  if (/infantry/.test(f)) return 'a rifle grunt — gung-ho, cocky, trigger-happy, rock-and-roll, eager for orders'; // Marine
  if (/artillery|rocket/.test(f)) return 'a long-range bombardment crew — patient gunner, fire-for-effect, rains hell from afar'; // Liberator
  if (/anti.?air|missile/.test(f)) return 'a flak/SAM crew — deadpan, locked on, quietly daring enemy planes to come'; // Goliath AA
  if (/piperunner/.test(f)) return 'a railbound gun — relentless but stuck on its track, dry about its one lane'; // Diamondback
  if (/b.?cop|bcopter/.test(f)) return 'an attack chopper — menacing, rotors screaming, itching to strike from above'; // Banshee
  if (/t.?cop|tcopter/.test(f)) return 'a transport chopper — sassy bus driver, "going up?", ferrying grunts'; // Medivac/Dropship
  if (/fighter/.test(f)) return 'an air-superiority pilot — by-the-book fighter jock with swagger, dogfighter'; // Viking
  if (/stealth/.test(f)) return 'a cloaked striker — silent, smug, they-never-see-it-coming'; // Banshee/Wraith
  if (/black.?bomb/.test(f)) return 'a tactical nuke — ominous, clipped, doomsday-countdown menace'; // Ghost nuke
  if (/bomber/.test(f)) return 'a heavy bomber — bombs-away payload confidence, flattens whatever\'s below'; // Liberator
  if (/battleship/.test(f)) return 'a capital-warship bridge — booming captain, make-it-happen authority, commands the sea'; // Battlecruiser
  if (/cruiser/.test(f)) return 'an escort warship — steady anti-air/anti-sub watchdog, scanning the horizon'; // Viking/escort
  if (/carrier/.test(f)) return 'a flattop and mobile airbase — launches the birds, calm deck-officer authority'; // mini-Battlecruiser
  if (/sub/.test(f)) return 'a lurking submarine — quiet menace from below, patient ambusher, breathy and cold'; // Sub
  if (/lander/.test(f)) return 'an amphibious transport — "going down", dropping the boys on the beach'; // Dropship
  if (/black.?boat/.test(f)) return 'a repair and rescue boat — gruff fix-it crew, "you break \'em, I patch \'em"'; // SCV/Medic
  return '';
}

// The transmission's format for a given turn — weighted toward a straight call, with occasional
// rhyme/joke/gripe/praise/deadpan when there's material to play with.
const STYLES = [
  'a sharp, punchy radio call',
  'a sharp, punchy radio call',
  'a sharp, punchy radio call',
  'a short rhyming couplet (it must actually rhyme)',
  'a genuine joke — real setup + a punchline that actually lands (if a pun, the wordplay must truly work; no limp non-sequiturs)',
  'a good-natured gripe or complaint',
  'over-the-top praise/hype for the commander',
  'bone-dry deadpan humor',
];

// AWBW faction glow colors (approx palette). The hologram is rendered in the
// army's own color instead of a fixed teal.
const ARMY_COLOR: Record<string, [number, number, number]> = {
  os: [255, 120, 40], bm: [70, 130, 240], ge: [70, 190, 90], yc: [245, 215, 70],
  bh: [125, 90, 150], rf: [230, 60, 60], gs: [150, 160, 170], bd: [175, 115, 60],
  ab: [240, 170, 60], js: [60, 200, 150], ci: [80, 170, 230], pc: [245, 130, 200],
  tg: [40, 200, 190], pl: [170, 90, 220], ar: [170, 210, 70], wn: [235, 240, 245],
  aa: [90, 200, 235], ne: [70, 70, 90], sc: [190, 200, 210], uw: [125, 85, 55],
};
const DEFAULT_COLOR: [number, number, number] = [130, 240, 255]; // teal fallback

// Per-country facing — all units of a country face the same way (the barrel/
// front reaches the left edge of the cell for these; everyone else faces right).
// Used to put the hologram's lead room on the side it's looking.
const FACE_LEFT = new Set(['bm', 'yc', 'bh', 'rf', 'ab', 'pc', 'tg', 'ar', 'ne', 'sc']);

// Brighten a faction color into a glow: scale so the brightest channel hits
// ~235, preserving hue. Dark armies (Black Hole, Noir) become vivid/ghostly
// glows instead of vanishing, so everyone stays holographic on black.
function glowColor(C: [number, number, number]): [number, number, number] {
  const s = 235 / Math.max(...C);
  return C.map((c) => Math.min(255, Math.round(c * s))) as [number, number, number];
}

// Recolor curve + background + grain for a faction's hologram. Glow-on-black:
// per channel, luminance L maps linearly from a dark tinted FLOOR (L=0) to a
// bright HIGHLIGHT (L=255), so out_c = A*L + B. The highlight is a VIVID version
// of the hue (max channel pushed to 255 — brightens warm colors without washing
// them) plus a white bloom that's strong for cool colors (blue/purple read dark
// and need icy specular highlights) and near-zero for warm ones (orange/yellow
// stay saturated). The dark field + per-pixel gradient give the projection depth.
const FLOOR_FRAC = 0.22; // dark-tint floor as a fraction of the glow color
function holoSpec(code?: string) {
  const G = glowColor((code && ARMY_COLOR[code]) || DEFAULT_COLOR);
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
      terrainName?: string;
      hpChange?: 'hurt' | 'healed';
      surroundings?: string;
      map?: string;
    };
    // When the player has no units to feature (or the worker rolled CO this turn),
    // we feature their commanding officer instead — the active CO in tag games.
    const co = (body.co || {}) as { name?: string; imageUrl?: string };
    // Optional per-player language/style for the caption (best effort; guarded below).
    const language = typeof body.language === 'string' ? body.language.trim().slice(0, 40) : '';

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
              : 'fresh, sharp, and full of restless energy with no action yet';
        const supplies = [lowFuel ? 'almost out of fuel' : '', lowAmmo ? 'low on ammo' : '']
          .filter(Boolean)
          .join(' and ');
        const persona = (army.code && ARMY_THEME[army.code]) || '';
        const unitVibe = unitFile ? unitVoice(unitFile) : '';
        const style = STYLES[Math.floor(Math.random() * STYLES.length)];
        // Feature the CO when there's no unit to voice (early game, or the worker
        // rolled CO this turn). The CO themselves takes the radio.
        const coName = (co.name || '').trim();
        const coLore = CO_LORE[coName.toLowerCase()] || '';
        const featuringCo = !unitFile && !!(coName || co.imageUrl);
        // Joke craft applies to both voices — a flagged failure mode (limp non-jokes).
        const jokeCraft =
          `If your format is a joke or pun, it MUST work as one — a real setup and a punchline that genuinely lands (the wordplay has to actually make sense); a flat non-sequitur is worse than a straight call.\n`;
        // Optional language/style. Guarded: only well-known real or novelty languages,
        // and never a mocking/offensive impression.
        // Battlefield context (unit voice only): the ASCII map + surroundings + HP swing.
        // STRONGLY guarded — it's inspiration, not script; the output must stay subtle.
        const battleCtx = unit.map || unit.surroundings
          ? `BATTLEFIELD CONTEXT (inspiration ONLY — do NOT state HP numbers, coordinates, or name terrain types/unit types outright; evoke the situation indirectly, e.g. "wedged in the rocks", "sitting ducks out here", "patched up and twitchy"):\n` +
            `${unit.hpChange === 'hurt' ? '- You just took a beating this round.\n' : unit.hpChange === 'healed' ? '- You just got patched up this round.\n' : ''}` +
            `${unit.surroundings ? `- You are ${unit.surroundings}\n` : ''}` +
            `${unit.map ? `- Local map — X just MARKS YOUR POSITION (it is NOT your name/callsign), u = your side, E = enemy:\n${unit.map}\n` : ''}`
          : '';
        const wantsLang = !!language && !/^(english|en)$/i.test(language);
        const langLine = wantsLang
          ? `LANGUAGE: write the ENTIRE transmission in ${language} (keep the name "${who}" verbatim and keep the meaning that it's their turn). Genuinely COMMIT to it — for novelty/fictional languages a recognizable flavored rendition is exactly right (Klingon: weave in real Klingon like "nuqneH"/"Qapla'"/"tlhIngan"; Swedish Chef: "bork bork" mock-Swedish; Yoda: object-subject-verb inversion; Pirate: "arr/ye/be"). Fall back to plain English ONLY if ${language} would come out as meaningless gibberish, or if it would be a mocking/offensive impression of a real ethnic group.\n`
          : '';

        const subject = unitName
          ? `a ${armyName ? armyName + ' ' : ''}${unitName} unit`
          : `${armyName ? armyName + ' ' : 'field '}command`;

        const genPrompt = featuringCo
          ? `You are ${coName || 'the commanding officer'}, the CO (commanding officer) of ${armyName || 'this'} army.${coLore ? ` Your character: ${coLore}. Channel it hard — let it drive your speech style, quirks, and attitude.` : ` This is an Advance Wars CO; if you know their personality, channel it, otherwise play a vivid, distinct commander.`} ` +
            `It's ${who}'s turn and you have NO troops on the field yet, so YOU grab the radio to rally your commander ${who} and get the war moving.\n` +
            `Use clipped field-radio comms (come in, say again, five by five).\n` +
            `Radio word "over" ONLY signals you're done: at most once, at the very END, optional — never mid-message.\n` +
            `You're itching to mobilize, but never say so outright — let it show through the bit.\n` +
            `Pick a FRESH angle; don't lean on one catchphrase.\n` +
            jokeCraft +
            langLine +
            `Format for THIS transmission: ${style}. (If you can't pull it off well, a sharp call is fine.)\n` +
            `${chatBlock}\n` +
            `It must clearly mean it's ${who}'s turn.${day ? ` It is day ${day}.` : ''} Use the exact name "${who}". ` +
            `Under ~160 characters. Output ONLY the transmission — no surrounding quotes, at most one emoji.`
          : `You are ${subject}${persona ? ` — your army's character: ${persona}` : ''}, radioing your commander ${who} ` +
            `on a crackly field radio because it's ${who}'s turn and you need orders. You're a grunt; use clipped comms flavor ` +
            `(come in, say again, five by five) and let your army's character color the voice — accent, references, even sounds.\n` +
            (unitVibe
              ? `Your unit's attitude (loose inspiration — channel the vibe, never name it or reference StarCraft): ${unitVibe}.\n`
              : '') +
            battleCtx +
            `Radio word "over" ONLY signals you're done talking: use it at most once, at the very END, and it's optional — never mid-message.\n` +
            `Convey your MOOD through HOW you talk — never state it outright (don't say "bored", "restless", "antsy", "nothing to do") and never give exact numbers: you're ${mood}.${supplies ? ` You're also ${supplies} — gripe about it.` : ''} ` +
            `With no action yet, you fill the dead air — that's WHY you've got a joke or a rhyme — but let the bit speak for itself; don't explain that you're passing time or itching for orders.\n` +
            `Only use what's stated here — don't invent battles, casualties, or damage.\n` +
            `Pick a FRESH angle — avoid the single most obvious cliché for your faction (the same prop, pun, or catchphrase every time); your character is broad, so mine a different part of it.\n` +
            jokeCraft +
            langLine +
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
                    `Pick the best radio call from ${featuringCo ? `the CO ${coName || 'commander'}` : `a ${armyName || ''} ${unitName || 'command'} grunt`} to commander ${who}. ` +
                    `Criteria, in priority order: best leans into the ${featuringCo ? "CO's" : "army's"} character and is genuinely funny; nails the intended format (${style}); ` +
                    `if the format is a joke/pun, DOWNRANK any whose punchline or wordplay doesn't actually land (a non-joke is bad); ` +
                    `the humor itself shows the idle restlessness — DOWNRANK any that explicitly say they're bored/restless/antsy/itching or that narrate having nothing to do; ` +
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

    // Attach the army's unit sprite as a Star Wars-style hologram: a cyan,
    // scanlined, grainy projection on a near-black field. Best-effort.
    // The black background means we never render a real terrain tile — which
    // sidesteps tall tiles (HQ/mountain 16x32) that broke the in-cell backdrop.
    let imageData: string | null = null;
    let imageContentType: string | null = null;
    let imageFilename: string | null = null;
    if (enableFun && army.code && /^[a-z]{2,3}$/.test(army.code) && unitFile) {
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
        } else {
          console.warn(`Sprite fetch failed ${sres.status} for ${spriteUrl}`);
        }
      } catch (err) {
        console.error('Sprite attach failed (continuing text-only)', err);
      }
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
        } else {
          console.warn(`CO portrait fetch failed ${cres.status} for ${co.imageUrl}`);
        }
      } catch (err) {
        console.error('CO portrait attach failed (continuing text-only)', err);
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
