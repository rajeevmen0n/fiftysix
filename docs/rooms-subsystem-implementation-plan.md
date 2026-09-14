# Rooms Subsystem Implementation Plan

> **Agent workflow:** Follow the lightweight develop-and-review loop in `AGENTS.md`; do not load
> an additional process skill. Use the checkboxes (`- [ ]`) for progress tracking.

**Goal:** Build persistent multiplayer rooms with identity and PIN rejoining, seats, readiness,
stalls, replacements, host succession, Table access, personalized views, and typed HTTP/WebSocket
boundaries around the pure game engine.

**Architecture:** Each room is one authoritative snapshot processed through one serial queue.
Accepted commands persist the next snapshot and canonical events before personalized broadcasts.
Indexed token records and a command-outcome journal provide secure access and durable
deduplication without making events the source of truth.

**Tech Stack:** TypeScript (`strict`, `noUncheckedIndexedAccess`), Node.js 24, Hono,
`@hono/node-ws`, Zod, Kysely, `better-sqlite3`, pino, React 19, Zustand, pnpm, Nix.

**Spec:** `docs/rooms-subsystem-design.md`

**Status:** Approved on 2026-09-14 after rules, security, persistence, protocol, recovery,
downstream-interface, and completeness review.

## Global constraints

- Do not execute R001 until the repository skeleton and `packages/engine` are implemented and
  marked complete in `docs/implementation-progress.md`.
- Read `AGENTS.md`, `docs/implementation-progress.md`, this header, the current task, its declared
  dependencies, and `docs/rooms-subsystem-design.md`. Tasks that touch the engine also require
  `rules.md`, `design.md`, and `docs/game-engine-design.md`.
- Work strictly sequentially. Dispatch exactly one fresh implementation subagent for the current
  task with `fork_turns: "none"`. After primary review and verification, ask the user before the
  next task.
- Use `gpt-5.6-sol` at high effort for the primary agent, most programming subagents, and final
  verification. Use `gpt-5.6-terra` at high effort only where a task is narrow and specific. Use
  `gpt-5.6-luna` only for trivial mechanical work.
- No task in this plan needs Astra or image generation. Future high-priority UI tasks use
  `gpt-6-astra` at high effort, stay narrowly scoped, and use Gemini MCP for every generated image
  asset.
- Tests are not required solely for coverage, and no broad test framework is added preemptively.
  Use typecheck, lint, build, and direct manual scenarios when sufficient. If verification
  requires executable scenarios, assertions, fakes, fixtures, or a custom harness, commit it as a
  focused automated test instead of a disposable inline command or temporary script.
- Run project commands through `nix develop -c`, except `nix build` and `nix flake check`.
- `packages/engine` remains dependency-free. `apps/web` uses only type imports from protocol and
  never imports engine or server code.
- Every network message has a Zod schema in protocol and is parsed at the server edge.
- Domain code never reads global time or randomness. Only storage adapters import Kysely or
  `better-sqlite3`.
- Never publish a new in-memory snapshot or response before its storage transaction commits.
- Never put usable tokens, PINs, hands, hidden trump, or private snapshots into logs or an
  unauthorized view.

## Progress protocol

Every numbered task is a self-contained unit intended to finish, verify, and commit within one
session. Sol tasks may be moderately sized when all changes serve one boundary. If a task expands
into an unrelated boundary, stop and split it before coding.

At task start, set the task to `In progress` in `docs/implementation-progress.md`. At completion:

1. The primary agent inspects the entire diff and reruns the task's verification commands.
2. Change the task heading from `[ ]` to `[x]`.
3. Record the commit, verification, and next task in `docs/implementation-progress.md`.
4. Include the plan and progress updates in the same task commit.
5. Stop and ask the user before dispatching the next task.

If blocked, leave the checkbox open and record the exact blocker, current diff/commit state, and
smallest next action in the progress ledger.

## Planned files

```text
packages/protocol/src/rooms/
  model.ts commands.ts events.ts views.ts http.ts messages.ts index.ts

apps/server/src/rooms/
  types.ts names.ts invariants.ts seating.ts readiness.ts presence.ts host.ts
  credentials.ts access-service.ts capabilities.ts views.ts shuffle.ts
  room-manager.ts connection-hub.ts room-scheduler.ts room-service.ts room-directory.ts index.ts

apps/server/src/storage/
  room-storage.ts migrations/002_rooms.ts sqlite/room-codec.ts sqlite/room-storage.ts

apps/server/src/routes/rooms.ts
apps/server/src/ws/room-socket.ts
apps/web/src/net/room-client.ts
apps/web/src/store/room-store.ts
```

