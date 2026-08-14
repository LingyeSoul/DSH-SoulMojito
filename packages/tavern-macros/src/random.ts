/**
 * Hashing, list splitting and dice-roll helpers for {{pick}} / {{random}} / {{roll}}.
 *
 * ST reference behavior (public/scripts/macros.js — getRandomReplaceMacro,
 * getPickReplaceMacro, getDiceRollMacro):
 *  - list split: if the list string contains "::" split on "::" (items NOT trimmed,
 *    escaped commas NOT restored); otherwise split on "," with "\," escaped commas
 *    restored and items trimmed.
 *  - pick seed: `${chatIdHash}-${rawContentHash}-${offset}` hashed -> stable choice.
 *  - roll: digits-only formula means "1d<N>"; NdM(+/-)K; invalid -> empty string.
 */

/** FNV-1a 32-bit hash (own implementation; ST uses cyrb53 + seedrandom). */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Sentinel temporarily replacing "\," while splitting a comma-separated list. */
const ESCAPED_COMMA = '\u0000';

/** Split a {{random}}/{{pick}} list per ST getRandomReplaceMacro. */
export function splitMacroList(listString: string): string[] {
  if (listString.includes('::')) {
    return listString.split('::');
  }
  return listString
    .replace(/\\,/g, ESCAPED_COMMA)
    .split(',')
    .map(item => item.trim().replace(/\u0000/g, ','));
}

export interface RollSpec {
  count: number;
  sides: number;
  modifier: number;
}

/**
 * Parse a droll-style formula: NdM, NdM+K, NdM-K. A digits-only argument means 1d<N>
 * (ST getDiceRollMacro). Bounds mirror droll.validate: 1-999 dice, 2-999 sides.
 * Returns null for invalid formulas.
 */
export function parseRoll(formula: string): RollSpec | null {
  let f = formula.trim();
  if (/^\d+$/.test(f)) {
    f = `1d${f}`;
  }
  const m = /^(\d+)d(\d+)([+-]\d+)?$/.exec(f);
  if (m === null) return null;
  const count = Number(m[1]);
  const sides = Number(m[2]);
  const modifier = m[3] === undefined ? 0 : Number(m[3]);
  if (!Number.isInteger(count) || count < 1 || count > 999) return null;
  if (!Number.isInteger(sides) || sides < 2 || sides > 999) return null;
  if (!Number.isFinite(modifier)) return null;
  return { count, sides, modifier };
}

/** Roll the spec with the injected rng ([0, 1) per die: floor(rng() * sides) + 1). */
export function evalRoll(spec: RollSpec, rng: () => number): number {
  let total = spec.modifier;
  for (let i = 0; i < spec.count; i++) {
    const r = rng();
    total += Math.floor(r < 0 ? 0 : r >= 1 ? spec.sides - 1 : r * spec.sides) + 1;
  }
  return total;
}
