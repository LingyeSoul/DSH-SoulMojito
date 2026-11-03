# Chat Channels Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Recompose every chat-channels tab into a responsive task workspace while preserving all IM behavior and host branding.

**Architecture:** Keep the existing React `h(...)` client fragments and host-token CSS. Add presentation-only layout regions and scoped `dt-im-*` rules; do not alter data loading, actions, routes, or generated bundles by hand.

**Tech Stack:** JavaScript, React-style `h(...)` components, CSS, Vitest, the design-taste app inspector.

**Spec:** `docs/superpowers/specs/2026-11-03-chat-channels-layout-design.md`

## Global Constraints

- Edit `client-src`, focused tests, and these approved design/plan documents only; generated `client/main.js` and `client/index.js` are build outputs.
- Preserve tab order, translation keys, IM selectors, callbacks, polling, API payloads, and server-visible behavior.
- Reuse host design tokens and support both themes with no new dependencies or hard-coded palette.
- Keep the dealt `framed-sheet` direction, seed `1798882976`: quiet sheet, 24px desktop content gutter, 16px phone gutter, 2px active-tab underline, no nested outer frame.
- Do not run Git mutations or commit files unless the user explicitly requests it.

## Review Focus

- Long peer keys and account IDs must not push actions off-screen; Task 2 adds a populated peer-row render assertion and Task 3 checks phone screenshots.
- Four tabs and log-level filters must overflow within their own rows rather than widening the panel; Task 3 pins the scoped overflow rules and checks 390px screenshots.
- Empty, loading, unavailable, QR, and populated states must retain their existing content; Task 1 reuses the render smoke suite and checks channel/QR states.
- Desktop grids must not leave an orphan channel card or squeeze form controls at tablet widths; Task 3 pins the 1100px and 700px breakpoints and inspects 1440/768/390.
- Touch targets and focus visibility must survive the denser layout; Task 3 pins the 44px phone rule and checks keyboard-focus states in the browser harness.

---

### Task 1: Shared workspace and channel setup

**Files:**
- Modify: `packages/plugin/client-src/97-ui-im.js`
- Modify: `packages/plugin/client-src/95-ui-styles.js`
- Test: `packages/plugin/tests/im-panel.spec.ts`

**Interfaces:**
- Consumes: Existing `PanelIm`, `ImChannelCard`, `ImOneBotBand`, and `ImBindPanel` props and callbacks.
- Produces: Root `.dt-im-workspace`; scoped shared layout rules; channel, OneBot, and QR layout behavior used by the remaining tasks.

- [x] **Step 1: Write the failing render/layout test**

Add `composes the task workspace without changing channel content (render smoke)` to `im-panel.spec.ts`. Render the default `PanelIm`, assert `.dt-im-workspace`, all three `ImChannelCard` instances, `ImOneBotBand`, the existing four tabs, and the existing `data-im-tab-panel=channels` marker. Assert the style source contains `.dt-im-workspace`, `.dt-im-tabs{position:sticky`, and a three-column desktop `.dt-im-form` rule.

- [x] **Step 2: Run the focused test and confirm the new assertions fail**

Run: `pnpm vitest run packages/plugin/tests/im-panel.spec.ts`
Expected: the existing tests pass; the new test fails because the workspace root and new layout rules do not exist.

- [x] **Step 3: Implement the shared and channel layout**

Wrap `PanelIm` in `.dt-im-workspace` without changing its state or tab branching. Replace only the IM CSS block: compact the intro, make tabs sticky with an opaque host-token background, align the three channel cards, use a `minmax(0,1fr) minmax(0,1fr) auto` OneBot form, and retain the side-by-side QR layout. Keep all existing selectors and component callback props.

- [x] **Step 4: Run the focused test**

Run: `pnpm vitest run packages/plugin/tests/im-panel.spec.ts`
Expected: all IM panel tests pass.

### Task 2: Bindings and behavior workspaces

**Files:**
- Modify: `packages/plugin/client-src/97f-ui-im-peers.js`
- Modify: `packages/plugin/client-src/97cc-ui-im-behavior.js`
- Modify: `packages/plugin/client-src/97-ui-im.js`
- Modify: `packages/plugin/client-src/95-ui-styles.js`
- Test: `packages/plugin/tests/im-panel.spec.ts`

**Interfaces:**
- Consumes: Existing `ImPeerRow`, `ImOwnerControls`, `ImSettingsBand`, and `ImBehaviorBand` props and callbacks.
- Produces: `.dt-im-bindings`, `.dt-im-access`, `.dt-im-peer-owner`, and aligned behavior/status/owner grids; no public behavior changes.

