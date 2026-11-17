# Implementation progress

This is the durable handoff for new chats. Keep it short. Detailed requirements live in specs and
implementation plans.

## Current state

| Track | Plan | Status | Current unit | Next action |
|---|---|---|---|---|
| Repository skeleton | `docs/repository-skeleton-implementation-plan.md` | Complete | S009 | Complete |
| Pure engine | `docs/game-engine-implementation-plan.md` | In progress | E007 | Await user approval before E008 |
| Rooms subsystem | `docs/rooms-subsystem-implementation-plan.md` | Plan approved; engine prerequisite missing | — | Execute R001 after engine is complete |
| UI and visual design | `docs/ui-visual-implementation-plan.md` | Plan approved; prerequisites missing | — | Execute U001 after skeleton, engine and rooms are complete |

## Last completed unit

E007 — Implement card play, hidden-trump reveal, and disqualification — implementation commit
`feat(engine): implement card play and trump reveal`.

- Added `play.ts` (`legalCards`, `roundWinner`, `decidePlayAction`, `countingTrumpSuit`, and the
  `cardPlayed`/`roundWon`/`disqualified` evolvers); `hidden-trump.ts` gained `revealBlocker` and
  the `revealAsked`/`trumpRevealed` evolvers; `scoring.ts` gained `scorePlayedOutMatch`.
- User decisions on 2026-11-17: (1) `roundWinner(round, contract, trumpRevealed)` takes a third
  argument, because a `CurrentRound` alone can't tell whether a 28 hidden trump counts after the
  reveal round (plan E007 interfaces updated). (2) **Rule clarification:** the Auto-stop
  `didNotPlayFaceDown` disqualification implicitly discloses that the led suit was trump; this is
  an accepted exception to the omission rule (rules.md §10.3, engine spec §9.4/§10.3, design §11).
- Event orders: play → `cardPlayed`, `[roundWon]`, after the last round `matchEnded(made/failed)`
  and `[sessionEnded]`; forced face-down → `trumpRevealed`, `cardPlayed(fromFaceDown)`; reveal →
  `revealAsked`, `trumpRevealed`; Auto-stop → play/reveal events, `disqualified`,
  `matchEnded(disqualified)`, `[sessionEnded]`, never `roundWon`. Block mode rejects
  `illegalPlay {kind}`. Non-forced face-down play → `faceDownNotPlayable` (owner) or
  `cardNotInHand` (others). Rejection order: surrender vote, `notYourTurn`, card/reveal checks.
- Auto-stop scoring applies the emitted events inside `decide` through a local evolver switch in
  `play.ts` (avoids an import cycle with `engine.ts`), then calls `scoreMatch`.
- Notes for E008: after the final `roundWon`, `currentRound` is null while the phase is still
  `play` until the following `matchEnded` (transient, inside one action); the after-round
  certainty/surrender hook goes right after `roundWon` in `completePlay` (marked by a comment).
- Invariants intentionally not added: stored round winner == `roundWinner`, and `trumpPlayed`
  consistency; E006's `scoring.test.ts` `withRounds` builds rounds with fake winners. Add them if
  that helper is rewritten to play legally.
- E005 carry-over nits (`invariants.ts` empty face-down slot in `28-second`; two expressions of the
  28 bid limit) and E006 nits remain open.
- One Opus implementer and one Opus reviewer; one correction round (plan/doc updates, fixed
  last-round "failed" test, `revealBlocker` `"notInPlay"` reason); reviewer approved.
- 172 tests (31 new).
- Verification on 2026-11-17: `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` (172/172),
  `git diff --check`, and the zero-dependency manifest check all passed.
- Next unit: E008, Implement result certainty and surrender voting, after user approval.

## Previously completed unit

E006 — Implement scoring, host resolutions, and session transitions — implementation commit
`feat(engine): score matches and sessions`.

- Added `scoring.ts` (`scoreMatch`, `matchSummary`, `summaryContract`) and `host-actions.ts`
  (`decideHostAction`); `session.ts` gained `decideSessionAction` and the `matchEnded`,
  `sessionEnded`, `nextMatchStarted` and `sessionRestarted` evolvers.