If prerequisite work chose a different path for an equivalent existing boundary, record the
one-to-one substitution in the progress ledger before dispatch and modify that boundary instead
of creating a duplicate.

---

### [ ] R001: Define the complete rooms protocol

**Suggested implementer:** `gpt-5.6-sol`, high effort

**Files:**
- Create: `packages/protocol/src/rooms/model.ts`
- Create: `packages/protocol/src/rooms/commands.ts`
- Create: `packages/protocol/src/rooms/events.ts`
- Create: `packages/protocol/src/rooms/views.ts`
- Create: `packages/protocol/src/rooms/http.ts`
- Create: `packages/protocol/src/rooms/messages.ts`
- Create: `packages/protocol/src/rooms/index.ts`
- Modify: `packages/protocol/src/index.ts`

**Depends on:** Implemented engine types and existing protocol conventions.

**Interfaces produced:**

```ts
export type PlayerId = string;
export type RoomId = string;
export type RoomCode = string;
export type ReactionId =
  | "hello" | "nice" | "wellPlayed" | "wow" | "oops" | "oneMoment" | "thanks";
export type PrincipalScope =
  | {type: "player"; playerId: PlayerId}
  | {type: "table"; hostControls: boolean};

export type RoomCommand =
  | {type: "takeSeat"; seat: number}
  | {type: "leaveSeat"}
  | {type: "setReady"; ready: boolean}
  | {type: "hostMovePlayer"; playerId: PlayerId; seat: number}
  | {type: "hostSwapPlayers"; first: PlayerId; second: PlayerId}
  | {type: "setFirstDealer"; seat: number}
  | {type: "removePlayer"; playerId: PlayerId}
  | {type: "transferHost"; playerId: PlayerId}
  | {type: "engineAction"; action: ClientEngineAction}
  | {type: "sendReaction"; reaction: ReactionId}
  | {type: "restartSession"}
  | {type: "leaveRoom"};

export interface RoomView {
  roomCode: RoomCode;
  revision: number;
  phase: RoomPhase;
  players: PublicPlayer[];
  firstDealer: number;
  viewer: {type: "player"; playerId: PlayerId; seat: number | null} | {type: "table"};
  engine: EngineView | null;
  allowedRoomActions: AllowedRoomAction[];
  allowedHostActions: AllowedHostAction[];
}
```

- [ ] Define public IDs, room phases, settings, `PublicPlayer`, capabilities, room events, and
  recipient-safe views. Keep credentials and private state out.
- [ ] Define `RoomCommand` and its Zod discriminated union. Reproduce the engine's client-action
  schema in protocol with the source seat omitted, constrain it with
  `satisfies z.ZodType<ClientEngineAction>`, and import engine types only.
- [ ] Define HTTP schemas for create/join/Table access. Require basic settings, default advanced
  settings from `design.md`, names with a 1,024-byte UTF-8 encoded-length bound, setting integers
  within their documented caps, and PINs as exactly four ASCII digits. Reject name control and
  line/paragraph-separator characters before service entry.
- [ ] Define WebSocket schemas for `hello`, `command`, `helloAccepted`, `update`,
  `commandRejected`, `error`, and `accessRevoked`; include every stable rejection from rooms spec
  §10, including reaction throttling and oversized requests.
- [ ] Export the protocol surface, run `nix develop -c pnpm typecheck` and
  `nix develop -c pnpm lint`, and expect both exit 0.
- [ ] Review `git diff --check`; update plan/progress and commit
  `feat(protocol): define rooms protocol`.

---

### [ ] R002: Implement the pure room aggregate and seating/readiness policy

**Suggested implementer:** `gpt-5.6-sol`, high effort

**Files:**
- Create: `apps/server/src/rooms/types.ts`
- Create: `apps/server/src/rooms/names.ts`
- Create: `apps/server/src/rooms/invariants.ts`
- Create: `apps/server/src/rooms/seating.ts`
- Create: `apps/server/src/rooms/readiness.ts`
- Create: `apps/server/src/rooms/index.ts`

**Depends on:** R001 and implemented engine state/phase/config types.

**Interfaces produced:**