- [x] **Step 1: Write the failing region-separation test**

Add `separates routing facts, owner controls, and access settings (render smoke)`. Render a populated `ImPeerRow` and assert its owner label and `ImOwnerControls` are inside a `.dt-im-peer-owner` region while identity remains in `.dt-im-peer-main`. Render `ImPeersBand` and `ImSettingsBand` and assert `.dt-im-bindings` and `.dt-im-access`. Extend the behavior smoke assertion to require `.dt-im-behavior-workspace` around the existing send settings and global-owner sections.

- [x] **Step 2: Run the focused test and confirm the new assertions fail**

Run: `pnpm vitest run packages/plugin/tests/im-panel.spec.ts`
Expected: only the new region assertions fail.

- [x] **Step 3: Implement binding and behavior regions**

Add the named section classes. Move the existing owner label/controls into `.dt-im-peer-owner` and keep peer identity/session/time in `.dt-im-peer-main`; keep row actions unchanged. Wrap the behavior fragment in `.dt-im-behavior-workspace`. Add scoped grids for peer identity/owner/actions, pending rows, access settings, interval controls, send statuses, and global-owner rows. Do not rename any callback or data marker.

- [x] **Step 4: Run the focused test**

Run: `pnpm vitest run packages/plugin/tests/im-panel.spec.ts`
Expected: all IM panel tests pass.

### Task 3: Logs, responsive rules, and visual verification

**Files:**
- Modify: `packages/plugin/client-src/97b-ui-im-logs.js` only if a presentation wrapper is necessary
- Modify: `packages/plugin/client-src/95-ui-styles.js`
- Test: `packages/plugin/tests/im-panel.spec.ts`
- Create outside the repository deliverable: a disposable browser harness under the approved OpenCode temp directory with synthetic IM data.

**Interfaces:**
- Consumes: The shared workspace and all region classes from Tasks 1–2; existing `ImLogBand` and `ImLogRows` markup.
- Produces: Final desktop/tablet/phone layout and screenshot evidence for channels, bindings, behavior, and logs.

- [x] **Step 1: Write the failing responsive-style test**

Add `keeps IM controls and dense rows usable at tablet and phone widths`. Assert the IM CSS has a `max-width:1100px` channel/form reflow, a `max-width:700px` phone composition, 44px phone control targets, independently scrolling tab/filter rows, and phone log text spanning `grid-column:1/-1`. Also assert `prefers-reduced-motion` remains present.

- [x] **Step 2: Run the focused test and confirm the new assertions fail**

Run: `pnpm vitest run packages/plugin/tests/im-panel.spec.ts`
Expected: only the new responsive assertions fail.

- [x] **Step 3: Implement final log and responsive composition**

Keep log title/count, level filters, and actions in compact regions. Use stable desktop time/level/message columns and two-line phone rows. At 1100px reflow narrow grids before they orphan or squeeze; at 700px use 16px gutters, 44px controls, single-column forms/cards, and local horizontal scrolling for tabs/filters. Preserve reduced motion and focus rules.

- [x] **Step 4: Run source checks and build the visual harness**

Run: `pnpm vitest run packages/plugin/tests/im-panel.spec.ts`
Run: `node "$env:USERPROFILE/.agents/skills/design-taste-frontend/scripts/lint.mjs" --app packages/plugin/client-src/97-ui-im.js packages/plugin/client-src/97b-ui-im-logs.js packages/plugin/client-src/97cc-ui-im-behavior.js packages/plugin/client-src/97d-ui-im-bind.js packages/plugin/client-src/97e-ui-im-owner.js packages/plugin/client-src/97f-ui-im-peers.js packages/plugin/client-src/95-ui-styles.js`
Expected: tests pass and lint reports no violation introduced by this work.

Build a disposable harness with the real IM markup and CSS plus synthetic populated/empty states. Do not add real user data or credentials to the repository.

- [x] **Step 5: Inspect and critique every tab at three widths**

Run the app inspector against the harness at its supported 1440, 768, and 390 widths, then open every screenshot. Verify all four tabs, QR setup, long peer keys, empty states, and both host-token themes where supported. Fix every in-scope `FAIL`, treat warnings as design defects unless defensible, and complete at most three look/fix rounds.

- [x] **Step 6: Run final repository verification without clobbering unrelated changes**

Run the focused test again and the relevant client build/gate checks. Before any full build, preserve the user's existing uncommitted `agent.mjs`, `index.mjs`, and `novel.mjs` changes and verify the final diff contains only approved files plus deterministic client build outputs. Report exact commands, screenshot locations, and any check that could not run.
