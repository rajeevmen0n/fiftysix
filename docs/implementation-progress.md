# Implementation progress

This is the durable handoff for new chats. Keep it short. Detailed requirements live in specs and
implementation plans.

## Current state

| Track | Plan | Status | Current unit | Next action |
|---|---|---|---|---|
| Repository skeleton | `docs/repository-skeleton-implementation-plan.md` | Complete | S009 | Complete |
| Pure engine | `docs/game-engine-implementation-plan.md` | In progress | E009 | Implement capabilities, views, and event redaction |
| Rooms subsystem | `docs/rooms-subsystem-implementation-plan.md` | Plan approved; engine prerequisite missing | — | Execute R001 after engine is complete |
| UI and visual design | `docs/ui-visual-implementation-plan.md` | Plan approved; prerequisites missing | — | Execute U001 after skeleton, engine and rooms are complete |

## Last completed unit

E008 — Implement result certainty and surrender voting — implementation commit
`feat(engine): implement result certainty and surrender voting`.

- Added `surrender.ts` (`losingTeamIfCertain`, `decideSurrenderAction`, internal helpers, and
  evolvers for the five surrender events); the certainty check runs in `play.ts` `completePlay`
  right after `roundWon`. `engine.ts` routes surrender actions/events; the `unsupportedAction` and
  `missingEvolver` placeholders were deleted.
- Certainty: defenders lost once bidding-team points reach the bid; bidding team lost once its
  points plus all uncollected points (56/28 minus collected) fall below the bid. `resultDecided`
  is emitted once, only with the surrender option on, and also after the final round (between
  `roundWon` and `matchEnded`, spec §9.6/§10.1; the UI may skip that notice).
- Votes: proposer counts as yes; passes at ⌊T/2⌋+1 (2/2, 2/3, 3/4); fails early when it can no
  longer pass. Orders: `surrenderVoted` → `[surrenderFailed]` or `surrendered`, `matchEnded`,
  `[sessionEnded]`. A failed vote sets `lastFailedRound`, lifted at the next round.
- No new rejection codes: `surrenderVoteRunning` for a losing-team proposal during a vote; other
  surrender rejections use `actionNotAllowed` with a `reason` (documented in spec §10.1). A
  winning-team proposal gets `resultNotDecided` (no vote) or `notOnLosingTeam` (vote running), so
  certainty never leaks.
- Invariant `invalidSurrender`: `decided === losingTeamIfCertain(state)`, vote well-formed,
  surrender state empty outside play or with the option off. Test fixtures that built impossible
  surrender states were rewritten to reach them legally (`scoring.test.ts` `buildRounds`/`withVote`).
- Still open: E007 note (round-winner/`trumpPlayed` invariants not added because `buildRounds`
  uses fake winners), E005/E006 nits.
- One Opus implementer and one Opus reviewer; one correction round (four non-blocking nits);
  reviewer approved.
- 198 tests (26 new).
- Verification on 2026-11-17: `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` (198/198),
  `git diff --check`, and the zero-dependency manifest check all passed.
- Next unit: E009, Implement capabilities, views, and event redaction (user authorized continuing
  without per-unit approval for this session).

## Previously completed unit

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
