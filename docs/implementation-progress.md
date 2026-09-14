# Implementation progress

This is the durable handoff for new chats. Keep it short. Detailed requirements live in specs and
implementation plans.

## Current state

| Track | Plan | Status | Current unit | Next action |
|---|---|---|---|---|
| Repository skeleton | `docs/repository-skeleton-implementation-plan.md` | Complete | S009 | Complete |
| Pure engine | `docs/game-engine-implementation-plan.md` | In progress | E001 | Await user approval before E002 |
| Rooms subsystem | `docs/rooms-subsystem-implementation-plan.md` | Plan approved; engine prerequisite missing | — | Execute R001 after engine is complete |
| UI and visual design | `docs/ui-visual-implementation-plan.md` | Plan approved; prerequisites missing | — | Execute U001 after skeleton, engine and rooms are complete |

## Last completed unit

E001 — Define cards, seats, configuration, and stakes — implementation commits
`feat(engine): add cards configuration and stakes` and
`fix(engine): reject unsupported team seats`.

- Added the dependency-free engine's card, config, seat, and stake foundations. Deterministic
  `tsx` checks covered all six valid deck/config variants, exact point totals and identities,
  23 invalid configs, seat order and bounds, stake lookup and multipliers, affordability, capped
  token transfer, and input immutability.
- Independent review found `teamOf` accepted universally unsupported seat indices. Fix round 1
  added the upper bound, its focused boundary harness passed, and scoped re-review found no new
  breakage.
- Primary verification on 2026-09-14: deterministic harnesses, `pnpm typecheck`, `pnpm lint`,
  `pnpm build`, `git diff --check`, and the dependency/import audit all passed. The engine manifest
  has no dependencies and its source imports remain package-local.
- Deferred minor for the whole-engine review: exported card lookup constants are TypeScript
  readonly but are not frozen at runtime.
- Next unit: E002, Establish actions, events, state, and the transition kernel, after user
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
5. Dispatch the unit to the plan's suggested fresh subagent.
6. Review the diff and run the unit's verification commands in the primary session.
7. Mark the unit complete here and in its plan, record the commit, and name the next unit.
