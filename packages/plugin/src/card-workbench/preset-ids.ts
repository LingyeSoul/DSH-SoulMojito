/**
 * Card Workbench preset ids (2026-11-17 native Agent mode).
 *
 * Kept free of runtime imports: the ids are shared by the index bundle
 * (`http/novel.ts`, the state route and the lifecycle reconciler) and the
 * standalone card-workbench bundle. `card-workbench` is the Tavern-only
 * composition; `card-workbench-native` adds the standard DSH tool rows when
 * `state.cardWorkbenchNativeAgentMode === true`.
 */

export const CARD_WORKBENCH_PRESET_ID = 'card-workbench'
export const CARD_WORKBENCH_NATIVE_PRESET_ID = 'card-workbench-native'

export function cardWorkbenchPresetIdFor(state: { cardWorkbenchNativeAgentMode?: boolean }): string {
  return state.cardWorkbenchNativeAgentMode === true
    ? CARD_WORKBENCH_NATIVE_PRESET_ID
    : CARD_WORKBENCH_PRESET_ID
}