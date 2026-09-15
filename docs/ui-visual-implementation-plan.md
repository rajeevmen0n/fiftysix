# UI and Visual Design Implementation Plan

> **Agent workflow:** Follow the lightweight develop-and-review loop in `AGENTS.md`; do not load
> an additional process skill. Use the checkboxes (`- [ ]`) for progress tracking.

**Goal:** Deliver the polished, responsive, accessible player, Table, and debug experiences for
56 and 28 using only server-authoritative views and capabilities.

**Architecture:** The React app renders protocol-owned, already-redacted room views through pure
view-model/layout helpers and focused visual components. Zustand keeps the latest authoritative
view while a separate animation queue owns the displayed view and processes redacted events in
order; screens submit typed commands but never reproduce game or room legality. Shared table/card
components serve player, couch, Table, and debug presentations across fluid container-driven
layouts.

**Tech Stack:** React 19, TypeScript, Vite, React Router, Zustand, Motion (`motion/react`),
Tailwind CSS v4, Radix UI primitives, i18next/react-i18next, Fontsource Inter and Newsreader,
`qrcode`, Gemini MCP-generated image assets, pnpm, Nix.

**Spec:** `docs/ui-visual-design.md`

**Status:** Approved on 2026-09-14 after screen-flow, capability-boundary, responsive-state,
animation, accessibility, asset-provenance, type-interface, and completeness review.

## Global constraints

- Do not execute U001 until the repository skeleton, pure engine, and rooms subsystem are
  implemented and marked complete in `docs/implementation-progress.md`.
- Every unit reads `AGENTS.md`, `design.md`, `docs/ui-visual-design.md`,
  `docs/implementation-progress.md`, this header, the current unit, and its declared dependencies.
  Units touching game presentation also read `rules.md` and `docs/game-engine-design.md`; units
  touching room flows also read `docs/rooms-subsystem-design.md`.
- Work strictly sequentially. Use Claude Sonnet or GPT `gpt-5.6-terra` at high effort for the
  main agent. Dispatch one implementation agent with an isolated initial fork
  (`fork_turns: "none"`) using the exact suggested Claude/GPT model pair below. When its initial
  implementation is ready, dispatch one Claude Opus or GPT `gpt-5.6-sol` review agent at high
  effort.
- **Keep the implementation and review agents available until the unit is completely finished.**
  Send every review correction back to the same implementer and every corrected diff back to the
  same reviewer; never create replacement agents for later iterations. After reviewer approval
  and main-agent verification, stop and ask the user after every completed unit.
- Claude Fable / GPT `gpt-6-astra` units are deliberately narrow: one asset family, component,
  responsive state, or motion family. Do not expand one into adjacent screens or infrastructure.
- Tests, stories, and snapshots are not required solely for coverage, and no broad test/story
  framework is added preemptively. Use typecheck, lint, build, real room/debug flows, browser
  inspection, and the responsive/accessibility matrix where sufficient. If verification requires
  executable scenarios, assertions, fakes, fixtures, snapshots, or a custom harness, commit the
  result as a focused maintained test instead of a disposable command or temporary script.
- `apps/web` imports only types from protocol and never imports runtime code from protocol,
  engine, or server. It never derives legality, hidden information, room authority, or scoring.
- Render only server-provided views, events, and allowed actions. Lock only the initiating
  control while its command is pending; do not optimistically change authoritative game state.
- Every visible string, accessible name, live announcement, error, and generated-image alt text
  comes from `locales/en.json` through i18next. English is the only v1 locale.
- Use Tailwind v4 theme tokens, `dvh`, fractions, `clamp()`, `aspect-ratio`, safe-area insets,
  container queries, and calculated CSS variables. No fixed device canvas or fixed layout width/
  height is allowed.
- Wrap the app in `MotionConfig reducedMotion="user"`. All gameplay animations enter the queue;
  reduced motion makes transitions instant without removing final state, labels, or focus.
- Generate every picture/image asset only with the Gemini MCP. Each prompt must explicitly ask
  for high-quality, polished, visually appealing output matching this app's visual style. Commit
  the generated original under `apps/web/src/assets/` and record its exact prompt beside it. If
  Gemini MCP is unavailable, block the asset unit; do not use another generator, stock art, or a
  temporary image.
- After any `pnpm-lock.yaml` change, update the dependency hash in `nix/package.nix` in the same
  unit and require `nix build` before commit.
- Routes are `/`, `/room/:code`, `/table/:code`, and `/debug`. `/?room=CODE` pre-fills both join
  paths. Tokens never appear in URLs.
- Keep PWA installation, dark-mode selection, Malayalam, sounds/haptics, bots, accounts/stats,
  rules help, free-text chat, general spectators, and shareable summary images out of v1.

## Progress protocol

At unit start, set the UI row and unit to `In progress` in
`docs/implementation-progress.md`. At completion:

1. The retained review agent approves the entire diff, then the main agent reruns the unit's
   verification commands.
2. Change the unit heading from `[ ]` to `[x]`.
3. Record the commit, visual/manual evidence, and next unit in the progress ledger.
4. Commit implementation, plan checkbox, prompt records when applicable, and ledger update
   together.
5. Stop and ask the user before starting the next unit.

If blocked, keep the checkbox open and record the exact blocker, screenshots/process state,
working-tree/commit state, and smallest next action in the ledger.

## Planned files

```text
apps/web/src/
  styles/{theme,global}.css
  assets/
    brand/{logo-56,app-icon-56,table-texture}.png
    brand/prompts.md
    cards/{card-back,court-j,court-q,court-k}.png
    cards/prompts.md
  logic/{card-layout,seat-layout,control-model,view-model}.ts
  animation/{types,queue,frames,index}.ts
  animation/steps/{deal,card-play,round-win,trump,transient,results}.ts
  components/
    Card.tsx Hand.tsx Seat.tsx TableSurface.tsx StatusStrip.tsx
    GameShell.tsx ActionDock.tsx GameOverlay.tsx AuctionControls.tsx
    MatchSummary.tsx SessionSummary.tsx
  components/primitives/{Dialog,Menu,Popover,Sheet,Toast}.tsx
  net/{room-api,debug-client}.ts
  store/{ui-store,debug-store}.ts
  screens/{Home,Lobby,Game,Couch,Table,Recovery,Debug}.tsx
  App.tsx main.tsx i18n.ts
locales/en.json

packages/protocol/src/debug/{http,messages,index}.ts
apps/server/src/debug/{types,credentials,seeded-random,debug-service}.ts
apps/server/src/routes/debug.ts
```

Use the actual prerequisite protocol/store filenames if they differ, and record a one-to-one path
substitution in the ledger rather than creating duplicate state or network clients.

---

### [ ] U001: Establish the visual foundation and UI runtime

**Suggested implementer:** Claude Opus or GPT `gpt-5.6-sol`, high effort

**Files:**
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `nix/package.nix`
- Create: `apps/web/src/styles/theme.css`
- Create: `apps/web/src/styles/global.css`
- Modify: `apps/web/src/i18n.ts`
- Modify: `apps/web/src/main.tsx`
- Modify: `locales/en.json`

**Depends on:** Completed skeleton, engine, and rooms subsystem.

