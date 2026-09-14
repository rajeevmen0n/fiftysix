# UI and visual design

Design for the player-facing experience of the 56 web app. It builds on [rules.md](../rules.md),
[design.md](../design.md), the [game engine design](game-engine-design.md), the
[rooms subsystem design](rooms-subsystem-design.md), and the
[tech stack design](tech-stack-design.md). Those documents remain authoritative for game rules,
room behaviour, visibility, protocol boundaries, and technology choices.

## 1. Goals and boundaries

- Make a game with dense state understandable on phones without losing the feeling of sitting
  around a shared table.
- Give 56 and 28 a polished identity rooted in a warm card-night atmosphere without decorative
  clichés.
- Keep game state server-authoritative. The web app presents views and allowed actions; it never
  recreates game rules.
- Support every size from a small portrait phone to a TV, with phones as the primary device.
- Make motion rich but informationally redundant, ordered through the animation queue, and fully
  removable when the user prefers reduced motion.
- Cover the home, create, lobby, game, results, couch, Table, and debug experiences in v1.

This spec does not change any game or room rule. It does not add anything listed as out of scope
in design.md §15.

## 2. Visual foundation

### 2.1 Direction

The visual direction is a contemporary broadcast table softened with the warmth of a Kerala
card night. The structure is crisp, calm, and information-dense. Warm ivory cards and restrained
brass details prevent it from feeling clinical. Heavy wood framing, ornamental pastiche, and
full-screen team-colour washes are not used.

The app is dark by design in v1, but this is not a user-selectable dark-mode feature. A future
theme can replace tokens without changing component structure.

### 2.2 Colour roles

| Token | Reference value | Role |
|---|---:|---|
| Midnight | `#081011` | Page background |
| Ink | `#111D1D` | Main surfaces and table surround |
| Raised ink | `#172625` | Panels, controls, and overlays |
| Ivory | `#FFF5DC` | Cards and primary text |
| Dim ivory | `#D8CCB1` | Secondary text |
| Emerald | `#0D6956` | Team A |
| Coral | `#A83E3B` | Team B |
| Brass | `#C8A45B` | Dealer, contract, focus, actionable, and ceremonial accents |

The implementation may adjust these values slightly to meet contrast requirements, but their
roles and relative character stay fixed. Emerald and coral identify teams; neither colour is
also used as the sole success/error signal.

### 2.3 Typography

- **Inter** is the gameplay and interface family. It carries names, controls, status, logs, and
  compact numeric information.
- **Newsreader** is the display family. It is reserved for the `56` identity, match and session
  results, and short celebratory headings.
- Scores, bids, and token balances use tabular numerals.
- Both families are bundled through Fontsource. System sans and Georgia are fallbacks, not the
  intended presentation.

### 2.4 Shape and depth

- Broadcast-style information tiles use soft corners, thin low-contrast borders, and shallow
  elevation.
- Cards remain the brightest objects on the screen.
- Brass appears on the dealer marker, important contract detail, keyboard focus, and celebration
  accents. It is not a general border colour.
- Team A uses a continuous wave marker; Team B uses a radiating sun marker. These markers appear
  with team labels and seat rings so team identity does not depend on colour.

### 2.5 Card and image art

- Card fronts are warm ivory with large conventional corner ranks and suit marks. They favour
  legibility over novelty and remain crisp as SVG React components.
- J, Q, and K use original, simplified geometric court portraits. Their artwork uses the same
  ink, ivory, coral, emerald, and brass palette and must remain recognisable at small sizes.
- Card backs use an ink field with a restrained brass-and-emerald interlocking wave motif. They
  contain no words or directional top edge.
- Background texture is extremely subtle and must not reduce card or text contrast.
- Court portraits, card-back art, logo/app icons, and any raster texture are generated with the
  Gemini MCP under the asset and prompt-recording rules in AGENTS.md. No stock or placeholder
  image enters production.

## 3. Responsive layout system

### 3.1 Stable gameplay shell

The game page has four persistent regions:

1. compact status strip
2. table surface
3. contextual action dock
4. player hand

Phone portrait is **table first**. The table is the largest region and does not resize when the
action dock changes state. Actions never push seats, the current round, or the hand to a new
position during a turn.

The shell uses grid or flex fractions, `dvh`, `clamp()`, container queries, and calculated CSS
variables. It does not encode a fixed device canvas. Safe-area insets are included around the
status strip and hand.

### 3.2 Phone portrait

- The status strip shows both token balances and the current contract in one compact row.
- The table shows every seat, the current round, and public transient bubbles.
- The action dock stays slim when no decision is required and expands within its reserved region
  for the active player.