```ts
export interface PlayerRecord {
  id: PlayerId;
  displayName: string;
  normalizedName: string;
  pin: PinCredential | null;
  joinOrder: number;
  seat: number | null;
  lastSeat: number | null;
  ready: boolean;
  connected: boolean;
  disconnectedAt: number | null;
  replacementReady: boolean;
  lastReactionAt: number | null;
}

export interface RoomSnapshot {
  id: RoomId;
  code: RoomCode;
  revision: number;
  config: RoomConfig;
  phase: {type: "arranging"; pending: "initial" | "restart"} | {type: "running"};
  players: PlayerRecord[];
  seats: Array<PlayerId | null>;
  hostId: PlayerId | null;
  hostTransfer: {hostId: PlayerId; deadline: number} | null;
  firstDealer: number;
  engine: EngineState | null;
  tablePin: PinCredential | null;
  createdAt: number;
  emptySince: number | null;
}

export type DomainEffect = {type: "revokePlayerTokens"; playerId: PlayerId};
export type DomainResult =
  | {ok: true; state: RoomSnapshot; events: CanonicalRoomEvent[]; effects: DomainEffect[]}
  | {ok: false; code: RoomRejectionCode; details?: Record<string, unknown>};
```

- [ ] Add JSON-safe private state using arrays/tagged records, plus NFKC/locale-independent
  case normalization and a pure `Intl.Segmenter("und", {granularity: "grapheme"})` helper.
  Accept 1–24 user-perceived characters after trimming and normalization.
- [ ] Implement `assertRoomInvariants` for identity cap, normalized-name uniqueness, bidirectional
  seats, ranges, host membership, engine seat count, and replacement state. Errors contain only
  room ID/revision/invariant code.
- [ ] Implement immutable `takeSeat`, `leaveSeat`, `hostMovePlayer`, `hostSwapPlayers`, and
  `setFirstDealer`. Ordinary self-movement is arranging-only except a new replacement's first
  vacant-seat claim; host rearrangement is arranging or `matchOver`, never active play.
- [ ] Implement `clearAllReady`, `setReady`, and `readinessGate`. Setup/between-match seat or dealer
  changes clear everyone; active replacement preserves existing confirmation and requires only
  the newcomer. Gates require occupied seats, connections, and appropriate Ready flags.
- [ ] Run typecheck and lint; expect exit 0. Confirm pure files import no Node, storage, network,
  clock, random, or logger modules.
- [ ] Review `git diff --check`; update plan/progress and commit
  `feat(server): add room seating and readiness policy`.

---

### [ ] R003: Implement presence, replacement, and host succession policy

**Suggested implementer:** `gpt-5.6-sol`, high effort

**Files:**
- Create: `apps/server/src/rooms/presence.ts`
- Create: `apps/server/src/rooms/host.ts`
- Modify: `apps/server/src/rooms/invariants.ts`
- Modify: `apps/server/src/rooms/index.ts`

**Depends on:** R002 and rooms spec §§3–5.

**Interfaces produced:**

```ts
export function connectPlayer(state: RoomSnapshot, playerId: PlayerId, now: number): DomainResult;
export function disconnectPlayer(state: RoomSnapshot, playerId: PlayerId, now: number): DomainResult;
export function leaveRoom(state: RoomSnapshot, playerId: PlayerId): DomainResult;
export function removePlayer(state: RoomSnapshot, actor: PrincipalScope, target: PlayerId): DomainResult;
export function chooseSuccessor(state: RoomSnapshot, formerHost: PlayerRecord): PlayerId | null;
export function transferHost(state: RoomSnapshot, target: PlayerId): DomainResult;
export function applyHostDeadline(state: RoomSnapshot, hostId: PlayerId, deadline: number): DomainResult;
```

- [ ] Connect/disconnect while preserving seat/readiness, tracking disconnect/empty timestamps,
  exposing active-match stalls, and cancelling only a reconnecting current host's deadline.
- [ ] Make Leave/removal permanent with token effects. Active removal requires a disconnected
  target, preserves seat-owned engine state and existing player confirmation, and marks the
  vacancy for a newly Ready replacement.
- [ ] Select host by counter-clockwise connected occupied seat from current/last seat, then lowest
  connected join order. Explicit host departure transfers immediately; stale deadline callbacks
  are no-ops; manual target must be seated.
