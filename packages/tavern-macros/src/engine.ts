/**
 * SillyTavern-compatible macro engine.
 *
 * Substitution details mirror ST (public/scripts/macros.js `evaluateMacros`,
 * public/scripts/variables.js `getVariableMacros` / `addLocalVariable`,
 * `substituteParams` in public/script.js), implemented independently:
 *
 *  - Macro names are case-insensitive; unknown/failed macros are LEFT UNCHANGED.
 *  - Single pass: replacement text is never re-scanned. (ST's sequential regex
 *    pipeline incidentally expands later macros inside earlier replacements;
 *    we do not reproduce that — safer and deterministic.)
 *  - Legacy tag pre-pass (ST preEnvMacros): <BOT> <CHAR> <USER> <GROUP>
 *    <CHARIFNOTGROUP> plus single-brace {char}/{user} (guarded so {{char}} is
 *    never corrupted).
 *  - {{trim}} removes the macro AND adjacent \r?\n on both sides (ST regex
 *    `(?:\r?\n)*{{trim}}(?:\r?\n)*`).
 *  - Variable macros follow variables.js exactly: setvar/addvar expand to '',
 *    incvar/decvar expand to the NEW value, numeric-vs-concat add semantics,
 *    numeric-string coercion on read.
 */

import type {
  MacroEngine,
  MacroEngineInit,
  MacroFunction,
  VariableValue,
} from './types.js';
import { hostMacroSnapshot } from './host-registry.js';
import { evalRoll, hash32, parseRoll, splitMacroList } from './random.js';
import {
  formatLocalDateLong,
  formatLocalIsoDate,
  formatLocalIsoTime,
  formatLocalTime,
  formatTimeAtUtcOffset,
  formatWeekday,
  formatWithTokens,
  humanizeDuration,
} from './time.js';

/** Sentinel result: scanner-level {{trim}} behavior (strip adjacent newlines). */
const TRIM: unique symbol = Symbol('trim');

type MacroResult = string | typeof TRIM | null;

/**
 * 内置宏名快照（小写）。首个引擎实例化时填充（reg 是后写胜，吸收宿主宏之前
 * 的 registry 键集即纯内置集）。宿主的 mod 宏注册面用它拒绝对 {{char}}/
 * {{user}}/{{random}} 等核心宏的劫持（提案 0015 P2 api.macros.register）。
 */
const builtinMacroNameSet = new Set<string>();

export function builtinMacroNames(): Set<string> {
  return new Set(builtinMacroNameSet);
}

interface HandlerCtx {
  /** Raw text between the macro name and `}}` (separator included). */
  rest: string;
  /** Offset of the `{{` in the (post-legacy) input — {{pick}} stability seed part. */
  offset: number;
  /** Hash of the raw input text — {{pick}} stability seed part. */
  rawHash: number;
}

type Handler = (ctx: HandlerCtx) => MacroResult;

type VarScope = 'local' | 'global';

function opt(v: string | undefined): string {
  return v ?? '';
}

/** ST getLocalVariable: numeric strings are coerced to numbers on read. */
function coerceRead(v: VariableValue | undefined): VariableValue | undefined {
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) {
    return Number(v);
  }
  return v;
}