**Interfaces produced:**

```ts
import en from "../../../locales/en.json";
export type TranslationKey = keyof typeof en;
export const uiMotionConfig = {reducedMotion: "user" as const};
```

- [ ] Add exact workspace dependencies for Motion, Tailwind CSS v4 and its Vite integration,
  Radix Dialog/Menu/Popover/Toast primitives, Fontsource Inter/Newsreader, `qrcode`, and its types.
  Regenerate the lockfile, update the Nix dependency hash, and keep versions pinned by the lock.
- [ ] Define Tailwind `@theme` roles for midnight `#081011`, ink `#111D1D`, raised ink `#172625`,
  ivory `#FFF5DC`, dim ivory `#D8CCB1`, emerald `#0D6956`, coral `#A83E3B`, and brass `#C8A45B`,
  plus restrained radii, borders, elevations, fluid spacing, and tabular numeral utilities.
- [ ] Bundle Inter for interface/gameplay and Newsreader only for identity/results. Set dark v1
  color roles, system/Georgia fallbacks, visible brass/ink focus rings, safe-area defaults, and
  reduced-motion CSS without adding a theme toggle.
- [ ] Type i18next against `locales/en.json`; migrate every existing visible/accessibility string
  to namespaced keys. Wrap the router in `MotionConfig reducedMotion="user"`.
- [ ] Inspect the status screen at small portrait phone, landscape phone, desktop, and 200% zoom;
  verify font loading, focus visibility, contrast, no horizontal overflow, and reduced motion.
- [ ] Run typecheck, lint, build, `nix build`, and `git diff --check`; require success. Update
  plan/progress and commit `feat(web): establish visual foundation`.

---

### [ ] U002: Generate the brand and surface asset family

**Suggested implementer:** Claude Fable or GPT `gpt-6-astra`, high effort

**Files:**
- Create: `apps/web/src/assets/brand/logo-56.png`
- Create: `apps/web/src/assets/brand/app-icon-56.png`
- Create: `apps/web/src/assets/brand/table-texture.png`
- Create: `apps/web/src/assets/brand/prompts.md`

**Depends on:** U001.

**Interfaces produced:** Three optimized image assets plus exact regeneration prompts; no runtime
TypeScript interface.

```text
Logo prompt:
Create a high-quality, polished, visually appealing identity mark for “56”, a multiplayer Kerala
card-game web app. Use a contemporary broadcast-table character softened by a warm card-night
atmosphere: midnight and ink foundation, warm ivory numeral, restrained brass accent, and a small
emerald interlocking-wave motif. Keep the numeral immediately legible at phone size, flat and
geometric, with no wood framing, ornamental pastiche, playing-card collage, gradients, mockup,
extra words, or background. Produce an isolated transparent-background square asset matching the
app’s approved visual style.

App-icon prompt:
Create a high-quality, polished, visually appealing square app icon for the “56” Kerala card-game
web app, derived from a bold ivory 56 monogram on midnight ink with one restrained brass detail
and an emerald continuous-wave accent. It must remain recognizable at 32 px, have no words beyond
56, no tiny detail, no mockup, no rounded-device frame, and no transparent holes. Match the app’s
contemporary broadcast-table visual style.

Texture prompt:
Create a high-quality, polished, visually appealing seamless dark table-surface texture for a
Kerala card-game web app. Use an almost-flat midnight-to-ink woven grain with extremely subtle
emerald undertones and sparse low-contrast brass flecks. It must preserve ivory-card and text
contrast, contain no objects, symbols, cards, wood grain, borders, lighting hotspot, or text, and
match the app’s calm contemporary broadcast-table visual style.
```

- [ ] Use only the Gemini MCP with the three exact prompts. Save its generated originals at the
  declared paths and copy the exact prompt, generation date, model/output metadata, and any
  lossless crop/downscale commands into `prompts.md`.
- [ ] Select one coherent result per prompt. Crop/resize only; do not paint over or combine stock
  material. Preserve a square transparent logo, square opaque icon, and seamless texture.
- [ ] Optimize files without visible banding or edge seams. Verify the mark at 32/64 px, tile the
  texture across phone/TV proportions, and require that ivory text/cards retain contrast.
- [ ] Record the declared production consumers: U009 uses the texture, and U012 uses the logo and
  browser app icon. An asset without a planned consumer blocks this unit's acceptance.
- [ ] Run asset metadata checks, lint, build, `git diff --check`, and an asset-origin audit;
  require success. Update plan/progress and commit `feat(web): add generated brand assets`.

---

### [ ] U003: Generate the card-art asset family

**Suggested implementer:** Claude Fable or GPT `gpt-6-astra`, high effort

**Files:**
- Create: `apps/web/src/assets/cards/card-back.png`
- Create: `apps/web/src/assets/cards/court-j.png`
- Create: `apps/web/src/assets/cards/court-q.png`
- Create: `apps/web/src/assets/cards/court-k.png`
- Create: `apps/web/src/assets/cards/prompts.md`

**Depends on:** U001–U002.

**Interfaces produced:** One directionless card back and three transparent court portraits with
exact regeneration prompts.

```text
Card-back prompt:
Create a high-quality, polished, visually appealing, perfectly directionless playing-card back
for the 56 Kerala card-game web app. Use a deep ink field, restrained brass linework, and an
emerald interlocking continuous-wave motif with exact 180-degree rotational symmetry. Keep the
pattern crisp at small phone size, calm rather than ornate, with no words, numerals, suit marks,
directional top edge, mockup, border outside the card rectangle, wood, or photorealism. Match the
approved contemporary broadcast-table visual style.

Jack prompt:
Create a high-quality, polished, visually appealing simplified geometric Jack court portrait for
a small playing-card face in the 56 Kerala card-game web app. Use bold symmetric shapes, warm
ivory negative space, ink outlines, restrained coral, emerald, and brass accents, and a distinct
youthful Jack silhouette. No letter, suit mark, card border, background, mockup, gradients, or
fine facial detail. Produce an isolated transparent asset matching the approved visual style.

Queen prompt:
Create a high-quality, polished, visually appealing simplified geometric Queen court portrait for
a small playing-card face in the 56 Kerala card-game web app. Use bold symmetric shapes, warm
ivory negative space, ink outlines, restrained coral, emerald, and brass accents, and a distinct
regal Queen silhouette. No letter, suit mark, card border, background, mockup, gradients, or fine
facial detail. Produce an isolated transparent asset matching the approved visual style.

King prompt:
Create a high-quality, polished, visually appealing simplified geometric King court portrait for
a small playing-card face in the 56 Kerala card-game web app. Use bold symmetric shapes, warm
ivory negative space, ink outlines, restrained coral, emerald, and brass accents, and a distinct
crowned King silhouette. No letter, suit mark, card border, background, mockup, gradients, or fine
facial detail. Produce an isolated transparent asset matching the approved visual style.
```

- [ ] Generate only through Gemini MCP with the exact prompts and record prompt/date/model/output
  metadata plus lossless processing commands beside the originals.
- [ ] Require the back to remain directionless at 0/180 degrees and every portrait to stay
  recognizable at the smallest planned card size. Reject outputs with text, built-in suit marks,
  backgrounds, gradients, or inconsistent portrait framing.
