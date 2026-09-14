# Rooms subsystem design

The rooms subsystem connects player identity, seating, readiness, presence, host controls,
persistence and the game engine. It builds on [design.md](../design.md), the
[game engine design](game-engine-design.md), and the
[tech stack design](tech-stack-design.md).

## 1. Goals and boundaries

The subsystem owns:

- room creation, lookup, joining and expiry
- player identities, PIN rejoining and browser tokens
- seats, readiness and first-dealer selection
- connections, stalls, replacement players and host transfer
- Table view authorization
- serialization of commands, durable room snapshots and update batches
- per-recipient views, capabilities and event redaction around the engine

The pure engine continues to own auctions, cards, play, scoring, tokens and session results. The
room service supplies seat-scoped engine actions, shuffled decks and system transitions only
after checking room-level permissions and readiness.

The subsystem assumes one server process and a small number of rooms. It deliberately avoids
distributed coordination, event sourcing, accounts, bots and general spectators.

## 2. Architecture

### 2.1 Authoritative aggregate

Each room is an authoritative serialized aggregate with a monotonically increasing revision. It
contains:

- fixed room configuration and lifecycle timestamps
- player identities and join order
- numbered seats mapped to identities
- readiness, the selected first dealer and the host identity
- pending host-transfer and PIN-lockout state
- the service-level room phase and either pure engine state or pending initial-session setup

The room snapshot is the recovery authority. A sequenced update journal is written beside it for
command deduplication and diagnostics, but rooms are not reconstructed by replaying events.

Seat numbers are the bookkeeping boundary between rooms and the engine. Team, turn order, dealer
position and an active hand belong to a seat. A player identity may move between seats only when
the room rules permit it; moving an identity does not move seat-owned state.

### 2.2 Components

| Component | Responsibility | Dependencies |
|---|---|---|
| `RoomDirectory` | Create rooms, generate unique codes, load rooms, sweep expired rooms | storage, clock, random source |
| `RoomManager` | Keep active rooms in memory and give each room a serial command queue | storage |
| `RoomService` | Validate and apply room commands; coordinate engine transitions | engine, storage, clock, random source, sender, scheduler |
| `AccessService` | Create and rejoin identities, hash PINs, issue and invalidate tokens, authorize Table views | storage, clock, random source |
| `ConnectionHub` | Bind principals to sockets, enforce one player connection and broadcast personalized views | sender |
| `RoomScheduler` | Deliver host-transfer and expiry callbacks through the room's serial queue | clock |
| `RoomStorage` | Load and transactionally save snapshots, update batches and access records | adapter-specific implementation |

HTTP and WebSocket handlers only parse protocol messages, call these services and return their
results.

### 2.3 Room transitions

Room policy is implemented as small pure functions where practical. A transition receives a
snapshot, an authenticated command and explicit time/random inputs. It returns either a new
snapshot plus canonical events or a stable rejection. The service executes storage, socket and
timer effects around that result.

The live in-memory snapshot is replaced only after its storage transaction commits. A failed
save therefore leaves the prior revision authoritative and sends no update.

## 3. Identities, joining and access

### 3.1 Player identities

A room admits no more player identities than its configured seat count. Disconnected and
unseated identities still count toward this cap until they intentionally leave or the host
removes them.

Each identity has:

- a stable random player ID
- display name and normalized name
- optional player PIN hash
- join order
- current seat or `null`
- last occupied seat or `null`
- Ready state

Names are trimmed, Unicode-normalized and compared case-insensitively. The normalized name is
unique within a room.

A new identity always enters unseated, including a new replacement joining during a stalled
match. It chooses an empty seat after joining. Until seated, it receives public room information
but no hand.

### 3.2 Browser-token rejoin

An opaque browser token identifies one player identity. Presenting a valid token restores that
identity exactly as saved: a seated player returns to the same seat and an unseated player
returns unseated. Authentication never offers a rejoining player a different seat. Normal seat
movement rules apply after rejoin.

There is one active WebSocket connection per player identity. A new successful `hello` for the
same identity replaces the older socket, which receives `signed_in_elsewhere` before closing.

### 3.3 Name-and-PIN rejoin

A different browser may rejoin by submitting the same normalized name and four-digit PIN. On
success the server rotates the identity's token, invalidates the old token and takes over any
active connection.

If the identity has no PIN, rejoining from another browser is rejected. Five wrong PIN attempts
lock PIN rejoin for that identity for one minute. Attempt count and lock expiry are persisted and
use the injected clock.

