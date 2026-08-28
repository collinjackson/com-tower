// AWBW's own army colours, lifted verbatim from the game page's country colour map (the
// "light" variant, which is the one AWBW uses on dark backgrounds). These are the identity
// players actually recognise, so a chart uses them rather than a generic categorical ramp.
export const ARMY_COLORS: Record<string, string> = {
  aa: '#84dfe8', // Azure Asteroid
  ab: '#fec078', // Amber Blossom
  ar: '#7a9d11', // Acid Rain
  bd: '#ad7e5f', // Brown Desert
  bh: '#bbb4a5', // Black Hole
  bm: '#94a2fd', // Blue Moon
  ci: '#2342ba', // Cobalt Ice
  ge: '#87e287', // Green Earth
  gs: '#979797', // Grey Sky
  js: '#c4d7b4', // Jade Sun
  ne: '#6e6060', // Noir Eclipse
  os: '#ff4f4e', // Orange Star
  pc: '#ff99cc', // Pink Cosmos
  pl: '#a447d3', // Purple Lightning
  rf: '#c27184', // Red Fire
  sc: '#8cacbc', // Silver Claw
  tg: '#6cd9d0', // Teal Galaxy
  uw: '#d47700', // Umber Wilds
  wn: '#d4bf9f', // White Nova
  yc: '#f0d204', // Yellow Comet
};

export const DEFAULT_ARMY_COLOR = '#7dd08f';

const hexToRgb = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
const rgbToHex = (c: number[]) =>
  '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const relLuminance = (c: number[]) => {
  const s = c.map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
};
const contrastRatio = (a: number[], b: number[]) => {
  const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};

/** Lift an army colour until it clears the chart surface, moving lightness only.
 *
 *  Cobalt Ice is nearly black and Noir Eclipse is grey *by design*, so several of AWBW's
 *  colours fail a contrast check against a dark plot. Every channel moves the same fraction
 *  of its distance to white, so the hue survives and the army stays recognisable. Identity
 *  never rests on colour alone regardless: each line is directly labelled and dashed. */
export function fitToSurface(hex: string, surfaceHex: string, target = 3.2): string {
  const surface = hexToRgb(surfaceHex);
  let c: number[] = hexToRgb(hex);
  for (let i = 0; i < 60 && contrastRatio(c, surface) < target; i++) {
    c = c.map((v) => v + (255 - v) * 0.05);
  }
  return rgbToHex(c);
}

/** Dash patterns, in fixed order — the secondary encoding that keeps two similar armies (or
 *  a colourblind reader, or a greyscale print) apart when hue alone will not do it. */
export const SERIES_DASHES = ['', '7 3', '2 3', '11 3 2 3', '5 3 2 3', '3 2'];