- [ ] Optimize transparent/opaque assets without halos, compare the four files against U002's
  palette, and verify no stock, alternate generator, or unrecorded derivative enters the tree.
- [ ] Run metadata, lint, build, and `git diff --check`; require success. Update plan/progress and
  commit `feat(web): add generated card art`.

---

### [ ] U004: Build the accessible Card component

**Suggested implementer:** Claude Fable or GPT `gpt-6-astra`, high effort

**Files:**
- Create: `apps/web/src/components/Card.tsx`
- Modify: `apps/web/src/styles/global.css`
- Modify: `locales/en.json`

**Depends on:** U001 and U003.

**Interfaces produced:**

```ts
export interface CardProps {
  card: Card | null;
  side: "front" | "back";
  selected: boolean;
  disabled: boolean;
  faceDown: boolean;
  motionId: string | null;
  onActivate?: () => void;
}
export function Card(props: CardProps): React.JSX.Element;
```

- [ ] Render warm-ivory SVG card structure with conventional rank/suit corners, red/black suit
  contrast, generated J/Q/K portraits, and generated back art. Keep card identity/type local to
  the protocol's type-only `Card` export and use no engine runtime import.
- [ ] Support front/back, selected, disabled, face-down, keyboard-focus, press, and flip states.
  Implement flips with CSS 3D, `aspect-ratio`, and Motion layout IDs; remove transition under
  reduced motion.
- [ ] Give interactive cards button semantics, logical DOM order, translated “rank of suit” names,
  visible selected/disabled cues beyond color, and a minimum usable focus target despite visual
  overlap.
- [ ] Inspect every rank/suit, J/Q/K, face-down/back, smallest/largest size, focus, 200% zoom, and
  reduced motion against midnight/ink surfaces.
- [ ] Run typecheck, lint, build, forbidden-import/string scans, and `git diff --check`; require
  success. Update plan/progress and commit `feat(web): add card primitive`.

---

### [ ] U005: Implement pure responsive layout and control models

**Suggested implementer:** Claude Sonnet or GPT `gpt-5.6-terra`, high effort

**Files:**
- Create: `apps/web/src/logic/card-layout.ts`
- Create: `apps/web/src/logic/seat-layout.ts`
- Create: `apps/web/src/logic/control-model.ts`
- Create: `apps/web/src/logic/view-model.ts`

**Depends on:** U001 and prerequisite room protocol types.

**Interfaces produced:**

```ts
export interface HandLayout {cardWidth: number; overlap: number; fanDegrees: number;}
export function calculateHandLayout(containerWidth: number, cardCount: number): HandLayout;
export function relativeSeatIndex(viewerSeat: number, absoluteSeat: number, seatCount: number): number;
export function seatPosition(relativeIndex: number, seatCount: 4 | 6 | 8): {xPercent: number; yPercent: number; rotationDegrees: number};
export type DockMode = "waiting" | "auction" | "placingCard" | "play" | "surrender" | "matchOver" | "sessionOver";
export type PublicBubble = {kind: "bid" | "reaction"; label: string};
export type DisplayTransient = {id: string; seat: number | null; bubble: PublicBubble};
export function controlModel(view: RoomView): ControlModel;
```

- [ ] Calculate card width/overlap/fan from container width and 0–16 cards, preserving logical
  order and touchability without overflow. Return numbers for CSS variables, never viewport-
  specific constants or DOM calls.
- [ ] Map absolute seats to viewer-relative counter-clockwise positions and percentage/rotation
  values for 4/6/8 seats. Table viewer uses the public fixed orientation defined by the room view;
  player viewer remains at bottom.
- [ ] Map server phase/capability data to display labels, dock mode, and component props without
  deriving whether an action is legal. Preserve long names and nullable/redacted fields.
- [ ] Derive transient presentation IDs from room revision plus zero-based event index. Never
  require a server-internal event ID or generate a random render key.
- [ ] Add and run focused automated tests across all seat/viewer combinations, 0/1/6/8/12/16
  cards, narrow/wide containers, all room phases, and empty capability lists; require finite
  bounded results.
- [ ] Run typecheck, lint, build, and `git diff --check`; require success. Update plan/progress and
  commit `feat(web): add responsive view models`.

---

### [ ] U006: Build the phone-portrait gameplay shell

**Suggested implementer:** Claude Fable or GPT `gpt-6-astra`, high effort

**Files:**
- Create: `apps/web/src/components/GameShell.tsx`
- Modify: `apps/web/src/styles/global.css`

**Depends on:** U001 and U005.

**Interfaces produced:**

```ts
export interface GameShellProps {
  mode: "player" | "couch" | "table";
  status: React.ReactNode;
  table: React.ReactNode;
  actions: React.ReactNode;
  hand: React.ReactNode;
  sidebar: React.ReactNode;
}
```

- [ ] Implement the portrait grid with compact status, table-first main region, reserved action
  dock, and bottom hand. Dock changes must not resize/reposition table or hand.
- [ ] Use `dvh`, grid fractions, `clamp()`, container queries, safe-area insets, and CSS variables;
  avoid fixed device dimensions and preserve room for sixteen-card hands.
- [ ] Verify short/tall small phones, large phones, browser chrome changes, keyboard focus, long
  translated strings, 200% zoom, and reduced motion with temporary representative children.
- [ ] Run typecheck, lint, build, and `git diff --check`; require success. Update plan/progress and
  commit `feat(web): add portrait game shell`.

---

### [ ] U007: Add landscape, tablet, and desktop shell states

**Suggested implementer:** Claude Fable or GPT `gpt-6-astra`, high effort

**Files:**
- Modify: `apps/web/src/components/GameShell.tsx`
- Modify: `apps/web/src/styles/global.css`

**Depends on:** U006.

**Interfaces produced:** Extends `GameShell` through container-query layout only; no new public
TypeScript interface.

- [ ] Add a central table, bottom hand, status side rail, action side rail, and optional wide
  session-log sidebar using container queries. Preserve the portrait hierarchy instead of merely
  rotating/scaling it.
- [ ] Ensure tablet portrait/landscape, phone landscape, laptop, desktop, ultrawide, and TV-sized
  containers transition without overlap or source-order changes that harm keyboard navigation.
- [ ] Verify each breakpoint boundary, 200% zoom, safe areas, long copy, hidden/open sidebar, and
  reduced motion with the same representative content as U006.
- [ ] Run typecheck, lint, build, and `git diff --check`; require success. Update plan/progress and
  commit `feat(web): add wide game shell`.

---

### [ ] U008: Build the Seat component

**Suggested implementer:** Claude Fable or GPT `gpt-6-astra`, high effort

**Files:**
- Create: `apps/web/src/components/Seat.tsx`
- Modify: `locales/en.json`

**Depends on:** U001 and U005.

**Interfaces produced:**

```ts
export interface SeatProps {
  seat: PublicPlayer | null;
  team: Team;
  position: {xPercent: number; yPercent: number; rotationDegrees: number};
  dealer: boolean;
  active: boolean;
  connected: boolean;
  ready: boolean;
  bubble: PublicBubble | null;
  onTakeSeat?: () => void;
}
```