PINs use a slow salted password hash. Access tokens contain a non-secret selector and a random
secret; storage keeps the selector and a salted digest, never the usable token.

### 3.4 Intentional departure and removal

`Leave room` is permanent. It removes the identity, vacates its seat, clears readiness and
invalidates all of its tokens. Merely closing the app or losing connectivity is a temporary
disconnect and preserves the identity and seat.

Before a session and between matches, the host may remove any identity. During an active match,
the host may remove only a disconnected player while the match is stalled. Removal uses the same
cleanup as intentional departure.

If an identity disappears during an active match, the seat-owned hand, team and position remain
in the engine. A new identity joins unseated, chooses that empty seat and inherits its state.

### 3.5 Table view access

A Table view uses a separately scoped token and never consumes a player slot. If the room has a
Table view PIN, a correct PIN is required; otherwise the room code is sufficient. An authorized
Table token receives the host-control capability described in `design.md` but never player-only
or hand information.

Five wrong Table-PIN attempts lock Table authorization for that room for one minute. The counter
and deadline are persisted. Multiple authorized Table views may be open concurrently.

## 4. Seats, sessions and readiness

### 4.1 Arranging a session

The service-level `arranging` phase covers the time before the first match of each session.

- Every identity starts or restarts the session unseated and Unready.
- Any player may leave their current seat and take any empty seat.
- The host may move or swap any players.
- The first dealer is chosen from the numbered seats using the injected random source. The host
  may select a different seat.
- Any seat change or first-dealer change clears every player's Ready state.

The initial room enters `arranging` without starting the engine. When a session ends, the host's
`Restart session` command marks the next session as pending, prepares a new random first dealer,
unseats and unreadies everyone, and returns to `arranging`. The completed engine state continues
to hold the session result and history. The engine's `restartSession(firstDealer)` transition is
deferred until the readiness gate opens, so the engine archives that result and uses the final
host-selected dealer. The initial session similarly calls `startSession` only when its gate
opens.

### 4.2 Automatic match start

There is no host Start button. The first match starts automatically when:

- every configured seat is occupied
- every player identity is currently connected
- every player has selected Ready

Readiness survives a temporary disconnect, but connectivity is independently required. If all
other conditions remain true, reconnecting the final missing player starts the match.

The room service performs the session start and first deal in the same serialized transition
that satisfies the gate. It supplies a shuffled deck generated from the injected random source.

### 4.3 Between matches

After each match, all players become Unready and the engine remains at `matchOver`. Existing
players may not unseat or move themselves after the session's first match has begun. A brand-new
identity admitted to replace a removed player may take one empty seat, after which the same lock
applies. The host may move or swap players between matches. Team and next-dealer state stay
attached to seat numbers, so a moved player assumes the destination seat's team and position.

The next match begins automatically under the same occupied, connected and Ready gate. The room
service then invokes the engine's `startNextMatch` and supplies the next shuffled deck.

### 4.4 Replacement readiness

A disconnect during an active match stalls play immediately. If the old identity reconnects,
its readiness from the start of that match remains valid and play resumes when all missing
players are present.

A genuinely new replacement must choose an empty seat and tap `Ready to resume`. Existing
players do not vote again. Play resumes only when every required seat is occupied and connected
and every new replacement has confirmed.

## 5. Presence, stalls and host succession

### 5.1 Presence and stalls

Connection state is server-authoritative. During an active-match stall, ordinary engine commands
are rejected. Players may still view the room, open logs and history, and send preset reactions.
The following operations remain available where authorized:

- rejoin the missing identity
- remove a disconnected identity
- admit and seat a replacement
- confirm a replacement is ready
- use the host's End match action
- complete a pending host transfer

If several seats are missing, the stall continues until all are restored. Before and between
matches, a missing connection blocks the automatic readiness gate instead of creating a distinct
engine stall.

### 5.2 Automatic host transfer

A host disconnect starts the room's configured transfer delay. Rejoining before the committed
deadline cancels the pending transfer. Otherwise, the timer callback enters the same serial room
queue as every other command and chooses:

1. the next connected occupied player counter-clockwise from the host's current seat
2. if the host is unseated, the next such player from the host's last seat
3. if no connected occupied player exists, the earliest-joined connected player

If the host has never occupied a seat, selection starts directly with the earliest-joined
connected player. If no player is connected, transfer stays pending until an eligible player
connects.

An intentional host departure transfers powers immediately using the same ordering. Once a
transfer commits, the former host does not regain the role automatically. The current host may
also hand the role to any seated player.

Timer callbacks carry the expected host ID and deadline. A callback that became stale because of
rejoin, manual transfer or another transition is a no-op.

