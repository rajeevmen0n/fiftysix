# App design decisions

This file covers decisions specific to the app, built on top of the game rules in
[rules.md](rules.md). Section references like "rules §4" point to that file. If a situation
isn't covered here, ask. Don't make up a behaviour.

## 1. Terminology

| Term | Meaning |
|---|---|
| **Game** | The app itself. It isn't used as a unit of play. |
| **Room** | A table session. Players join a room, and its settings are fixed when it's created. |
| **Session** | The matches played in a room until one team runs out of tokens |
| **Match** | One deal: cards dealt, auction, all rounds played, tokens transferred |
| **Round** | One trick |
| **Hand** | The cards a player holds |
| **Host** | The player with room controls. Starts as the room's creator (§10). |
| **Table view** | A non-player screen, such as a TV, that shows only public information (§13) |
| **Couch mode** | A per-player phone layout showing only the hand and controls (§12) |

## 2. Room settings

The host sets these when creating the room. **Basic** settings are always shown on the create
form. **Advanced** settings sit in a collapsed section and all have defaults.

| Setting | Options | Default | Section |
|---|---|---|---|
| Game type | 56, 28 | none | Basic |
| Player count | 56: 4, 6, 8. 28: 4. | none | Basic |
| Include 8s and 7s (56) | Yes / No. Only offered when cards divide evenly (rules §3). | none | Basic |
| Illegal-play mode | **Block** or **Auto-stop** (§4) | none | Basic |
| Starting tokens per team | Any positive number | 10 | Advanced |
| Stake tiers | Bid thresholds and win/loss stakes for each tier | rules §7.1 | Advanced |
| Redeal point threshold | Points at or below which a hand is redealt | 56: 2, 28: 1 | Advanced |
| Surrender option | Off / On (§5) | Off | Advanced |
| Round history | None / Last round / Full (§7) | Last round | Advanced |
| Live points | Off / On (§7) | Off | Advanced |
| Host transfer wait | Seconds the host can be disconnected before the role moves (§10) | 60 | Advanced |

The create form also asks for the host's own name and optional PIN (§9).

## 3. Seating, dealer and sessions

- Teammates sit in alternate seats (rules §2).
- In the waiting room, players tap an empty seat to sit and can move freely. The host can move
  or swap anyone, and remove anyone.
- The session can start only when every seat is filled. There are no bots.
- Seats **lock when the first session starts and stay fixed for the room's whole life**. After
  that, a seat only changes hands through replacement (§10).
- The first dealer of a session is **picked at random**, and the **host can change** it.
  After that, the deal rotates as described in rules §2.
- **Between matches**, an end-of-match summary is shown and **every player must tap Ready**
  before the next deal. The host can't skip this. A player who never taps Ready is handled like
  a stall (§10).
- When a team reaches 0 tokens, the session is over. The app shows who won and the host gets
  **Restart session**, which resets both teams to the starting tokens and keeps the seats.

## 4. Illegal-play mode

- **Block**: cards that can't legally be played are disabled. This covers failing to follow
  suit, leading trump too early and, in 28, playing the face-down card before the reveal. A
  revoke can't happen in this mode.
- **Auto-stop**: players can play any card in their hand. The app detects an illegal play
  **immediately**, stops the match and applies the revoke penalty (rules §8).
- Players can't call out or flag an illegal play themselves. Only the app detects it.

## 5. Surrender option

A single room setting controls both telling the losing team they've already lost and letting
them surrender.

- **Off** (default): the app doesn't show that the result is decided, and every round is played.
- **On**: once the result is mathematically certain, meaning the bidding team has already made
  its bid or can't reach it with the points left, the app:
  - tells the **losing team** they've already lost the match, and
  - gives them a **Surrender** button. Surrendering ends the match and scores it normally.
    If they don't surrender, play continues.
- This happens even when live points (§7) are Off.

## 6. Auction UI

- Only calls the player is allowed to make are offered. Calls their team can't afford
  (rules §4.6) are hidden or disabled.
- **Double** is offered only on the player's own turn, when the other team holds the highest
  bid.
- **Redouble** is shown to every member of the doubled team whenever a double is active,
  whoever's turn it is. Using it ends the auction.
- 56 suit bids carry a **bid style** marker ("30 spades" or "spades 30", see rules §4.2) that
  every player can see.