- [ ] Render occupied/empty seats, player name, card count, host, dealer, turn, connection, Ready,
  and bid/reaction bubble states. Empty actionable seats remain obvious targets.
- [ ] Use emerald continuous-wave and coral radiating-sun markers with written team labels; use
  brass only for dealer/focus/action emphasis. No status relies on color alone.
- [ ] Preserve long valid names, distance readability, translated labels, focus/activation, and
  stable dimensions as bubbles/statuses enter or leave.
- [ ] Verify every state at all 4/6/8-seat positions on phone/TV surfaces, keyboard and screen-
  reader output, high zoom, and contrast.
- [ ] Run typecheck, lint, build, and `git diff --check`; require success. Update plan/progress and
  commit `feat(web): add seat component`.

---

### [ ] U009: Build TableSurface and StatusStrip

**Suggested implementer:** Claude Opus or GPT `gpt-5.6-sol`, high effort

**Files:**
- Create: `apps/web/src/components/TableSurface.tsx`
- Create: `apps/web/src/components/StatusStrip.tsx`
- Modify: `locales/en.json`

**Depends on:** U002, U005, and U008.

**Interfaces produced:**

```ts
export function TableSurface(props: {view: RoomView; transient: readonly DisplayTransient[]}): React.JSX.Element;
export function StatusStrip(props: {view: RoomView; compact: boolean}): React.JSX.Element;
```

- [ ] Position all seats relative to the viewer around a stable textured table and render current
  round cards, face-down spot, and public transients in the center without deriving winners or
  hidden state.
- [ ] Render both token balances and current contract, public trump, multiplier, dealer/round
  context in a compact portrait row and expanded side rail. Use tabular numerals and team markers.
- [ ] Keep cards the brightest objects, texture extremely subtle, seat/table geometry stable as
  counts/bubbles/contract change, and every redacted/null field intentionally absent.
- [ ] Drive real 4/6/8-seat rooms and 28 hidden/revealed states; inspect phone portrait/landscape,
  desktop, TV, long names, four-digit token balances, maximum stakes, and no-live-points views
  for leakage/overlap.
- [ ] Run typecheck, lint, build, forbidden-import checks, and `git diff --check`; require success.
  Update plan/progress and commit `feat(web): render table and status`.

---

### [ ] U010: Build the Hand interaction component

**Suggested implementer:** Claude Fable or GPT `gpt-6-astra`, high effort

**Files:**
- Create: `apps/web/src/components/Hand.tsx`
- Modify: `apps/web/src/components/Card.tsx`
- Modify: `locales/en.json`

**Depends on:** U004–U006.

**Interfaces produced:**

```ts
export interface HandProps {
  cards: readonly Card[];
  playableCards: readonly Card[];
  pendingCard: Card | null;
  onPlay(card: Card): void;
}
```

- [ ] Render sorted overlapping/fanned cards from server order or a presentation-only suit/rank
  sort, using U005 CSS variables so 1–16 cards fit without changing logical DOM order.
- [ ] Implement tap/click once to lift, same-card second activation to submit, another card to
  transfer selection, outside activation to clear, and arrow/home/end/enter/space keyboard paths.
- [ ] In Block mode dim and disable cards absent from `playableCards`; in Auto-stop preserve every
  server-listed card. Lock only `pendingCard`; do not remove/move it until authoritative update.
- [ ] Preserve complete keyboard targets despite overlap, translated accessible names, visible
  selection beyond motion/color, and instant reduced-motion transitions.
- [ ] Verify smallest/largest hands, duplicate-copy cards, touch/mouse/keyboard, narrow/wide/couch
  containers, pending rejection, and selection reset after authoritative updates.
- [ ] Run typecheck, lint, build, and `git diff --check`; require success. Update plan/progress and
  commit `feat(web): add playable hand`.

---

### [ ] U011: Build ActionDock and accessible overlay primitives

**Suggested implementer:** Claude Opus or GPT `gpt-5.6-sol`, high effort

**Files:**
- Create: `apps/web/src/components/ActionDock.tsx`
- Create: `apps/web/src/components/GameOverlay.tsx`
- Create: `apps/web/src/components/primitives/Dialog.tsx`
- Create: `apps/web/src/components/primitives/Menu.tsx`
- Create: `apps/web/src/components/primitives/Popover.tsx`
- Create: `apps/web/src/components/primitives/Sheet.tsx`
- Create: `apps/web/src/components/primitives/Toast.tsx`
- Modify: `locales/en.json`

**Depends on:** U001 and U005–U007.

**Interfaces produced:**

```ts
export interface ActionDockProps {model: ControlModel; children: React.ReactNode;}
export interface GameOverlayProps {kind: "stall" | "vote" | "recovery"; children: React.ReactNode;}
```

- [ ] Keep one reserved dock region for waiting, auction, placement, play, surrender, match-over,
  and session-over modes. Mode changes never move table/hand geometry.
- [ ] Wrap Radix primitives with the custom visual system while preserving focus trap/return,
  escape, outside dismissal where safe, keyboard menus, labelled sheets, and toast live regions.
- [ ] Make destructive host actions and permanent Leave use explicit confirmation; keep ordinary
  bids/passes/doubles/redoubles/card plays/Ready free of confirmation.
- [ ] Verify every dock/overlay state, nested focus return, mobile sheet, desktop popover/menu,
  long strings, zoom, and reduced motion.
- [ ] Run typecheck, lint, build, and `git diff --check`; require success. Update plan/progress and
  commit `feat(web): add action and overlay shells`.

---

### [ ] U012: Implement entry APIs, routing, and Home

**Suggested implementer:** Claude Opus or GPT `gpt-5.6-sol`, high effort

