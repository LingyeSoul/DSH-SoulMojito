# Chat channels task workspace layout

## Intent

Improve the complete layout and UX of the administration panel's chat channels section without changing its IM behavior, data contracts, or visual brand.

## Goals

- Make each tab answer its primary job first: connect channels, route peers, adjust sending behavior, and inspect logs.
- Establish consistent alignment, density, control sizing, status hierarchy, and responsive behavior across all four tabs.
- Preserve keyboard access, readable touch targets, loading/error/empty states, and both host themes.

## Non-goals and anti-goals

- No API, polling, binding, owner, permission, or runtime behavior changes.
- No new dependencies, theme palette, font stack, outer panel shell redesign, or generated-bundle edits.
- No decorative card proliferation, gradients, glass, icon tiles, vanity metrics, or landing-page styling.

## Constraints

- Edit only the IM client source fragments and their focused tests; never hand-edit `client/main.js` or `client/index.js`.
- Keep existing IM selectors, translation keys, tab order, actions, and server-visible semantics intact unless a focused test establishes a presentation-only improvement.
- Reuse host design tokens and preserve the existing light/dark theme behavior.
- Respect existing uncommitted changes in unrelated generated bundles.

## Approaches

1. **Task workspace (selected):** Recompose all four tabs around their main jobs, with structural markup adjustments where necessary and a complete responsive treatment. This gives the largest UX improvement while keeping behavior intact.
2. **Light visual restyle:** Mostly CSS changes. Lower risk, but it cannot adequately repair peer-action grouping or the behavior tab's mixed hierarchy.
3. **Dense operations console:** Optimize for long monitoring sessions with denser data and stronger terminal cues. This is less suitable for first-time channel setup and less consistent with the host product.

## Selected direction

Use the dealt `framed-sheet` app direction for composition only, keeping the existing palette and type. The host already supplies the outer frame, so the IM page takes its quiet sheet, aligned edges, restrained tabs, and content hierarchy rather than adding another nested frame.

### Shared structure

- Compress the introductory band so the tabs and primary content appear earlier.
- Keep the four existing tabs, with a clear active underline, independent horizontal overflow, and a sticky position during long content scrolling.
- Use one content gutter and shared heading, feedback, form, and list alignment.
- Keep feedback near the active panel without displacing the primary workflow more than necessary.

### Channels

- Present QQ, WeChat, and OneBot as one aligned three-channel workspace on wide screens and a single-column flow on narrow screens.
- Make channel name and state the first read, accounts the second, and the appropriate setup action the final step.
- Keep QR verification in a focused two-column setup region when space allows and stack it cleanly on phones.
- Turn the OneBot form into a clearly labelled setup grid with aligned fields, action, and copyable endpoint output.

### Bindings

- Keep pending peers ahead of established bindings and make their bind action visually immediate.
- Separate peer identity/session facts from owner controls and row actions so long identifiers do not force ragged layouts.
- Keep access control below routing, with the mention toggle and the two allowlists sharing one grid.

### Behavior

- Separate the editable send interval from live send-status rows and global-owner controls.
- Align save/reset actions with the interval field on desktop and preserve a simple stacked flow on phones.
- Render status and owner rows with stable identity, state, and action regions; keep command help subordinate.

### Logs

- Keep the title/count, level filters, and refresh/clear actions in a compact toolbar.
- Use stable time/level/message columns on desktop and a two-line readable row on phones.
- Preserve the bounded scroll region and avoid horizontal page overflow.

### Responsive and interaction rules

- At phone widths, use 16px content gutters, at least 44px touch targets, single-column forms/cards, and independently scrolling tabs/filters.
- Do not drop fields or actions on small screens; reflow them into identity-first rows.
- Preserve visible focus, disabled states, reduced motion, and readable text contrast.

## Verification

- Run the focused IM panel tests and source lint.
- Exercise all four tabs with representative populated, empty, and long-content states at desktop, tablet, and phone widths.
- Inspect screenshots in both host themes where the harness supports them, fix visual regressions, then run the relevant build/gate checks without overwriting unrelated user changes.