- The fanned hand occupies the bottom edge. Card width and overlap are calculated from the
  available inline size and card count, up to sixteen cards.
- Menus, history, and detailed auction history open as dismissible sheets rather than displacing
  the table.

### 3.3 Landscape, tablet, and desktop

The table remains central. Status and secondary information move to one side rail; the contextual
action dock moves to the other. The hand stays along the bottom. A wide viewport may keep the
session log open as an additional sidebar, as required by design.md §12.4.

Changing orientation preserves the same visual hierarchy and viewer-relative seat order. It does
not merely rotate or proportionally enlarge the portrait canvas.

### 3.4 TV Table view

Table view uses the landscape grammar with larger public information, simplified chrome, and a
distance-readable side panel. It has no hand or player action dock. Before all seats are filled,
the room code and QR code take visual priority. Unlocked host controls live in a distinct panel
and never resemble player actions.

### 3.5 Couch mode

Couch mode deliberately removes the social table. It keeps the status line, contextual action
dock, and hand, enlarging the last two. A turn glow around the viewport supplements the written
turn label. Toggling couch mode is local presentation state and does not affect the room view.

## 4. Component boundaries

Shared visual components are organised around app concepts:

| Component | Responsibility |
|---|---|
| `StatusStrip` | Tokens, contract, public trump, multiplier, and round context |
| `TableSurface` | Viewer-relative seat layout and current-round centre |
| `Seat` | Name, team marker, card count, dealer, turn, connection, and bubbles |
| `Card` | Front, back, selected, disabled, face-down, and motion states |
| `Hand` | Calculated fan/row layout and card selection interaction |
| `ActionDock` | Phase-specific player controls in one stable region |
| `AuctionControls` | Bid construction, pass, double, and auction-history access |
| `GameOverlay` | Stall, surrender vote, and other temporary paused states |
| `MatchSummary` | Finished-match result and Ready gate |
| `SessionSummary` | Winner, final log, and host restart action |

Components receive already-redacted display data and callbacks. They do not import engine code or
decide whether an action is legal. Card sizing, seat positions, control selection, and view-model
formatting are plain functions under `apps/web/src/logic/`.

## 5. Contextual action dock

The dock is the single predictable location for in-turn decisions:

| Phase or state | Dock content |
|---|---|
| Waiting for others | Short description of who or what is pending |
| Auction turn | Bid builder, Pass, and Double when allowed |
| 28 card placement | Eligible hand cards plus a clear placement instruction |
| Play turn | Required-suit guidance and Reveal trump when offered |
| Surrender available | Surrender proposal alongside normal play controls |
| Surrender vote | Yes/No controls for eligible voters; progress for everyone |
| Match over | Summary acknowledgement and Ready control |
| Session over | No play controls; host restart appears in the session summary |

The 56 bid builder preserves number-first versus suit-first order visibly. Full auction history is
one action away. Redouble is a prominent floating control above the dock because it can be used
out of turn; it never covers the hand or current round.

In Block mode, illegal cards are dimmed and cannot be lifted. In Auto-stop mode, every permitted
submission from `allowedActions` remains interactive; if it produces a disqualification, the
normal event sequence freezes play and explains the result. The UI does not add an extra warning
or confirmation that would change the selected room mode.

## 6. Input behaviour

- A card is selected with one tap or click and played with a second activation of that same card.
- Selecting another card transfers the lifted state. Clicking outside the hand clears it.
- Keyboard users can move through the hand in its logical sorted order, select a card, and
  confirm play without following the visual overlap order.
- Drag may supplement tap-to-play on pointer devices, but tap/click and keyboard paths remain the
  complete interaction. A drag only submits after crossing an unambiguous table threshold.
- While a command awaits a server response, only the initiating card or control is locked. The
  rest of the displayed table does not optimistically change.
- Destructive host actions and permanent Leave room use explicit confirmation dialogs. Ordinary
  bids, passes, doubles, redoubles, card plays, and Ready do not.

## 7. Authoritative data and animation flow

1. The WebSocket client receives redacted events and the resulting latest view.
2. The Zustand store records connection state and the latest authoritative view.
3. The animation queue advances a separate displayed view one event at a time.
4. Screens and components render the displayed view and the server-provided allowed actions.
5. When the queue completes, the displayed view equals the latest authoritative view.

The UI never derives hidden information or reimplements legality. A rejected command unlocks its
control and shows a translated explanation. A reconnect, hidden-tab return, or excessive backlog
skips animation and replaces the displayed view with the newest full view.

## 8. Motion language

Motion explains where game objects went and whose turn follows:

- deal: cards travel from the dealer position to seats in deal order
- select and play: a spring lift, then movement from the hand to the current round
- round won: winning card emphasis, collection, then movement toward the winner
- 28 placement and reveal: spatial transfer plus a card flip
- calls and reactions: short pop-in bubbles anchored to their seats
- match and session results: restrained match emphasis and a richer session celebration

Animations run only through the event queue and never delay server state. Repeated events use a
consistent duration family so pacing feels coherent. If reduced motion is requested, transitions
are instant; final position, written labels, focus, and state changes still convey everything.

## 9. Screen families and flow

### 9.1 Entry

The home screen presents Create a table, Join a game, and Join as Table view as three clear
paths. A room link pre-fills both join paths. Forms keep labels visible, explain errors beside the
relevant field, and preserve valid entries after rejection.

Successful player creation/joining navigates to `/room/:code`; successful Table authorization
navigates to `/table/:code`.

Create starts with the required basic settings. Advanced settings are collapsed and summarise any
non-default choices when closed. Choices that are impossible for the selected game/player count
are removed or disabled with an explanation.

### 9.2 Lobby

The waiting room uses the same table component as gameplay. Empty seats are obvious targets;
occupied seats show team markers, presence, host, dealer, and Ready state. Share link, room code,
and QR actions form one share group. Host move/swap/remove and first-dealer controls are visually
separate from each player's Sit, Unseat, and Ready actions.

### 9.3 Play and results

Play uses the stable shell in §3 and dock in §5. A match summary overlays the familiar table so
players retain context, then exposes Ready. A session win gets a dedicated screen with the final
session log and the host's Restart session action.

### 9.4 Debug

`/debug` reuses production game components. Its debug bar is visually unmistakable and remains
outside the game surface. Acting as a seat, switching the viewed seat, showing all hands, viewing
events, and restarting from the same seed never leak into production room components.

## 10. Overlays, errors, and recovery

- A temporary disconnect retains the last safe display under a waiting overlay naming the player
  or connection being awaited.
- A local reconnect banner does not imply that the room itself is paused until the authoritative
  view says so.
- Surrender voting preserves the visible table, disables play, and shows proposer, eligible team,
  votes cast, and the current result condition.
- Expected command rejections use localized inline feedback or toasts without discarding the
  current screen.
- Expired rooms, removed identities, sign-in takeover, invalid rejoin credentials, and Table-view
  authorization failures have dedicated recovery screens with only valid next actions.
- Unexpected client errors show a recoverable error boundary that can reconnect and request a new
  full view. It never displays hidden state or raw server details.

## 11. Accessibility and language

- Every control has a visible label or accessible name. Card names include rank and suit rather
  than relying on glyph pronunciation.
- Team, dealer, turn, selected, legal, disabled, disconnected, and face-down states all have
  non-colour cues.
- Focus remains visible in brass on dark surfaces and ink on ivory surfaces.
- Radix primitives provide dialog, menu, popover, and toast focus behaviour; custom styling does
  not remove their semantics.
- Live announcements are reserved for actionable changes such as the player's turn, a pause, a
  rejected action, or a vote request. Decorative animation is silent.
- Overlapping cards retain logical DOM order and usable focus targets.
- All visible strings, accessible labels, and error explanations come from i18next. English is
  the only shipped locale in v1, but layout allows reasonable text expansion.

## 12. Verification matrix

No test framework is added as part of this design. Implementation units verify their own scope
and preserve pure seams for later automated tests.

Manual responsive checks cover:

- small and large phones in portrait and landscape
- tablet portrait and landscape
- laptop and desktop
- TV-sized Table view
- 4-, 6-, and 8-seat 56 tables and the 4-seat 28 table
- smallest and largest hands, including sixteen cards
- long valid player names and translated-text expansion
- every auction, placement, play, pause, summary, and session state
- reconnection, removal, replacement, and host-control states
- keyboard-only operation, visible focus, screen-reader labels, contrast, and reduced motion

Pure functions for seat position, viewer-relative ordering, card sizing, control selection, and
event-to-animation routing are kept independently testable. Component stories or a test framework
may be introduced only in a later user-approved implementation unit.

## 13. Implementation decomposition

The UI is too broad for one safe implementation unit. Its later implementation plan should split
work in this order:

1. theme tokens, fonts, generated art, card primitives, and responsive layout utilities
2. shared table, seat, status, hand, and action-dock components
3. home, create, join, and lobby screens
4. auction, 28 placement/reveal, play, surrender, and host-control interactions
5. match/session summaries, couch mode, and Table view
6. event animation steps and queue integration
7. debug screen and the complete responsive/accessibility verification pass

Each unit must remain self-contained and follow the implementation-unit workflow in AGENTS.md.