**Files:**
- Create: `apps/web/src/net/room-api.ts`
- Create: `apps/web/src/screens/Home.tsx`
- Create: `apps/web/src/screens/Game.tsx`
- Modify: `apps/web/index.html`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/store/room-store.ts`
- Modify: `locales/en.json`

**Depends on:** U001, U005, U009, U011, and completed rooms HTTP/protocol/client units.

**Interfaces produced:**

```ts
export interface RoomApi {
  create(request: CreateRoomRequest): Promise<CreateRoomResponse>;
  join(code: RoomCode, request: JoinRoomRequest): Promise<JoinRoomResponse>;
  openTable(code: RoomCode, request: OpenTableRequest): Promise<OpenTableResponse>;
}
export interface GameRouteProps {mode: "player" | "table";}
// Routes introduced here: /, /room/:code, /table/:code. U027 adds /debug.
```

- [ ] Implement same-origin JSON calls with type-only protocol imports, explicit HTTP-status to
  typed-error mapping including 413 and temporary 503 failures, abort support, and no token in
  URL/log/error text.
- [ ] Render three clear Home paths: Create a table, Join a game, Join as Table view. Prefill both
  join paths from validated `?room=CODE`, keep visible labels, and preserve valid fields on error.
- [ ] Use the generated `56` logo in the entry identity and wire the generated app icon into
  browser document metadata. Verify both at their smallest rendered sizes.
- [ ] Implement create basic/advanced settings exactly from design §2. Collapse advanced by
  default and summarize nondefaults; remove/disable impossible game/player/card combinations with
  translated explanations without duplicating server validation authority. Constrain names to
  1–24 user-perceived characters, tokens/stakes to 1–999, host wait to 1–3,600 seconds, and
  redeal threshold to the selected game/player cap. Keep names single-line and surface the
  server's control-character rejection accessibly.
- [ ] On successful player create/join, store the token through the room client and navigate to
  `/room/:code`; on Table authorization navigate to `/table/:code`. Restore an existing room token
  directly without calling join again.
- [ ] Make `Game` the synchronized route boundary for both in-room routes: connect with the stored
  token, render real loading/recovery status, and hand an accepted `RoomView` to the components
  already built. Keep player and Table capabilities distinct; U013 and U020 specialize their
  presentations without changing connection ownership.
- [ ] Verify create/join/rejoin/Table success and every 400/401/404/409/413/423/503 response,
  query prefill, field preservation, back/forward/reload, keyboard forms, narrow/wide layouts,
  and no URL token.
- [ ] Run typecheck, lint, build, string/import scans, and `git diff --check`; require success.
  Update plan/progress and commit `feat(web): add room entry flows`.

---

### [ ] U013: Build the interactive lobby

**Suggested implementer:** Claude Fable or GPT `gpt-6-astra`, high effort

**Files:**
- Create: `apps/web/src/screens/Lobby.tsx`
- Modify: `apps/web/src/screens/Game.tsx`
- Modify: `locales/en.json`

**Depends on:** U008–U012.

**Interfaces produced:**

```ts
export interface LobbyProps {view: RoomView; send(command: RoomCommand): string;}
```

- [ ] Reuse TableSurface for arranging state. Make allowed empty seats actionable and render
  occupied player/team/presence/host/dealer/Ready states without local legality.
- [ ] Add Sit, Unseat, Ready, host move/swap/remove, transfer-host, and first-dealer controls only
  from exact server capabilities. Confirm removal but not ordinary seat/dealer changes.
- [ ] Group copy link, copy code, and SVG QR actions. Generate the share URL with `/?room=CODE`,
  announce copy results accessibly, and keep room code prominent without exposing tokens.
- [ ] Preserve pending-control identity, readiness clearing from authoritative updates, seat
  contention rejection, disconnect/rejoin, replacement flow, and automatic transition into play.
- [ ] Verify 4/6/8-seat lobbies, long names, every host/player role, phone/landscape/desktop/TV,
  keyboard/screen reader, and connection loss.
- [ ] Run typecheck, lint, build, and `git diff --check`; require success. Update plan/progress and
  commit `feat(web): add lobby experience`.

---

### [ ] U014: Build AuctionControls

**Suggested implementer:** Claude Fable or GPT `gpt-6-astra`, high effort

**Files:**
- Create: `apps/web/src/components/AuctionControls.tsx`
- Modify: `apps/web/src/components/ActionDock.tsx`
- Modify: `locales/en.json`

**Depends on:** U010–U013 and engine/room allowed-action types.

**Interfaces produced:**

```ts
export interface AuctionControlsProps {
  allowed: readonly AllowedEngineAction[];
  calls: readonly PublicAuctionCall[];
  pendingCommandId: string | null;
  onAction(action: ClientEngineAction): void;
}
```

- [ ] Build the server-range-driven number stepper, allowed suit/no-trump choices, visible
  number-first/suit-first style order, Pass, and Double. Never calculate bid ranges or
  affordability in the browser.
- [ ] Put full auction history one action away in an accessible sheet/popover. Show calls and
  styles in order without hiding partner overbids or carried 28 auction context.
- [ ] Show Redouble as a prominent out-of-turn floating control whenever supplied, clear of hand/
  round, and submit immediately without confirmation. Lock only the submitted control.
- [ ] Verify 56 and both 28 auction stages, forced/carried/doubled/redoubled states, min/max range,
  missing actions, rejection/unlock, phone/desktop, keyboard, zoom, and reduced motion.
- [ ] Run typecheck, lint, build, and `git diff --check`; require success. Update plan/progress and
  commit `feat(web): add auction controls`.

---

### [ ] U015: Implement card placement, reveal, and play interaction

**Suggested implementer:** Claude Fable or GPT `gpt-6-astra`, high effort

**Files:**
- Modify: `apps/web/src/screens/Game.tsx`
- Modify: `apps/web/src/components/Hand.tsx`
- Modify: `apps/web/src/components/ActionDock.tsx`
- Modify: `locales/en.json`

**Depends on:** U009–U014.

**Interfaces produced:**

```ts
export interface GameProps {view: RoomView; pending: Readonly<Record<string, RoomCommand>>; send(command: RoomCommand): string;}
```

- [ ] Compose shell, status, table, hand, and dock from displayed server view. Switch lobby/game/
  summary presentations only by authoritative phase.
- [ ] For 28 placement, isolate eligible cards and submit `placeCard`; render the bidder's own
  face-down card face-up beside the hand and every other viewer's marker face-down.
- [ ] For play, feed exact allowed cards to Hand, show translated required-suit guidance supplied
  or safely formatted from public view, and expose Reveal only when listed. Do not add an Auto-stop
  warning/confirmation.
- [ ] Add optional pointer drag with a clear table threshold while keeping tap/click/keyboard as
  complete paths. A drag below threshold returns the card without submission.
- [ ] Verify Block/Auto-stop capabilities, duplicate cards, hidden/revealed/no trump, forced
  face-down play, ask-reveal turn, pending/rejected commands, stale displayed/latest views, and
  phone/desktop keyboard/touch behavior.
- [ ] Run typecheck, lint, build, import/string scans, and `git diff --check`; require success.
  Update plan/progress and commit `feat(web): add card play interactions`.

---

### [ ] U016: Implement stall and surrender overlays

**Suggested implementer:** Claude Opus or GPT `gpt-5.6-sol`, high effort

**Files:**
- Modify: `apps/web/src/components/GameOverlay.tsx`
- Modify: `apps/web/src/components/ActionDock.tsx`
- Modify: `apps/web/src/screens/Game.tsx`
- Modify: `locales/en.json`

**Depends on:** U011 and U015.

**Interfaces produced:** No new public interface; consumes room stall/vote views and allowed
commands.

- [ ] Preserve the visible table under a stall overlay naming missing player(s). Distinguish a
  local reconnect banner from an authoritative room stall and expose only allowed replacement/
  host actions.
- [ ] Show result certainty only to recipients whose redacted view contains it. Offer Surrender
  outside turn only from capabilities and immediately transition to the authoritative vote state.
- [ ] Show proposer, eligible losing team, yes/no votes, votes remaining, and pass/fail condition;
  pause play controls while allowing each eligible unvoted member one server-listed vote.
- [ ] Verify multiple missing seats, returning identity, replacement Ready, host removal/end-match,
  surrender unavailable/available/pass/fail, same-round lockout, disconnecting voter, and no
  hidden result leak to winners/Table.
- [ ] Run typecheck, lint, build, and `git diff --check`; require success. Update plan/progress and
  commit `feat(web): add stall and surrender overlays`.

---

### [ ] U017: Implement menus, history, reactions, and host controls

**Suggested implementer:** Claude Opus or GPT `gpt-5.6-sol`, high effort

**Files:**
- Modify: `apps/web/src/screens/Game.tsx`
- Modify: `apps/web/src/components/primitives/Menu.tsx`
- Modify: `apps/web/src/components/primitives/Sheet.tsx`
- Modify: `locales/en.json`

**Depends on:** U011 and U015–U016.

**Interfaces produced:** No new public interface; renders exact room view history/capabilities.

- [ ] Add session log, permitted round history, live points when present, couch toggle, the seven
  localized stable reactions (`hello`, `nice`, `wellPlayed`, `wow`, `oops`, `oneMoment`,
  `thanks`), and permanent Leave to the player menu. Never reconstruct hidden history or accept
  free text; present `reaction_rate_limited` as localized non-destructive feedback.
- [ ] Render none/last/full history exactly as delivered. Use a dismissible phone sheet and an
  optional persistent wide sidebar without moving the core table.
- [ ] Expose host move/swap/remove/transfer, first dealer where applicable, End match restart, and
  End match award only from allowed host actions. Confirm permanent Leave/removal/end-match but
  preserve no-confirm ordinary gameplay.
- [ ] Verify each history/live-points setting, reaction preset, player/Table host scope, every
  phase, confirmation cancel/accept, focus return, pending/rejection, and wide sidebar behavior.
- [ ] Run typecheck, lint, build, and `git diff --check`; require success. Update plan/progress and
  commit `feat(web): add game menus and host controls`.

---

### [ ] U018: Build match and session summaries

**Suggested implementer:** Claude Fable or GPT `gpt-6-astra`, high effort

**Files:**
- Create: `apps/web/src/components/MatchSummary.tsx`
- Create: `apps/web/src/components/SessionSummary.tsx`
- Modify: `apps/web/src/screens/Game.tsx`
- Modify: `locales/en.json`

**Depends on:** U009–U011 and U015.

**Interfaces produced:**

```ts
export function MatchSummary(props: {view: RoomView; readyAllowed: boolean; onReady(): void}): React.JSX.Element;
export function SessionSummary(props: {view: RoomView; restartAllowed: boolean; onRestart(): void}): React.JSX.Element;
```

- [ ] Overlay match results on the familiar table with points, made/failed result, contract,
  multiplier, tokens moved/running, and explicit revoke/surrender/restart/host-award reason.
  Accept a nullable already-redacted contract, never reveal an unrevealed 28 trump, use a
  transient notice rather than a full summary for every automatic redeal, and show Ready only
  from capability. A later 28-redeal log entry may show its public first-auction facts.
- [ ] Give session victory a dedicated Newsreader-led screen with winner/team markers, final log,
  and host-only Restart session. Preserve non-host next actions and full keyboard access.
- [ ] Use restrained match emphasis and reserve richer celebration styling for session end; state
  remains fully understandable without animation or color.
- [ ] Verify every outcome and both winners, capped token payment, host/non-host/Table, phone/TV,
  long history, focus after transition, 200% zoom, and reduced motion.
- [ ] Run typecheck, lint, build, and `git diff --check`; require success. Update plan/progress and
  commit `feat(web): add result summaries`.

---

### [ ] U019: Add Couch mode

**Suggested implementer:** Claude Fable or GPT `gpt-6-astra`, high effort

**Files:**
- Create: `apps/web/src/screens/Couch.tsx`
- Create: `apps/web/src/store/ui-store.ts`
- Modify: `apps/web/src/screens/Game.tsx`
- Modify: `locales/en.json`

**Depends on:** U006–U007, U010–U018.

**Interfaces produced:**

```ts
export interface UiStoreState {couchMode: boolean; setCouchMode(enabled: boolean): void;}
```

- [ ] Make Couch mode local presentation state that reuses the same authoritative view, Hand,
  ActionDock, commands, and status. Remove the social table and enlarge hand/actions into one or
  two rows without changing room state.
- [ ] Add a written turn status and non-color-only viewport glow when acting; keep public contract,
  trump, and tokens in one line where space permits.
- [ ] Preserve mode across in-room navigation for the current browser but not as a server command;
  exit safely on access revocation or room change.
- [ ] Verify 1–16 cards, every action phase, portrait/landscape phones, keyboard, zoom, pending/
  rejection, turn glow, and reduced motion.
- [ ] Run typecheck, lint, build, and `git diff --check`; require success. Update plan/progress and
  commit `feat(web): add couch mode`.

---

### [ ] U020: Add the TV-oriented Table view

**Suggested implementer:** Claude Fable or GPT `gpt-6-astra`, high effort

**Files:**
- Create: `apps/web/src/screens/Table.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `locales/en.json`