- [ ] Extend invariants for active replacement and pending-host states.
- [ ] Run typecheck and lint; expect exit 0 and no ambient time calls.
- [ ] Review `git diff --check`; update plan/progress and commit
  `feat(server): add room presence and host policy`.

---

### [ ] R004: Implement credential primitives

**Suggested implementer:** `gpt-5.6-sol`, high effort

**Files:**
- Create: `apps/server/src/rooms/credentials.ts`
- Modify: `apps/server/src/rooms/index.ts`
- Modify: prerequisite random-source interface only if byte generation is absent

**Depends on:** R002 and the prerequisite cryptographic random-source interface.

**Interfaces produced:**

```ts
export interface CredentialHasher {
  hashPin(pin: string, salt: Uint8Array): Promise<string>;
  verifyPin(pin: string, salt: Uint8Array, digest: string): Promise<boolean>;
  digestToken(secret: string, salt: Uint8Array): Promise<string>;
}
export function issueToken(random: RandomSource, hasher: CredentialHasher): Promise<IssuedToken>;
export function parseToken(value: string): {selector: string; secret: string} | null;
export function recordPinFailure(value: PinCredential, now: number): PinCredential;
export function recordPinSuccess(value: PinCredential): PinCredential;
export function pinIsLocked(value: PinCredential, now: number): boolean;
```

- [ ] Implement PIN hashing with Node `crypto.scrypt` using `N=16384`, `r=8`, `p=1`, a 32-byte
  result and fresh 16-byte salt. Issue independent random 16-byte selectors and 32-byte token
  secrets; store a salted SHA-256 digest and compare it in constant time. Strictly parse
  `selector.secret`. Usable tokens exist only in return values.
- [ ] Implement pure five-failure/60,000 ms player and Table PIN lockout transitions using passed
  timestamps; successful/expired locks reset the sequence.
- [ ] Run typecheck and lint; expect exit 0 with Node crypto restricted to this server edge.
- [ ] Review `git diff --check`; update plan/progress and commit
  `feat(server): add room credential primitives`.

---

### [ ] R005: Implement the room storage contract and SQLite adapter

**Suggested implementer:** `gpt-5.6-sol`, high effort

**Files:**
- Create: `apps/server/src/storage/room-storage.ts`
- Create: `apps/server/src/storage/migrations/002_rooms.ts`
- Create: `apps/server/src/storage/sqlite/room-codec.ts`
- Create: `apps/server/src/storage/sqlite/room-storage.ts`
- Modify: storage/migration indexes and prerequisite database-schema types

**Depends on:** R001–R004 and the skeleton storage adapter.

**Interfaces produced:**

```ts
export interface RoomStorage {
  createRoom(input: CreateRoomRecord): Promise<"created" | "codeConflict">;
  loadRoomByCode(code: string): Promise<RoomSnapshot | null>;
  loadRoomById(id: string): Promise<RoomSnapshot | null>;
  commitRoomTransition(input: CommitRoomTransition): Promise<"committed" | "conflict">;
  recordRejectedCommand(input: StoredRejectedCommand): Promise<"recorded" | "duplicate">;
  findCommand(roomId: string, actorId: string, commandId: string): Promise<StoredCommandResult | null>;
  loadToken(selector: string): Promise<StoredAccessToken | null>;
  listExpiredRoomIds(now: number): Promise<string[]>;
  deleteRoom(roomId: string): Promise<void>;
  markApparentlyConnectedRoomsOffline(startedAt: number): Promise<void>;
}
```

- [ ] Define app-language records for room creation, optimistic transition commits, accepted and
  rejected command outcomes, and token insert/revoke effects. No interface exposes Kysely types.
- [ ] Add portable `rooms`, `room_updates`, and `access_tokens` schema-builder migrations with
  text JSON, integer timestamps, and indexes for room code, expiry, selector, and unique
  `(room_id, actor_id, command_id)`.
- [ ] Add versioned snapshot/outcome codecs that parse JSON from `unknown` and raise safe
  corruption errors containing only room/revision/error code.
- [ ] Implement SQLite create/load/token lookup and optimistic transition commit in one
  transaction: update the expected revision, insert outcome/events, and apply token effects.
  Persist rejected outcomes without changing the snapshot.
- [ ] Implement dedupe lookup, portable transactional deletion, expiry lookup, and startup
  offline marking; wire the adapter through the existing storage composition.