- Payer selection follows design §10.3 for all five scored outcomes. `outcome.surrendered.team`
  is the **surrendering (losing)** team; `outcome.awarded.team` is the **winning** team named by
  the host — opposite polarities on identically shaped variants, now documented in `state.ts` and
  `events.ts` so E008's surrender producer can't invert one. Stake is the tier's win/loss stake
  times `contract.multiplier`; `transferTokens` caps a payment at what the payer owns, and the
  summary records actual movement plus running balances.
- `matchSummary` is the single construction site for every outcome, and always projects through
  `summaryContract`, which erases an unrevealed 28 trump to `{type:"hidden"}`. The earlier
  duplicate summary builders in `deal.ts`/`redeal.ts` were deleted. A `summaryLeaksHiddenTrump`
  invariant plus tests guard the erasure.
- `matchLog` gets scored outcomes, every host restart, and 28 redeals; 56 automatic redeals are
  not appended. `matchEnded` is emitted for every result so transient presentation stays possible.
- Session flow: scored match → `sessionOver` + `sessionEnded` when either team hits 0, else
  `matchOver`; `startNextMatch` only from `matchOver` with the dealer rotating counter-clockwise;
  `restartSession(firstDealer)` only from `sessionOver`, archiving winner and final tokens into
  `pastSessions` and resetting balances and log.
- Review (Opus, full diff against the specs) returned **no blocking findings**. Three of its nits
  were applied: a missing phase guard on the `matchEnded(redealt)` evolver (§13.1 — it was the
  only branch that could silently rewrite the phase), the team-polarity doc comments above, and
  phase-mismatch throw tests for the three session evolvers. Fixing the guard exposed an existing
  test that applied `matchEnded(redealt)` from `awaitingDeal`, an unreachable sequence; it now
  deals first (56 in one stage, 28 in two) and a companion test pins the throw.
- Non-blocking nits left for later: `checkFinishedMatchSummary` (`invariants.ts` ~147) compares
  the phase summary to the last log entry with key-order-sensitive `JSON.stringify`, safe only
  while both are the same object; the per-action replay assertion in `scoring.test.ts` `run()` is
  tautological (real replay coverage is the `E006 replay and immutability` block).
- **E005 carry-overs still open:** `invariants.ts` (~404) doesn't detect an empty face-down slot
  in `28-second` after a non-pass call, and `deal.ts` (~272) and `invariants.ts` (~367) express
  the 28 bid limit two different ways.
- This unit was implemented in a session that was interrupted before review; a later session
  re-ran verification, obtained the review, applied the nits, and committed.
- 141 tests (35 new): every payer row × ×1/×2/×4, extra tiers, capped payment, both session
  winners, hidden-trump erasure, restart in each eligible phase, award availability, dealer
  rotation for 4/6/8 players, session archival across two sessions, invalid system phase,
  evolver phase mismatches, invariants, and JSON replay.
- Verification on 2026-09-15: `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` (141/141),
  `git diff --check`, and the zero-dependency manifest check all passed.
- Next unit: E007, Implement card play, hidden-trump reveal, and disqualification, after user
  approval.

## Implementation readiness

Full rules, product, architecture, engine, rooms, UI, security, responsive, accessibility,
deployment, and cross-plan review completed on 2026-09-14.

| Check | Result |
|---|---|
| Authoritative design coverage | Approved: `rules.md`, `design.md`, and all four subsystem designs |
| Sequential implementation plans | Approved: S001–S009, E001–E010, R001–R014, U001–U028 |
| Cross-track order | Skeleton → engine → rooms → UI/debug |
| First executable unit | S001 |
| Unresolved product or rules decisions | 0 |
| Placeholder/TBD requirements | 0 |
| Current stable toolchain probe | NixOS 26.05: Node 24.19.0, pnpm 11.25.0, Biome 2.4.15, SQLite 3.51.2 |

Implementation remains strictly unit-by-unit. A completed unit updates its plan checkbox and this
ledger in the same commit, then stops for user approval before the next unit.

## Handoff procedure

1. Read `AGENTS.md`.
2. Read this file.
3. Read the relevant design spec.
4. Read only the current plan unit and the units named in its `Depends on` field.
5. Dispatch the unit to its suggested implementation agent and keep that agent available.
6. Dispatch review to a Claude Opus or GPT Sol review agent; reuse both agents for every
   correction and re-review, then run the unit's verification commands in the main session.
7. Mark the unit complete here and in its plan, record the commit, and name the next unit.