- Everyone sees the full auction as it happens.

## 7. Visibility

- Each player sees only their own hand. Partners' hands aren't shown.
- In 56, everyone can see the trump suit (or no trump), the winning bid and any double or
  redouble.
- In 28, the face-down trump card is visible **only to the bidder** until it's revealed. Everyone
  else only knows that a card has been placed. After the reveal, everyone can see it.
- There's no in-game way to talk about cards. The only signals are bids and bid style.
  Players can send **preset reactions** (a fixed set of emoji and short phrases). None of them
  can describe cards, and there's no free-text chat.
- **Round history** setting, for rounds already collected in the current match:
  - **None**: collected rounds can't be viewed.
  - **Last round**: players can peek at the most recently finished round.
  - **Full**: every round of the current match can be viewed.
- **Live points** setting: when On, both teams' points in the current match are shown during
  play. When Off, points are shown only in the end-of-match summary.
- The **session log** (§11) is always available and only contains finished matches.
- A **Table view** sees exactly what a player sees publicly, with no hand, and follows the same
  round-history and live-points settings.

## 8. Automation

- Redeals (rules §9) are detected and carried out automatically, with a short notice of why.
- The app works out who won each round, the running points, and the token transfers.

## 9. Joining, identity and rejoining

- There are **no accounts**. Players join with a display name and an optional PIN.
- **Room code**: 6 characters from uppercase letters and digits, excluding look-alikes
  (0/O, 1/I). Every room gets a link like `/?room=K7MQ4P`, which opens the home page with the
  code filled in.
- **Names** must be unique within a room, ignoring case.
- **PIN**: optional, 4 digits, set when joining. It lasts as long as the room.
- **Rejoining**:
  - **Same browser**: a token stored in the browser puts the player straight back in their seat.
  - **Different browser or device**: the player must enter the **same name and PIN**.
    - If the player is still connected elsewhere, the new device **takes over** the seat and the
      old one is told it was signed in elsewhere.
    - After **5 wrong PINs**, PIN rejoin for that seat is locked for **1 minute**.
    - If the player **set no PIN**, rejoining from another browser is **blocked**. The only way
      back is for the host to remove that player so a new player can take the seat (§10).

## 10. Host, disconnects and replacement

- **Stalls**: when a player disconnects, the match **pauses** and everyone sees who the table is
  waiting for. There are no turn timers. When the player rejoins, play continues.
- During a stall the host can:
  - **Remove player**. The seat becomes open, and a new player who joins with the room code
    takes it, **inheriting the hand, team and position**.
  - **End match**. The match is **cancelled**: no tokens move, and the **same dealer redeals**,
    as with a redeal (rules §9).
- **Host transfer**: if the host is disconnected longer than the **host transfer wait** setting,
  host powers pass to the **next seated player counter-clockwise**. The old host doesn't get the
  role back on return. Whoever holds the role can hand it to any seated player at any time.

## 11. Room lifetime and session log

- Room state is stored on the server, so a server restart doesn't end a game.
- A room is deleted after **24 hours with no players connected**.
- The **session log** can be opened by anyone in the room. For each finished match it shows the
  dealer, winning bid and bid style, any double or redouble, points made by each team, tokens
  moved (with the reason: made, failed, revoke or surrender) and running tokens. It also lists
  the results of earlier sessions in the room. It's deleted with the room.

## 12. UI

### 12.1 Home page (`/`)
- Three options: **Create a table**, **Join a game** (room code, name, optional PIN) and
  **Join as Table view** (room code only).
- Opening `/?room=CODE` fills the code into both join forms.

### 12.2 Create a table
- Shows the basic settings (§2), plus name and optional PIN. An **Advanced options** section is
  collapsed by default.

### 12.3 Waiting room
- The table is drawn with seats in team colours. Tap an empty seat to sit.
- Share tools: copy link, copy code, and a QR code of the link.
- Host controls: move, swap or remove players, choose the first dealer, and **Start** (enabled
  once every seat is filled).

### 12.4 Game page
- **Status bar**: both teams' tokens, the winning bid with bid style, trump (when public), and
  double or redouble.
- **Table**: seats arranged relative to the viewer, who is always at the bottom. Each seat shows
  name, team colour, dealer marker, turn highlight, connection status, and bubbles for bids and
  reactions. The current round is in the centre. In 28, the face-down card sits beside the
  bidder's seat (face up for the bidder only).