- [ ] Run typecheck and lint; expect exit 0. Inspect imports to confirm only adapter files import
  Kysely or `better-sqlite3`.
- [ ] Review `git diff --check`; update plan/progress and commit
  `feat(server): persist room aggregates`.

---

### [ ] R006: Implement identity and Table access flows

**Suggested implementer:** `gpt-5.6-sol`, high effort

**Files:**
- Create: `apps/server/src/rooms/access-service.ts`
- Modify: `apps/server/src/rooms/index.ts`

**Depends on:** R002–R005.

**Interfaces produced:**

```ts
export interface SerializedRoomAccess {
  withRoomByCode<T>(
    code: string,
    operation: (state: RoomSnapshot) => Promise<{value: T; committedState?: RoomSnapshot}>,
  ): Promise<T>;
}
export type AuthenticatedPrincipal = {
  roomId: RoomId;
  tokenSelector: string;
  scope: PrincipalScope;
};
export type PlayerAccessResult = {token: string; playerId: PlayerId; takeoverPlayerId: PlayerId | null};
export type TableAccessResult = {token: string; hostControls: true};
export class AccessService {
  createPlayer(code: string, input: JoinRoomRequest): Promise<JoinRoomResponse>;
  authenticateToken(token: string): Promise<AuthenticatedPrincipal>;
  rejoinWithPin(code: string, name: string, pin: string): Promise<PlayerAccessResult>;
  openTable(code: string, pin?: string): Promise<TableAccessResult>;
}
```

- [ ] Admit a unique nonempty normalized name only below the identity cap. Create the identity
  unseated/Unready and persist snapshot, join event, and token atomically through
  `SerializedRoomAccess`.
- [ ] Authenticate selector/secret without changing saved seating. For name/PIN rejoin, persist
  failures and one-minute lockout; on success reset failures, rotate every player token, and
  return the takeover player ID.
- [ ] Authorize Table access by room code when no Table PIN exists; otherwise persist the same
  five-failure lockout. Later lockouts do not revoke existing Table tokens.
- [ ] Keep usable tokens only in access responses and prohibit token/PIN fields in events/logs.
- [ ] Run typecheck and lint; expect exit 0.
- [ ] Review `git diff --check`; update plan/progress and commit
  `feat(server): add room access service`.

---

### [ ] R007: Implement capabilities, personalized views, and redaction

**Suggested implementer:** `gpt-5.6-sol`, high effort

**Files:**
- Create: `apps/server/src/rooms/capabilities.ts`
- Create: `apps/server/src/rooms/views.ts`
- Modify: `apps/server/src/rooms/index.ts`

**Depends on:** R001–R003 and implemented engine view/redaction functions.

**Interfaces produced:**

```ts
export function allowedRoomActions(state: RoomSnapshot, principal: PrincipalScope): AllowedRoomAction[];
export function allowedHostActionsForPrincipal(state: RoomSnapshot, principal: PrincipalScope): AllowedHostAction[];
export function roomView(state: RoomSnapshot, principal: PrincipalScope): RoomView;
export function redactRoomEvents(
  state: RoomSnapshot,
  principal: PrincipalScope,
  events: readonly CanonicalRoomEvent[],
): RoomEvent[];
```

- [ ] Return exact currently legal seat/player targets for room and host capabilities, including
  arranging, between-match, stall, replacement, and authorized Table cases.
- [ ] Give a seated player only its seat-scoped engine view. Give an active unseated replacement
  the Table/public engine view and other unseated identities no engine view. Always use engine
  viewer `table` for a Table principal.
- [ ] Redact nested engine events with engine `redactEvent`, remove null results while retaining
  order, and ensure public room events contain no credential/private-state fields.
- [ ] Run typecheck and lint; expect exit 0. Inspect generated view types for absence of
  `PinCredential`, token records, other hands, and hidden trump.
- [ ] Review `git diff --check`; update plan/progress and commit
  `feat(server): add room views and capabilities`.

---

### [ ] R008: Implement room queues, connection ownership, and scheduling

**Suggested implementer:** `gpt-5.6-sol`, high effort

**Files:**
- Create: `apps/server/src/rooms/room-manager.ts`
- Create: `apps/server/src/rooms/connection-hub.ts`
- Create: `apps/server/src/rooms/room-scheduler.ts`
- Modify: `apps/server/src/rooms/index.ts`

**Depends on:** R005–R007 and prerequisite sender/scheduler abstractions.

