/**
 * Public types for @dsh-tavern/macros.
 *
 * Semantics are modeled on SillyTavern's macro pipeline
 * (public/scripts/macros.js + public/scripts/variables.js + substituteParams in script.js),
 * re-implemented independently (clean-room, no ST code).
 */

/** Values storable in the local/global variable maps. */
export type VariableValue = string | number | boolean;

/** Plain-object variable map used at engine creation. */
export type VariableMap = Record<string, VariableValue>;

/**
 * Character-card fields the engine can substitute.
 * Field names follow the @dsh-tavern/format `CardDataIR` naming.
 */
export interface MacroCardFields {
  description?: string;
  personality?: string;
  scenario?: string;
  /** Card `mes_example` -> {{mesExamples}} / {{mesExamplesRaw}} */
  mesExample?: string;
  /** Card `system_prompt` -> {{charPrompt}} */
  systemPrompt?: string;
  /** Card `post_history_instructions` -> {{charInstruction}} / {{charJailbreak}} */
  postHistoryInstructions?: string;
  /** ST depth_prompt.prompt -> {{charDepthPrompt}} */
  charDepthPrompt?: string;
  /** Card `creator_notes` -> {{creatorNotes}} / {{charCreatorNotes}} */
  creatorNotes?: string;
}

/** Macro names are case-insensitive; variable names are case-sensitive (as in ST). */
export interface MacroEngineInit {
  /** {{char}} (required) */
  char: string;
  /** {{user}} (required) */
  user: string;
  /**
   * Group member list (e.g. "Alice, Bob"). When set, {{group}} / {{charIfNotGroup}}
   * expand to it; when unset they fall back to `char` (ST substituteParams getGroupValue).
   */
  group?: string;
  /** Persona description -> {{persona}} */
  persona?: string;
  /** Card fields (all optional; unset -> empty string) */
  card?: MacroCardFields;
  /** Preset-level system prompt -> {{systemPrompt}} */
  systemPrompt?: string;
  /** Passthrough -> {{original}} */
  original?: string;
  /** {{model}} */
  model?: string;
  /** {{maxContextTokens}}; also the fallback for {{maxPrompt}} (ST: maxPrompt = max context size) */
  maxContextTokens?: number;
  /** {{maxPrompt}} (defaults to maxContextTokens) */
  maxPrompt?: number;
  /** {{maxResponseTokens}} */
  maxResponseTokens?: number;
  /** {{lastMessage}} */
  lastMessage?: string;
  /** {{lastUserMessage}} */
  lastUserMessage?: string;
  /** {{lastCharMessage}} */
  lastCharMessage?: string;
  /** {{lastMessageId}} (ST: String(id ?? '')) */
  lastMessageId?: number;
  /**
   * Seconds since the last user message -> {{idle_duration}} / {{idleDuration}},
   * humanized like moment's duration.humanize(). Undefined -> "just now"
   * (ST getTimeSinceLastMessage fallback).
   */
  idleDurationSeconds?: number;
  /**
   * Stable-pick scope id for {{pick}}: same chatId + same macro position -> same
   * choice across evaluations (ST getPickReplaceMacro seeds on the chat id hash).
   */
  chatId?: string;
  /** Initial local (chat-scoped) variables. Copied; mutation happens via the engine. */
  local?: VariableMap;
  /** Initial global variables. Copied; mutation happens via the engine. */
  global?: VariableMap;
  /** Clock injection (default: real time). */
  now?: () => Date;
  /** Random source in [0, 1) for {{random}} / {{roll}} (default: Math.random). */
  rng?: () => number;
}

/**
 * Extension macro. Receives the `::`-separated arguments (empty array when none)
 * and the engine. Return the replacement string, or null to leave the macro
 * untouched (same convention as unknown built-ins).
 */
export type MacroFunction = (args: string[], engine: MacroEngine) => string | null;

export interface MacroEngine {
  /** Substitute all macros in `text`. Single pass; unknown macros are left unchanged. */
  expand(text: string): string;
  /* ---- local (chat-scoped) variables ---- */
  getVar(name: string): VariableValue | undefined;
  setVar(name: string, value: VariableValue): void;
  hasVar(name: string): boolean;
  deleteVar(name: string): boolean;
  /* ---- global variables ---- */
  getGlobalVar(name: string): VariableValue | undefined;
  setGlobalVar(name: string, value: VariableValue): void;
  hasGlobalVar(name: string): boolean;
  deleteGlobalVar(name: string): boolean;
  /**
   * Register/override a macro (case-insensitive name, no braces).
   * Mirrors ST MacrosParser.registerMacro validation: throws TypeError on an
   * empty name or a name containing the surrounding braces.
   */
  registerMacro(name: string, fn: MacroFunction): void;
  /**
   * Copy of the current local (chat-scoped) and global variable maps.
   * Callers persist these between evaluations (chat metadata / plugin state).
   */
  snapshotVars(): { local: VariableMap; global: VariableMap };
}