- **Action area**, above the hand: auction panel, Reveal trump, Surrender, Ready.
  - The **auction panel** slides up on the player's call: bid number stepper, suit or no trump
    buttons, bid style toggle (56), Pass, Double.
  - **Redouble** is a floating button on the doubled team's screens whenever it's available.
  - The full auction so far is one tap away.
- **Hand**: an overlapping fan sorted by suit, then rank. **Tap once to lift a card, tap it
  again to play it.** In Block mode, illegal cards are dimmed and can't be lifted.
- **Menu**: session log, round history (per setting), live points (per setting), couch mode
  toggle, reactions, leave.
- **Phone portrait** stacks status bar, table, action area and hand. **Landscape and larger
  screens** put the table in the centre, the hand along the bottom, status on one side and
  actions on the other. On wide screens the session log stays open as a sidebar.
- After each match, an **end-of-match summary** shows each team's points, whether the bid was
  made, tokens moved, and any special reason (revoke, surrender, redeal, cancelled match).
- At the end of a session, a winner screen shows the final session log and, for the host,
  Restart session.

### 12.5 Couch mode
- A toggle each player sets on their own device.
- It replaces the table with a one-line status (whose turn, winning bid, trump if public, tokens),
  a large hand in one or two rows, and large action buttons.
- The screen border glows when it's the player's turn.

### 12.6 Animations
- The UI plays game events ("dealt", "card played", "round won", "trump revealed", …) **in order
  through an event queue**, finishing each event's visual step before showing the next state.
- **v1** uses short, simple transitions: a played card slides to the table, the winning card is
  highlighted, and the round slides toward the winner's seat.
- Richer animations can later replace individual steps without changing game logic. Game logic
  never depends on animation timing.
- If the device has reduced motion turned on, transitions are instant.

### 12.7 Responsive layout
- Every screen must work at **every size**, from small phones to TVs, in both orientations.
  Phones are the main device.
- **No fixed pixel widths or heights for layout.** Use relative sizing: percentages, `dvh`,
  flex and grid, `clamp()` for text and spacing, container queries so components size to their
  container, and `aspect-ratio` for cards. A styling library such as Tailwind is fine if it
  doesn't force fixed widths.
- Card size is calculated from the available width and the number of cards (up to 16), so a
  hand never overflows and cards stay easy to tap. The table fits 4, 6 or 8 seats the same way.
- Before a screen is done, check it on a small phone and a large phone in both orientations, a
  tablet, a laptop and a TV-sized screen.

### 12.8 Language
- English only for v1. All UI strings live in translation files, so other languages (Malayalam)
  can be added without refactoring.

## 13. Table view

- Joined from the home page with the room code. It doesn't take a seat and has no hand.
- Landscape layout for TVs and laptops, readable from across a room: a large table with all
  seats, a top bar with tokens, winning bid, trump and double, and a side panel with the auction
  and session log.
- While seats are still empty, it shows the room code and QR code large.
- After each match, it shows the end-of-match summary full screen.
- Visibility follows §7.

## 14. Debug page (`/debug`)

- Available on the live site, **protected by a password** set in server config. Without the
  password, nothing debug-related is shown.
- **Setup**: the same form as Create a table (with advanced options), plus an optional **deal
  seed** so a deal can be reproduced exactly.
- One browser plays every seat on the real game engine. After every change, the screen
  **switches to the seat that must act next** and shows exactly what that player sees.
- **Debug bar**:
  - "Act as" buttons for out-of-turn calls, such as Redouble for a seat on the doubled team
  - Seat switcher to view any seat without acting
  - "Show all hands" toggle
  - Live event log
  - Restart the match with the same seed
- Debug matches are kept separate from real rooms. Nothing in debug can view or change a real
  room.

## 15. Not in v1

Planned for later. Don't build these unless the user asks, but avoid designs that would block
them:
- Bots (filling seats, solo practice). Keep the engine usable by a non-human player.
- Rich animations (§12.6)
- In-app rules reference and auction help
- Sounds and haptics
- Installable PWA and dark mode
- Malayalam UI
- Shareable end-of-session summary image
- Accounts and stats across rooms
- Spectators with a player-style view (the Table view covers public viewing)