**Interfaces produced:**

```ts
export class RoomManager implements SerializedRoomAccess {
  withRoom<T>(roomId: RoomId, operation: (state: RoomSnapshot) => Promise<T>): Promise<T>;
  withRoomByCode<T>(
    code: string,
    operation: (state: RoomSnapshot) => Promise<{value: T; committedState?: RoomSnapshot}>,
  ): Promise<T>;
  replaceCommitted(roomId: RoomId, state: RoomSnapshot): void;
}
export interface RoomSocket {send(value: string): void; close(code?: number): void;}
export interface Origin {principal: AuthenticatedPrincipal; commandId: string;}
export class ConnectionHub {
  attach(principal: AuthenticatedPrincipal, socket: RoomSocket): RoomSocket | null;
  detach(principal: AuthenticatedPrincipal, socket: RoomSocket): boolean;
  broadcast(room: RoomSnapshot, events: readonly CanonicalRoomEvent[], origin?: Origin): void;
}
export class RoomScheduler {
  scheduleHostTransfer(roomId: RoomId, hostId: PlayerId, deadline: number): void;
  cancelHostTransfer(roomId: RoomId): void;
  close(): void;
}
```

- [ ] Cache rooms on first use and serialize work with a promise tail that survives a rejected
  operation. Return each caller's promise separately and expose no mutable snapshot outside its
  operation.
- [ ] Enforce one active player socket: send `signed_in_elsewhere` to the replaced socket and
  compare socket identity on detach so its close cannot disconnect the replacement. Permit
  multiple Table-token connections.
- [ ] Build each recipient's view/redacted events independently during broadcast and isolate send
  failures.
- [ ] Replace/cancel one host timer per room. Timer callbacks carry expected host/deadline and
  reenter RoomManager; elapsed deadlines enqueue immediately.
- [ ] Run typecheck and lint; expect exit 0.
- [ ] Review `git diff --check`; update plan/progress and commit
  `feat(server): manage active room runtime`.

---

### [ ] R009: Implement room commands and engine orchestration

**Suggested implementer:** `gpt-5.6-sol`, high effort

**Files:**
- Create: `apps/server/src/rooms/shuffle.ts`
- Create: `apps/server/src/rooms/room-service.ts`
- Modify: `apps/server/src/rooms/index.ts`

**Depends on:** R001–R008 and the complete engine. Read all game-rule/design documents.

**Interfaces produced:**

```ts
export function shuffleDeck<T>(cards: readonly T[], random: RandomSource): T[];
export class RoomService {
  handleCommand(principal: AuthenticatedPrincipal, commandId: string, command: RoomCommand): Promise<void>;
  connectPlayer(principal: AuthenticatedPlayer): Promise<void>;
  disconnectPlayer(principal: AuthenticatedPlayer): Promise<void>;
  handleHostDeadline(roomId: RoomId, hostId: PlayerId, deadline: number): Promise<void>;
}
export type AuthenticatedPlayer = AuthenticatedPrincipal & {
  scope: {type: "player"; playerId: PlayerId};
};
```

- [ ] Implement unbiased Fisher–Yates on a copy with `RandomSource.integer`; use engine deck
  membership and no global randomness.
- [ ] Authenticate capability, enter the room queue, check durable command outcome, and route
  room-domain commands. Attach actor/source server-side and reject client-claimed seats.
- [ ] Map engine commands to the authenticated seat or authorized host/Table source. Reject
  unseated/stalled play. Apply engine actions through its public `act` interface only.
- [ ] After Ready/connect/seat transitions, evaluate the gate. Start/restart/advance sessions via
  engine system actions and deal a shuffled deck; resume replacements without changing engine
  match state.
- [ ] When a committed engine result enters `awaitingDeal(redeal)` or
  `awaitingDeal(restart)`, enqueue a separate same-dealer system deal after broadcast without a
  Ready gate. Persist and publish every redeal result before attempting the next shuffled deck.
- [ ] On host `restartSession`, retain the completed engine state while entering arranging,
  unseat/unready everyone, choose a new injected-random first dealer, and defer engine
  `restartSession(firstDealer)` until the readiness gate opens.
- [ ] Validate reactions against the seven `ReactionId` values before emitting them; never accept
  arbitrary reaction text. Using the injected clock and persisted `lastReactionAt`, reject more
  than one accepted reaction per player per 2,000 ms with `reaction_rate_limited`.