**Depends on:** U007–U009, U011, U017–U018.

**Interfaces produced:**

```ts
export interface TableScreenProps {view: RoomView; send(command: RoomCommand): string;}
```

- [ ] Render `/table/:code` with the fixed public orientation, large distance-readable table,
  top status, auction/session side panel, no hand, and no player action dock.
- [ ] Before seats fill, prioritize room code and SVG QR. After match, present MatchSummary full
  screen. Show host controls in a distinct panel only when Table capabilities authorize them.
- [ ] Never render a hand, player-only action, losing-team certainty, or hidden trump/card from
  absent fields. Treat any such field as a protocol violation routed to Recovery.
- [ ] Verify locked/unlocked authorization, 4/6/8 seats, lobby/play/vote/match/session phases,
  laptop/TV/ultrawide, viewing distance, keyboard remote-like navigation, and redaction.
- [ ] Run typecheck, lint, build, and `git diff --check`; require success. Update plan/progress and
  commit `feat(web): add Table view`.

---

### [ ] U021: Implement the authoritative animation queue

**Suggested implementer:** Claude Opus or GPT `gpt-5.6-sol`, high effort

**Files:**
- Create: `apps/web/src/animation/types.ts`
- Create: `apps/web/src/animation/frames.ts`
- Create: `apps/web/src/animation/queue.ts`
- Create: `apps/web/src/animation/index.ts`
- Modify: `apps/web/src/store/room-store.ts`
- Modify: `apps/web/src/store/ui-store.ts`

**Depends on:** U005, U019, and completed rooms browser store/event callback.

**Interfaces produced:**

```ts
export interface AnimationUpdate {events: readonly RoomEvent[]; resultingView: RoomView;}
export interface AnimationStepContext {displayedView: RoomView | null; event: RoomEvent; eventId: string; resultingView: RoomView;}
export type AnimationStep = (context: AnimationStepContext) => Promise<RoomView | null>;
export interface AnimationQueue {
  enqueue(update: AnimationUpdate): void;
  synchronize(view: RoomView): void;
  setDocumentHidden(hidden: boolean): void;
  subscribe(listener: (view: RoomView | null) => void): () => void;
  close(): void;
}
```

- [ ] Keep latest authoritative and displayed views separate. Queue each update's ordered
  redacted events, derive presentation-only intermediate frames without deciding legality, await
  one registered step at a time, and end exactly at `resultingView`.