export function createMacroEngine(init: MacroEngineInit): MacroEngine {
  const card = init.card ?? {};
  const localVars = new Map<string, VariableValue>(Object.entries(init.local ?? {}));
  const globalVars = new Map<string, VariableValue>(Object.entries(init.global ?? {}));
  const now = init.now ?? (() => new Date());
  const rng = init.rng ?? Math.random;
  /** ST substituteParams: {{group}} === {{charIfNotGroup}} === group ?? char. */
  const groupValue = init.group ?? init.char;

  const registry = new Map<string, Handler>();

  function reg(name: string, handler: Handler): void {
    registry.set(name.toLowerCase(), handler);
  }

  /** Macro only matches its bare form — `{{char:}}` / `{{char x}}` stay untouched (ST). */
  function regExact(name: string, getValue: () => string): void {
    reg(name, ctx => (ctx.rest === '' ? getValue() : null));
  }

  /** Argument must start with `::` (ST variable macros require the double colon). */
  function colonArg(ctx: HandlerCtx): string | null {
    return ctx.rest.startsWith('::') ? ctx.rest.slice(2) : null;
  }

  /** ST `\s?::?` separator (random/pick/time): optional space, 1-2 colons. */
  function laxArg(ctx: HandlerCtx): string | null {
    const m = /^\s?::?/.exec(ctx.rest);
    return m === null ? null : ctx.rest.slice(m[0].length);
  }

  /** ST roll accepts a single space as separator (`[ : ]`); we also take `::`. */
  function rollArg(ctx: HandlerCtx): string | null {
    const m = /^(?:\s?::?|\s)/.exec(ctx.rest);
    return m === null ? null : ctx.rest.slice(m[0].length);
  }

  /* ------------------------- variable helpers ------------------------- */

  function storeOf(scope: VarScope): Map<string, VariableValue> {
    return scope === 'local' ? localVars : globalVars;
  }

  function readVar(scope: VarScope, name: string): VariableValue | undefined {
    return coerceRead(storeOf(scope).get(name));
  }

  /**
   * ST variables.js addLocalVariable/addGlobalVariable:
   *  - JSON-array current value -> push and store JSON string;
   *  - both operands numeric -> numeric addition;
   *  - otherwise -> string concatenation String(current || '') + value.
   * Returns the new value ('' when the result would be NaN).
   */
  function addToVar(scope: VarScope, name: string, value: VariableValue): string {
    const store = storeOf(scope);
    const current: VariableValue = (coerceRead(store.get(name)) ?? 0) || 0;
    if (typeof current === 'string') {
      try {
        const parsed: unknown = JSON.parse(current);
        if (Array.isArray(parsed)) {
          parsed.push(value);
          const json = JSON.stringify(parsed);
          store.set(name, json);
          return json;
        }
      } catch {
        // not JSON — fall through
      }
    }
    const inc = Number(value);
    const currentNum = Number(current);
    if (Number.isNaN(inc) || Number.isNaN(currentNum)) {
      const concatenated = `${String(current || '')}${String(value)}`;
      store.set(name, concatenated);
      return concatenated;
    }
    const next = currentNum + inc;
    if (Number.isNaN(next)) {
      return '';
    }
    store.set(name, next);
    return String(next);
  }

  /* ------------------------- built-in macros ------------------------- */

  // Names (ST: <BOT>/<CHAR> -> char, <GROUP>/<CHARIFNOTGROUP> -> group value).
  regExact('char', () => init.char);
  regExact('user', () => init.user);
  regExact('group', () => groupValue);
  regExact('charIfNotGroup', () => groupValue);
  regExact('groupNotMuted', () => groupValue);
  // {{notChar}}: not in ST release macros.js — expands to the user name (per spec).
  regExact('notChar', () => init.user);
  regExact('persona', () => opt(init.persona));

  // Card fields (ST substituteParams environment: charPrompt = card system prompt,
  // charInstruction/charJailbreak = post_history_instructions, ...).
  regExact('description', () => opt(card.description));
  regExact('personality', () => opt(card.personality));
  regExact('scenario', () => opt(card.scenario));
  regExact('mesExamples', () => opt(card.mesExample));
  regExact('mesExamplesRaw', () => opt(card.mesExample));
  regExact('charPrompt', () => opt(card.systemPrompt));
  regExact('charInstruction', () => opt(card.postHistoryInstructions));
  regExact('charJailbreak', () => opt(card.postHistoryInstructions));
  regExact('charDepthPrompt', () => opt(card.charDepthPrompt));
  regExact('creatorNotes', () => opt(card.creatorNotes));
  regExact('charCreatorNotes', () => opt(card.creatorNotes));
  regExact('systemPrompt', () => opt(init.systemPrompt));
  regExact('original', () => opt(init.original));

  // History (init-provided; unset -> '', mirroring ST `chat[mid]?.mes ?? ''`).
  regExact('lastMessage', () => opt(init.lastMessage));
  regExact('lastUserMessage', () => opt(init.lastUserMessage));
  regExact('lastCharMessage', () => opt(init.lastCharMessage));
  regExact('lastMessageId', () =>
    init.lastMessageId === undefined ? '' : String(init.lastMessageId),
  );

  // Runtime.
  regExact('model', () => opt(init.model));
  regExact('maxContextTokens', () =>
    init.maxContextTokens === undefined ? '' : String(init.maxContextTokens),
  );
  regExact('maxPrompt', () => {
    const n = init.maxPrompt ?? init.maxContextTokens;
    return n === undefined ? '' : String(n);
  });
  regExact('maxResponseTokens', () =>
    init.maxResponseTokens === undefined ? '' : String(init.maxResponseTokens),
  );

  // Tools.
  regExact('newline', () => '\n');
  regExact('space', () => ' ');
  regExact('noop', () => '');
  reg('trim', ctx => (ctx.rest === '' ? TRIM : null));

  // Time (ST postEnvMacros; moment `en` formats).
  reg('time', ctx => {
    if (ctx.rest === '') {
      return formatLocalTime(now());
    }
    const arg = laxArg(ctx);
    if (arg === null) {
      return null;
    }
    const m = /^UTC([+-]\d+)$/i.exec(arg.trim());
    if (m === null) {
      return null;
    }
    return formatTimeAtUtcOffset(now(), Number(m[1]));
  });
  // ST: {{time_UTC+8}} / {{time_UTC-5}} (regex /{{time_UTC([-+]\d+)}}/gi).
  reg('time_utc', ctx => {
    const m = /^([+-]\d+)$/.exec(ctx.rest);
    if (m === null) {
      return null;
    }
    return formatTimeAtUtcOffset(now(), Number(m[1]));
  });
  regExact('date', () => formatLocalDateLong(now()));
  regExact('weekday', () => formatWeekday(now()));
  regExact('isotime', () => formatLocalIsoTime(now()));
  regExact('isodate', () => formatLocalIsoDate(now()));
  // ST regex is `{{datetimeformat +<fmt>}}` (space separator); we also accept
  // `::` / `:` separators and lowercase yyyy/dd tokens.
  reg('datetimeformat', ctx => {
    const m = /^(?:\s+|::?)/.exec(ctx.rest);
    if (m === null) {
      return null;
    }
    return formatWithTokens(now(), ctx.rest.slice(m[0].length));
  });
  // ST idle_duration: moment humanize; no last message -> 'just now'.
  regExact('idle_duration', () =>
    init.idleDurationSeconds === undefined
      ? 'just now'
      : humanizeDuration(init.idleDurationSeconds),
  );
  regExact('idleDuration', () =>
    init.idleDurationSeconds === undefined
      ? 'just now'
      : humanizeDuration(init.idleDurationSeconds),
  );

  // Random / pick (ST getRandomReplaceMacro / getPickReplaceMacro).
  reg('random', ctx => {
    const arg = laxArg(ctx);
    // ST `[^}]+`: an empty list never matches -> leave untouched.
    if (arg === null || arg === '') {
      return null;
    }
    const list = splitMacroList(arg);
    const idx = Math.floor(rng() * list.length);
    const safe = idx < 0 ? 0 : idx >= list.length ? list.length - 1 : idx;
    return list[safe] ?? '';
  });
  reg('pick', ctx => {
    const arg = laxArg(ctx);
    if (arg === null || arg === '') {
      return null;
    }
    const list = splitMacroList(arg);
    // ST seeds on `${chatIdHash}-${rawContentHash}-${offset}`; same construction,
    // our own hash (exact ST picks are not reproducible without seedrandom).
    const chatHash = hash32(init.chatId ?? '');
    const seed = hash32(`${chatHash}|${ctx.rawHash}|${ctx.offset}`);
    return list[seed % list.length] ?? '';
  });
  reg('roll', ctx => {
    const arg = rollArg(ctx);
    if (arg === null) {
      return null;
    }
    const spec = parseRoll(arg);
    // ST getDiceRollMacro: invalid formula -> '' (macro still consumed).
    if (spec === null) {
      return '';
    }
    return String(evalRoll(spec, rng));
  });

  // Variables (ST getVariableMacros: :: required; setvar/addvar -> '',
  // incvar/decvar -> new value; getvar name = full remainder, trimmed).
  function registerVarMacros(scope: VarScope, infix: '' | 'global'): void {
    const store = storeOf(scope);
    reg(`get${infix}var`, ctx => {
      const arg = colonArg(ctx);
      if (arg === null || arg === '') {
        return null;
      }
      const v = coerceRead(store.get(arg.trim()));
      return v === undefined ? '' : String(v);
    });
    reg(`set${infix}var`, ctx => {
      const arg = colonArg(ctx);
      if (arg === null) {
        return null;
      }
      const m = /^([^:]+)::([\s\S]*)$/.exec(arg);
      if (m === null || m[1] === undefined || m[1] === '') {
        return null;
      }
      store.set(m[1].trim(), m[2] ?? '');
      return '';
    });
    reg(`add${infix}var`, ctx => {
      const arg = colonArg(ctx);
      if (arg === null) {
        return null;
      }
      const m = /^([^:]+)::([\s\S]+)$/.exec(arg);
      if (m === null || m[1] === undefined || m[1] === '') {
        return null;
      }
      addToVar(scope, m[1].trim(), m[2] ?? '');
      return '';
    });
    reg(`inc${infix}var`, ctx => {
      const arg = colonArg(ctx);
      if (arg === null || arg === '') {
        return null;
      }
      // ST: name only (+1). Extension: optional `::n` delta.
      const m = /^([^:]+?)(?:::([\s\S]*))?$/.exec(arg);
      if (m === null || m[1] === undefined || m[1] === '') {
        return null;
      }
      const delta = m[2] === undefined ? '1' : m[2];
      return addToVar(scope, m[1].trim(), delta);
    });
    reg(`dec${infix}var`, ctx => {
      const arg = colonArg(ctx);
      if (arg === null || arg === '') {
        return null;
      }
      const m = /^([^:]+?)(?:::([\s\S]*))?$/.exec(arg);
      if (m === null || m[1] === undefined || m[1] === '') {
        return null;
      }
      const value: VariableValue =
        m[2] === undefined
          ? -1
          : Number.isNaN(Number(m[2]))
            ? `-${m[2]}`
            : -Number(m[2]);
      return addToVar(scope, m[1].trim(), value);
    });
    reg(`has${infix}var`, ctx => {
      const arg = colonArg(ctx);
      if (arg === null || arg === '') {
        return null;
      }
      return store.has(arg.trim()) ? 'true' : 'false';
    });
    reg(`delete${infix}var`, ctx => {
      const arg = colonArg(ctx);
      if (arg === null || arg === '') {
        return null;
      }
      store.delete(arg.trim());
      return '';
    });
  }
  registerVarMacros('local', '');
  registerVarMacros('global', 'global');

  /* --------------------------- legacy tags --------------------------- */

  const LEGACY_RE =
    /<CHARIFNOTGROUP>|<GROUP>|<CHAR>|<BOT>|<USER>|(?<!\{)\{char\}(?!\})|(?<!\{)\{user\}(?!\})/gi;

  function applyLegacy(text: string): string {
    if (!text.includes('<') && !text.includes('{')) {
      return text;
    }
    return text.replace(LEGACY_RE, tag => {
      switch (tag.toLowerCase()) {
        case '<bot>':
        case '<char>':
        case '{char}':
          return init.char;
        case '<user>':
        case '{user}':
          return init.user;
        case '<group>':
        case '<charifnotgroup>':
          return groupValue;
        default:
          return tag;
      }
    });
  }

  /* ----------------------------- scanner ----------------------------- */

  function evalInside(inside: string, offset: number, rawHash: number): MacroResult {
    if (inside === '') {
      return null;
    }
    // ST comment macro: `{{// ...}}` removed (`\{\{\/\/([\s\S]*?)\}\}`).
    if (inside.startsWith('//')) {
      return '';
    }
    const m = /^([A-Za-z0-9_]+)/.exec(inside);
    if (m === null) {
      return null;
    }
    const macroName = m[1]!
    const rest = inside.slice(macroName.length);
    // ST macro regexes use `[^}]` classes — a span containing `}` never matches.
    if (rest.includes('}')) {
      return null;
    }
    const handler = registry.get(macroName.toLowerCase());
    if (handler === undefined) {
      return null;
    }
    return handler({ rest, offset, rawHash });
  }

  function expand(rawText: string): string {
    if (!rawText) {
      return '';
    }
    const text = applyLegacy(rawText);
    const rawHash = hash32(rawText);
    let out = '';
    let pos = 0;
    let skipNewlines = false;
    const appendText = (chunk: string): void => {
      if (chunk === '') {
        return;
      }
      let c = chunk;
      if (skipNewlines) {
        c = c.replace(/^(?:\r?\n)+/, '');
        if (c !== '') {
          skipNewlines = false;
        }
      }
      out += c;
    };
    for (;;) {
      const open = text.indexOf('{{', pos);
      if (open === -1) {
        appendText(text.slice(pos));
        break;
      }
      appendText(text.slice(pos, open));
      const close = text.indexOf('}}', open + 2);
      if (close === -1) {
        appendText(text.slice(open));
        break;
      }
      const result = evalInside(text.slice(open + 2, close), open, rawHash);
      if (result === null) {
        appendText(text.slice(open, close + 2));
      } else if (result === TRIM) {
        out = out.replace(/(?:\r?\n)+$/, '');
        skipNewlines = true;
      } else {
        skipNewlines = false;
        out += result;
      }
      pos = close + 2;
    }
    return out;
  }

  /* ------------------------------ API ------------------------------ */

  function registerMacro(name: string, fn: MacroFunction): void {
    const key = name.trim();
    if (key === '') {
      throw new TypeError('Macro key must not be empty or whitespace only');
    }
    if (key.startsWith('{{') || key.endsWith('}}')) {
      throw new TypeError('Macro key must not include the surrounding braces');
    }
    reg(key, ctx => {
      const stripped = ctx.rest.replace(/^(?:\s?::?|\s)/, '');
      const args = stripped === '' ? [] : stripped.split('::');
      try {
        return fn(args, api);
      } catch {
        // ST evaluateMacros catches per-macro errors and leaves the text as-is.
        return null;
      }
    });
  }

  // 宿主全局宏（提案 0015 P0）：实例化时吸收注册表快照，使宿主侧全部
  // createMacroEngine 调用点（plugin 四处）共享同一批扩展宏。逐项 try/catch
  // 降级——坏注册（registerMacro 契约外的名字）只跳过该项，不炸引擎实例；
  // 未知/失败宏本就保持原文（ST evaluateMacros 语义）。P2：吸收前先把当前
  // registry 键集记进内置名单快照（reg 是 Map.set 后写胜，mod 宏若撞内置名
  // 会劫持 {{char}} 等核心宏——宿主注册面据此拒名）。
  for (const key of registry.keys()) builtinMacroNameSet.add(key);
  for (const entry of hostMacroSnapshot()) {
    try {
      registerMacro(entry.name, entry.fn);
    } catch {
      // skip malformed host macro registration
    }
  }

  const api: MacroEngine = {
    expand,
    getVar: name => readVar('local', name),
    setVar: (name, value) => {
      localVars.set(name, value);
    },
    hasVar: name => localVars.has(name),
    deleteVar: name => localVars.delete(name),
    getGlobalVar: name => readVar('global', name),
    setGlobalVar: (name, value) => {
      globalVars.set(name, value);
    },
    hasGlobalVar: name => globalVars.has(name),
    deleteGlobalVar: name => globalVars.delete(name),
    registerMacro,
    snapshotVars: () => ({
      local: Object.fromEntries(localVars),
      global: Object.fromEntries(globalVars),
    }),
  };

  return api;
}