- [ ] For acceptance, increment revision, assert invariants, commit snapshot/events/token effects,
  replace manager state, then broadcast. Persist rejection before replying. On conflict reload and
  retry once through dedupe; uncertain storage errors never report success.
- [ ] Schedule/cancel derived host deadlines only from committed state.
- [ ] Log room ID, revision, principal scope, command type, outcome code, and duration through the
  injected logger. Never log command payloads or private snapshots.
- [ ] Run typecheck and lint; expect exit 0 and no engine/domain dependency violations.
- [ ] Review `git diff --check`; update plan/progress and commit
  `feat(server): orchestrate room commands`.

---

### [ ] R010: Implement room directory and HTTP routes

**Suggested implementer:** `gpt-5.6-terra`, high effort

**Files:**
- Create: `apps/server/src/rooms/room-directory.ts`
- Create: `apps/server/src/routes/rooms.ts`
- Modify: Hono route composition and dependency composition root

**Depends on:** R001, R005–R006, and R008–R009.

**Interfaces produced:**

```ts
export class RoomDirectory {
  create(input: CreateRoomRequest): Promise<CreateRoomResponse>;
  expire(now: number): Promise<RoomId[]>;
}
// POST /api/rooms
// POST /api/rooms/:code/join
// POST /api/rooms/:code/table
```

- [ ] Generate six-character uppercase room codes from letters/digits excluding `0/O/1/I` and
  retry at most 32 unique-code conflicts before returning `room_code_generation_failed`. Validate
  the fixed settings through the engine's config boundary,
  hash optional host/Table PINs, and create the unseated host, random first dealer, initial
  snapshot, first journal entry, and token atomically.
- [ ] Reject HTTP JSON bodies above 65,536 UTF-8 bytes before parsing. Parse all three requests
  with R001 Zod schemas before service entry. Compose services at startup rather than module
  import, and never put tokens in URLs/logs.
- [ ] Set `Cache-Control: no-store` on every create/join/Table response and credential failure so
  player and Table tokens or authentication results are never retained by browser/shared caches.
- [ ] Map absent room to 404, invalid settings/body to 400, full/name conflicts to 409, lockout to
  423, incorrect credentials to 401, oversized bodies to 413, and exhausted room-code generation
  to 503 without revealing another player's PIN configuration.
- [ ] Implement directory expiry delegation; actual periodic recovery/sweep wiring is R012.
- [ ] Run typecheck and lint; expect exit 0.
- [ ] Review `git diff --check`; update plan/progress and commit
  `feat(server): expose room HTTP API`.

---

### [ ] R011: Implement the authenticated room WebSocket edge

**Suggested implementer:** `gpt-5.6-sol`, high effort

**Files:**
- Create: `apps/server/src/ws/room-socket.ts`
- Modify: WebSocket route/composition file

**Depends on:** R001 and R006–R009.

**Interfaces produced:**

```ts
export function createRoomSocketHandler(dependencies: RoomSocketDependencies): WebSocketHandler;
```

- [ ] Before authentication, accept only one size-limited `hello`. Reject malformed JSON/schema,
  unknown/revoked tokens, commands-before-hello, and repeated hello with stable protocol errors.
- [ ] Authenticate and queue the connect transition, attach the hub socket, then send the complete
  `helloAccepted` view without replaying journal animations. Apply takeover ordering so the old
  close event cannot disconnect the new socket.
- [ ] Parse every command envelope with protocol Zod before queue entry. Pass authenticated
  principal and command ID separately from the command.
- [ ] On close, enqueue disconnect only when `ConnectionHub.detach` confirms this socket remained
  current. Keep Table disconnects out of player expiry/presence state.
- [ ] Run typecheck and lint; expect exit 0.
- [ ] Review `git diff --check`; update plan/progress and commit
  `feat(server): connect rooms over WebSocket`.

---

### [ ] R012: Implement startup recovery, expiry sweep, and shutdown

**Suggested implementer:** `gpt-5.6-sol`, high effort

**Files:**
- Modify: `apps/server/src/rooms/room-manager.ts`
- Modify: `apps/server/src/rooms/room-scheduler.ts`
- Modify: `apps/server/src/rooms/room-service.ts`
- Modify: server startup and graceful-shutdown composition

**Depends on:** R005 and R008–R011.

**Interfaces produced:**