- [ ] Give each step the deterministic presentation ID `<revision>:<eventIndex>` derived from the
  resulting room revision and zero-based event position. Use it for transient/layout identity
  without treating it as protocol authority.
- [ ] On hello/reconnect synchronize directly without replay. Catch up to newest view when the
  document is hidden, reduced motion requests instant transitions, or backlog exceeds 24 events;
  cancel stale step controllers without mutating network state.
- [ ] Make queue lifecycle, scheduling, visibility, and step registry injectable. Survive step
  rejection by recording a safe client diagnostic and synchronizing to the authoritative view.
- [ ] Feed room store updates into the queue and render all game screens from displayed view while
  pending commands/status remain authoritative.
- [ ] Add and run focused automated tests for ordering, concurrent enqueue, catch-up triggers,
  reconnect, hidden tab, reduced motion, failed/cancelled steps, close, and final view equality.
- [ ] Run typecheck, lint, build, and `git diff --check`; require success. Update plan/progress and
  commit `feat(web): add animation queue`.

---

### [ ] U022: Animate dealing

**Suggested implementer:** Claude Fable or GPT `gpt-6-astra`, high effort

**Files:**
- Create: `apps/web/src/animation/steps/deal.ts`
- Modify: `apps/web/src/animation/index.ts`
- Modify: `apps/web/src/components/TableSurface.tsx`

**Depends on:** U004, U008–U010, and U021.

**Interfaces produced:**

```ts
export const animateDeal: AnimationStep;
```

- [ ] Animate cards from the dealer/deck origin to seats one at a time in event order, using
  recipient-redacted card faces/counts and stable Motion layout IDs. Never fabricate another
  hand's faces.
- [ ] Use a coherent duration/spring family, maintain readable status throughout, allow queue
  cancellation/catch-up, and finish at the authoritative dealt view.
- [ ] Under reduced motion or hidden/catch-up mode, make the same state transition instantly with
  no delayed timers or missing announcement.
- [ ] Verify 56 48/64-card deals at 4/6/8 seats, 28 first/second deal, redeal interruption,
  player/Table recipients, narrow phone, TV, slow/fast device, and cancellation.
- [ ] Run typecheck, lint, build, and `git diff --check`; require success. Update plan/progress and
  commit `feat(web): animate dealing`.

---

### [ ] U023: Animate card play, round collection, and trump movement

**Suggested implementer:** Claude Fable or GPT `gpt-6-astra`, high effort

**Files:**
- Create: `apps/web/src/animation/steps/card-play.ts`
- Create: `apps/web/src/animation/steps/round-win.ts`
- Create: `apps/web/src/animation/steps/trump.ts`
- Modify: `apps/web/src/animation/index.ts`
- Modify: `apps/web/src/components/Card.tsx`
- Modify: `apps/web/src/components/TableSurface.tsx`

**Depends on:** U004, U009–U010, U015, and U021.

**Interfaces produced:**

```ts
export const animateCardPlay: AnimationStep;
export const animateRoundWin: AnimationStep;
export const animateTrump: AnimationStep;
```

- [ ] Move a played card from hand/seat to current round with shared layout ID, emphasize the
  winning card, collect the ordered round, and slide the pile toward the winner before the next
  leader state.
- [ ] Animate 28 placement from bidder hand to face-down spot and reveal/return with a spatial
  transfer plus CSS 3D flip. Respect recipient redaction before, during, and after reveal.
- [ ] Keep selection press/lift springs responsive but informationally redundant. Queue all
  server-event movement; a local below-threshold drag return remains local and submits nothing.
- [ ] Verify duplicate-card IDs, reveal after earlier round plays, forced face-down play,
  disqualification before round completion, reconnect/catch-up, every viewport, and reduced
  motion final equality.
- [ ] Run typecheck, lint, build, and `git diff --check`; require success. Update plan/progress and
  commit `feat(web): animate card lifecycle`.

---

### [ ] U024: Animate calls, reactions, and results

**Suggested implementer:** Claude Opus or GPT `gpt-5.6-sol`, high effort

**Files:**
- Create: `apps/web/src/animation/steps/transient.ts`
- Create: `apps/web/src/animation/steps/results.ts`
- Modify: `apps/web/src/animation/index.ts`
- Modify: `apps/web/src/components/Seat.tsx`
- Modify: `apps/web/src/components/MatchSummary.tsx`
- Modify: `apps/web/src/components/SessionSummary.tsx`

**Depends on:** U008, U018, and U021.

**Interfaces produced:**

```ts
export const animateTransient: AnimationStep;
export const animateResult: AnimationStep;
```

- [ ] Pop bid/reaction bubbles at their seat anchors without covering names/cards; keep auction
  history and reaction meaning available without motion.
- [ ] Add restrained match-result emphasis and a richer but calm session celebration using the
  approved palette, team shapes, and Newsreader. Avoid full-screen team-color washes.
- [ ] Integrate every supported event into the registry with an explicit instant fallback. Unknown
  future events synchronize safely rather than stalling the queue.
- [ ] Verify rapid calls/reactions, result variants, vote/revoke/redeal/restart outcomes, hidden
  tab, backlog catch-up, focus preservation, screen-reader silence for decoration, and reduced
  motion.
- [ ] Run typecheck, lint, build, and `git diff --check`; require success. Update plan/progress and
  commit `feat(web): animate transient and result events`.

---

### [ ] U025: Implement recovery screens and client error boundaries

**Suggested implementer:** Claude Sonnet or GPT `gpt-5.6-terra`, high effort

**Files:**
- Create: `apps/web/src/screens/Recovery.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/store/room-store.ts`
- Modify: `apps/web/src/components/primitives/Toast.tsx`
- Modify: `locales/en.json`

**Depends on:** U011–U012 and U021.

**Interfaces produced:**

```ts
export type RecoveryReason = "roomExpired" | "removed" | "signedInElsewhere" | "invalidRejoin" | "tableUnauthorized" | "unexpected";
```

- [ ] Map expected command rejections to localized inline/toast feedback while retaining current
  display and unlocking only the originating control. Never render raw server details.
- [ ] Give expiry, removal, takeover, invalid rejoin, and Table authorization failure dedicated
  screens containing only valid next actions and clearing tokens exactly when protocol requires.
- [ ] Add a recoverable React error boundary that can reconnect/request a full view and never
  prints state, stack, token, hidden card, or raw payload to the page.
- [ ] Preserve the last safe display beneath a local reconnect banner and synchronize animation
  queue on recovery; do not imply authoritative room stall without the room view.
- [ ] Verify every reason, browser reload/back, repeated reconnect, offline/online, keyboard/focus,
  live announcements, long copy, and absence of secrets/private cards.
- [ ] Run typecheck, lint, build, string/leak scans, and `git diff --check`; require success. Update
  plan/progress and commit `feat(web): add recovery experiences`.

---

### [ ] U026: Implement the protected in-memory debug service and protocol

**Suggested implementer:** Claude Opus or GPT `gpt-5.6-sol`, high effort