## 6. Persistence and runtime model

### 6.1 Storage records

The SQLite adapter implements portable app-level storage interfaces with Kysely. The initial
rooms design uses three logical tables:

| Table | Purpose |
|---|---|
| `rooms` | Room ID and code, revision, serialized snapshot, creation/activity/expiry timestamps |
| `room_updates` | Room revision, actor, command ID, recorded outcome and canonical accepted event batch |
| `access_tokens` | Token selector and digest, room, principal scope and optional player ID |

Serialized values are encoded and decoded by the application rather than queried by SQL.
Database-specific JSON operators are not used. Room deletion cascades through updates and
tokens through adapter operations rather than relying on SQLite-only behavior.

A uniqueness constraint on `(room ID, actor ID, command ID)` makes accepted and rejected command
deduplication durable. A rejection records its code/current revision before the response but does
not change the room snapshot. System transitions use stable system actor keys. Journal records
live until their room is deleted.

### 6.2 Active rooms

Rooms are loaded into memory on first use. `RoomManager` provides one promise-based serial queue
per active room. Every command, presence transition and timer callback passes through it.

After each accepted transition, the room snapshot and canonical event batch are saved in one
transaction. Only then does the manager replace the in-memory revision and send personalized
updates. A storage failure leaves the prior snapshot active.

### 6.3 Process recovery

After process restart all socket presence is treated as offline. Previously empty rooms preserve
their earlier empty timestamp; a room that appeared occupied when the process stopped uses
server startup as the conservative disconnect time. Loading a room normalizes saved presence,
then applies the reconnect that caused the load.

Active matches remain stalled until their identities reconnect or are replaced. Host-transfer
deadlines are reconstructed from known disconnect timestamps. When a crash left no timestamp,
server startup is the fallback.

### 6.4 Expiry

A room expires after 24 hours with no player connection. Table views do not reset this clock, so
an abandoned display cannot retain a room indefinitely. The periodic sweep uses the rooms table's
indexed expiry timestamp.

Expiry atomically deletes the snapshot, journal and access records. Any remaining Table sockets
receive `room_expired` and close.

## 7. Protocol

Every HTTP body and WebSocket message has a Zod schema in `packages/protocol`.

### 7.1 HTTP operations

| Operation | Request | Result |
|---|---|---|
| `POST /api/rooms` | room settings, host name, optional player PIN | room code and player token |
| `POST /api/rooms/:code/join` | name and optional PIN | new-identity or rejoin player token |
| `POST /api/rooms/:code/table` | optional Table PIN | Table token |

A browser with an existing token does not call join again. It opens the WebSocket and presents
that token in `hello`.

### 7.2 Client-to-server WebSocket messages

The first message is `{type: "hello", token}`. After acceptance, mutations use
`{type: "command", commandId, command}`. Room commands are a discriminated union:

- `takeSeat(seat)` and `leaveSeat`
- `setReady(ready)`
- `hostMovePlayer(player, seat)` and `hostSwapPlayers(first, second)`
- `setFirstDealer(seat)`
- `removePlayer(player)` and `transferHost(player)`
- `engineAction(action)`
- `sendReaction(reaction)`
- `restartSession`
- `leaveRoom`

Engine actions remain the tagged union defined by the engine spec. The room service supplies the
authenticated source seat; clients cannot claim another source.

### 7.3 Server-to-client WebSocket messages

- `helloAccepted(revision, view, allowedRoomActions, allowedHostActions)` gives a complete
  current snapshot and does not replay old animations.
- `update(revision, events, view, allowedRoomActions, allowedHostActions, commandId?)` follows an
  accepted transition. `commandId` is included for the originating principal.
- `commandRejected(commandId, code, details?, revision, view)` returns the caller's current
  state after a valid but disallowed command.
- `error(code)` reports connection- or protocol-level failures.
- `accessRevoked(reason)` is terminal. Reasons include `signed_in_elsewhere`, `removed`,
  `left_room` and `room_expired`.

Views and events are personalized before serialization. The message envelope is shared across
player and Table principals, but their view types and capabilities differ.

### 7.4 Idempotency

Clients generate a random command ID and retain it until accepted or rejected. If a response is
lost, the same command may be retried. A repeated `(room, actor, commandId)` returns the recorded
result/current view without applying the transition again.

Command IDs provide retry safety, not ordering authority. Current room state and the serial queue
decide whether a new command is valid.

## 8. Views, capabilities and redaction

### 8.1 Player room view

A player room view contains:

- room code, fixed settings, phase and revision
- host and selected first dealer
- numbered seats with public identity, team, connection and Ready state
- the viewer's current and last seat
- the readiness gate or stall status
- the viewer-specific engine view
- the session log and permitted round history

The server attaches `allowedRoomActions`, `allowedHostActions` and the engine's allowed actions.
The web app renders these capabilities instead of reimplementing permission rules.

An unseated player receives no hand. In an active replacement flow it sees the public match state
and empty-seat choices only. Once it takes a seat, the next view contains that seat's inherited
hand.

### 8.2 Table room view

A Table room view contains the public subset of the same room and engine state. It never includes
a hand, hidden trump or player-only action. Its separately authorized scope determines whether
`allowedHostActions` is populated.

### 8.3 Events

Room events cover identity join/leave, seat changes, readiness, presence, stalls, host changes,
access revocation and expiry. Engine events are those in the engine spec.

The journal stores canonical internal events. Immediately before delivery, the service calls the
appropriate room and engine redactors for each recipient. PIN material, token material, other
hands and hidden trump never appear in a player or Table message.

## 9. Command flow and automatic transitions

Each command follows this path:

1. Validate its Zod schema at the network edge.
2. Resolve and authenticate the token principal.
3. Enter the room's serial queue.
4. Detect a duplicate command ID and return its prior result if present.
5. Validate principal capability, room phase and room-level invariants.
6. Invoke the pure engine when the command contains an engine or system action.
7. Check automatic transitions such as match start, match resume or host succession.
8. Produce the next snapshot and canonical event batch.
9. Transactionally save the snapshot, events and any access-record changes.
10. Replace the in-memory snapshot.
11. Redact events and build a fresh view for every recipient, then broadcast.

The final Ready command may therefore produce readiness, session-start and deal events in one
transaction. A replacement's Ready command may produce readiness and stall-ended events without
altering the engine match.

## 10. Rejections, races and recovery errors

Stable room rejection codes include:

- `room_full`, `name_taken`, `pin_required`, `pin_incorrect`, `pin_locked`
- `table_pin_incorrect`, `table_pin_locked`
- `seat_occupied`, `not_seated`, `seat_change_not_allowed`
- `not_readyable`, `player_disconnected`, `room_not_ready`
- `not_host`, `player_not_removable`, `invalid_host_target`
- `match_stalled`, `action_not_allowed`

Engine rejection codes pass through unchanged inside the protocol's engine-rejection variant.
Responses do not reveal whether a different identity's PIN exists or any private engine state.

Serialization determines races:

- Two players choose one seat: the first succeeds; the other receives `seat_occupied` and a
  fresh view.
- Final Ready races with a seat/dealer change: if Ready starts the match first, a later self-move
  is rejected; if the setup changes first, all readiness is cleared.
- Host reconnect races with transfer: reconnect cancels a pending deadline, but a committed
  transfer is not reversed.
- Duplicate engine actions: the durable command ID returns the original outcome.

If a database operation fails with an uncertain result, the room stops accepting mutations,
reloads its last committed snapshot and then becomes available again. No success is reported
before the committed revision is known.

## 11. Invariants, future tests and logging

The room boundary checks these invariants after every accepted transition:

- identity count is no greater than seat count
- normalized player names are unique
- one identity occupies at most one seat and one seat has at most one identity
- during an active match, an engine seat changes identity only through the explicit
  stalled-replacement flow
- a match starts only with every seat occupied and every player connected and Ready
- a new replacement cannot resume a match before confirming Ready
- host selection refers to a current identity or is explicitly pending because none is connected
- player and Table views satisfy their visibility contracts

No test framework or tests are added with the initial implementation unless separately
requested. The design supports later:

- unit tests for pure seat, readiness, host, permission and lockout transitions
- adapter-contract tests shared by SQLite and future storage adapters
- protocol-schema and redaction tests
- scenario tests for disconnects, replacements, simultaneous seat claims, Ready races, host
  transfer races and duplicate commands

Structured logs include room ID, revision, principal scope, command type, result code and
duration. They never include tokens, PINs, hands, hidden trump or serialized snapshots.

## 12. Deliberate exclusions

- No player can join beyond the configured identity cap as a waiting spectator.
- No ordinary player can move seats after the first match of a session begins.
- No host can rearrange players during an active match; removal of a disconnected player is the
  only active-match seat-ownership transition.
- Table views do not participate in host succession or keep rooms alive.
- The update journal is not a public audit log and is not replayed for reconnect animations.
- Multi-process room ownership and distributed locks are outside v1.