```ts
export interface RoomRuntime {
  close(): Promise<void>;
}
export async function startRoomRuntime(dependencies: RoomRuntimeDependencies): Promise<RoomRuntime>;
```

- [ ] Capture injected `serverStartedAt` before accepting traffic. Mark apparent saved presence
  offline, preserving older `emptySince`; normalize all player presence when a room activates.
- [ ] Restore an offline host's deadline from saved disconnect time or startup fallback. Enqueue an
  elapsed deadline immediately.
- [ ] Schedule periodic expiry at 86,400,000 ms of no player connections. Table views do not clear
  expiry. Delete room/update/token records, send `room_expired`, and close remaining Table sockets.
- [ ] On shutdown stop acceptance and timers, enqueue current player disconnects, drain room
  queues/storage commits, close sockets, then storage within the existing bounded shutdown policy.
- [ ] Run typecheck and lint; expect exit 0.
- [ ] Review `git diff --check`; update plan/progress and commit
  `feat(server): recover and expire rooms`.

---

### [ ] R013: Implement the typed browser room client and Zustand store

**Suggested implementer:** `gpt-5.6-terra`, high effort

**Files:**
- Create: `apps/web/src/net/room-client.ts`
- Create: `apps/web/src/store/room-store.ts`
- Modify: existing browser reconnect/store composition

**Depends on:** R001 and R011 plus the skeleton web socket client.

**Interfaces produced:**

```ts
export interface RoomClient {
  connect(roomCode: RoomCode, token: string): void;
  disconnect(): void;
  send(commandId: string, command: RoomCommand): void;
  subscribe(listener: (message: ServerMessage) => void): () => void;
}
export interface RoomStoreState {
  status: "disconnected" | "connecting" | "synchronized" | "revoked";
  view: RoomView | null;
  pending: Record<string, RoomCommand>;
  send(command: RoomCommand): string;
}
```

- [ ] Store player and Table tokens separately under versioned
  `fiftysix.room-token.v1.<scope>.<ROOMCODE>` keys, send hello on every reconnect, replace full
  view on hello, and clear only the affected scope for removed/left/expired revocation.
- [ ] Generate one UUID per user intent, retain it until matching update/rejection, and resend the
  same envelope—not a new ID—after uncertain disconnect.
- [ ] Feed ordered update events plus resulting view to a typed animation callback. Do not build
  visual animations or screens in this task.
- [ ] Use type-only protocol imports and no runtime import from protocol, engine, or server.
- [ ] Run typecheck and lint; expect exit 0 and verify the web dependency boundary.
- [ ] Review `git diff --check`; update plan/progress and commit
  `feat(web): add room client state`.

---

### [ ] R014: Verify the integrated rooms subsystem and hand it off to U001

**Suggested implementer:** `gpt-5.6-sol`, high effort

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/rooms-subsystem-implementation-plan.md`
- Modify: `docs/implementation-progress.md`

**Depends on:** R001–R013 complete.

**Interfaces produced:** No new runtime interface. This task produces a verified build plus a
durable handoff to the next track.

```text
Required manual scenarios:
identity cap and normalized-name collision; seat contention; Ready automatic start;
disconnect and same-seat rejoin; PIN token rotation and takeover; PIN/Table lockout;
permanent Leave; replacement seat and Ready; host succession; Table redaction;
duplicate command ID; reaction allowlist/cooldown; automatic same-dealer redeal/restart;
restart recovery; simultaneous player/Table tabs; 24-hour expiry behavior.
```

- [ ] Run `nix develop -c pnpm typecheck`, `nix develop -c pnpm lint`, and
  `nix develop -c pnpm build`; require exit 0 for each.
- [ ] Run `nix build` and `nix flake check`; require exit 0 for each.
- [ ] Run `nix develop -c pnpm dev` and exercise every listed scenario with browser tabs and the
  HTTP/WebSocket flows. Record concise evidence in the progress ledger.
- [ ] Inspect logs using issued known tokens/PINs and hidden-card identifiers; require no secret or
  private-card occurrence and only the approved structured metadata.
- [ ] Update `AGENTS.md` from planned to actual layout/run behavior, mark this plan complete, set
  U001 as the next action, and run `git status --short` plus `git diff --check`.
- [ ] Commit the documentation/progress updates as `docs: complete rooms subsystem`, then stop and
  ask the user before starting the next track.