**Files:**
- Create: `packages/protocol/src/debug/http.ts`
- Create: `packages/protocol/src/debug/messages.ts`
- Create: `packages/protocol/src/debug/index.ts`
- Modify: `packages/protocol/src/index.ts`
- Create: `apps/server/src/debug/types.ts`
- Create: `apps/server/src/debug/credentials.ts`
- Create: `apps/server/src/debug/seeded-random.ts`
- Create: `apps/server/src/debug/debug-service.ts`
- Create: `apps/server/src/routes/debug.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/main.ts`

**Depends on:** Completed engine/rooms plus skeleton config/runtime boundaries.

**Interfaces produced:**

```ts
// POST /api/debug/login {password} -> {token}
// POST /api/debug/session Authorization: Bearer <token> {config, seed?} -> DebugSnapshot
// POST /api/debug/action Authorization: Bearer <token> {source, action} -> DebugSnapshot
// POST /api/debug/restart Authorization: Bearer <token> -> DebugSnapshot
export interface DebugSnapshot {
  fullState: EngineState;
  seatViews: readonly {seat: number; view: EngineView}[];
  tableView: EngineView;
  activeSeat: number | null;
  events: readonly EngineEvent[];
  seed: string;
}
export type DebugSource = {type: "seat"; seat: number} | {type: "host"};
```

- [ ] Define Zod schemas for every debug request/response. Keep password/token out of URLs and
  responses beyond the login token; accept engine actions without trusting a client-claimed
  authenticated room seat because this isolated debug scope intentionally chooses an acting seat.
  Reject JSON bodies above 65,536 UTF-8 bytes before parsing. Define stable safe failures for
  incorrect password, source lockout, invalid/expired token, invalid action, and oversized body.
- [ ] When `DEBUG_PASSWORD_FILE` is unset, register no debug API and let `/debug` reveal no debug
  content: modify the production SPA fallback so `/debug` returns a normal 404. When set, read
  once at startup, serve the debug SPA route, compare passwords safely, issue in-memory tokens from the
  injected production `RandomSource`, and never log credentials. Track failures per untrusted
  peer address without honoring forwarded-address headers: five failures lock that source for
  60,000 ms. Expire a debug token after eight hours without accepted debug activity.
- [ ] Set `Cache-Control: no-store` on every debug authentication and session/action response,
  including failures. Keep debug tokens out of persistent browser storage and caches.
- [ ] Maintain one in-memory engine session per debug token. Use a deterministic seeded random
  adapter only to shuffle/choose setup; pass resulting deck/dealer into the real engine. Never
  load, view, mutate, or persist a real room.
- [ ] Create/restart from the same seed, expose exact per-seat views plus authenticated full state,
  append a live event log, and choose the next active seat from engine allowed actions after each
  accepted change. Support explicit out-of-turn acting for Redouble and host controls while
  keeping system-only actions behind the create/restart endpoints.
- [ ] Add and run deterministic automated tests for disabled mode, login success/failure, token
  isolation, source lockout and expiry with an injected clock, same-seed replay, every seat view,
  show-all source data, invalid action, restart, and real-room storage non-use.
- [ ] Run typecheck, lint, build, security/log/import scans, and `git diff --check`; require
  success. Update plan/progress and commit `feat(debug): add isolated engine service`.

---

### [ ] U027: Build the Debug screen

**Suggested implementer:** Claude Sonnet or GPT `gpt-5.6-terra`, high effort

**Files:**
- Create: `apps/web/src/net/debug-client.ts`
- Create: `apps/web/src/store/debug-store.ts`
- Create: `apps/web/src/screens/Debug.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `locales/en.json`

**Depends on:** U012–U026.

**Interfaces produced:**

```ts
export interface DebugClient {login(password: string): Promise<void>; create(config: EngineConfig, seed: string | null): Promise<DebugSnapshot>; act(source: DebugSource, action: ClientEngineAction): Promise<DebugSnapshot>; restartMatch(): Promise<DebugSnapshot>;}
```

- [ ] Confirm disabled production `/debug` is a normal server 404. When enabled, show only the
  password login before authorization, then the production create form plus optional deal seed.
  Keep the debug token in memory only.
- [ ] Reuse production Game/Table/Card/Hand/ActionDock/Summary components. Add an unmistakable
  debug bar outside the game surface with Act as controls, viewer switcher, Show all hands toggle,
  live event log, and same-seed restart.
- [ ] After every accepted action, switch to the next seat required to act while preserving manual
  view selection until an action is submitted. Allow out-of-turn Redouble through Act as and keep
  full-state visibility confined to the authenticated debug screen.
- [ ] Verify password disabled/enabled/failure, seed reproducibility, all seats, hidden trump with/
  without Show all, event order, restart, host controls, phone/desktop, keyboard, and zero access
  to real rooms.
- [ ] Run typecheck, lint, build, leak/import scans, and `git diff --check`; require success. Update
  plan/progress and commit `feat(web): add debug experience`.

---

### [ ] U028: Verify the complete UI and hand off v1

**Suggested implementer:** Claude Opus or GPT `gpt-5.6-sol`, high effort

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/ui-visual-implementation-plan.md`
- Modify: `docs/implementation-progress.md`

**Depends on:** U001–U027 complete.

**Interfaces produced:** No new runtime interface. This unit produces the verified v1 UI and
durable completion handoff.

```text
Required matrix:
small/large phones portrait+landscape; tablet portrait+landscape; laptop; desktop; TV Table;
4/6/8-seat 56 and 4-seat 28; 1–16-card hands; long names/text expansion; every room/game phase;
Block/Auto-stop; hidden/revealed/no trump; stall/rejoin/replacement; host and Table controls;
all results; couch; debug; keyboard; screen reader; focus; contrast; 200% zoom; reduced motion;
offline/reconnect/revocation; simultaneous player/Table tabs; reaction throttling; animation
order/catch-up; asset usage/provenance and secret/card leakage.
```

- [ ] Run `nix develop -c pnpm typecheck`, `nix develop -c pnpm lint`, and
  `nix develop -c pnpm build`; require exit 0. Run `nix build` and `nix flake check`; require exit
  0 and confirm the production package contains fonts/assets/prompts.
- [ ] Exercise the complete matrix with real room flows and `/debug`. Record viewport sizes,
  browser/assistive technology, reduced-motion mode, representative screenshots, and concise
  pass/failure evidence in the ledger.
- [ ] Verify every command originates from a server capability, only its initiating control locks,
  displayed view converges to latest authoritative view, reconnect skips replay, and no animation
  delays server state.
- [ ] Audit all player/Table/debug views, DOM, browser storage, URLs, errors, and logs with known
  secret/card markers. Require no token, password, other hand, undealt card, or hidden trump leak.
- [ ] Audit all images against recorded Gemini prompts and repository history; require no stock,
  alternate generator, missing prompt, temporary image, or untracked derivative.
- [ ] Run keyboard-only and screen-reader passes, contrast checks, focus-order/return checks, 200%
  zoom, long-string expansion, and reduced-motion passes for every screen family.
- [ ] Update `AGENTS.md` with the actual web/debug layout and verification commands, mark this plan
  and UI track complete, and record the next explicitly user-approved work rather than beginning
  an out-of-v1 feature.
- [ ] Run `git status --short` and `git diff --check`, review every final documentation change,
  and commit `docs: complete v1 interface`. Stop and ask the user before any further work.
