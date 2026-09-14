# Implementation progress

This is the durable handoff for new chats. Keep it short. Detailed requirements live in specs and
implementation plans.

## Current state

| Track | Plan | Status | Current unit | Next action |
|---|---|---|---|---|
| Repository skeleton | `docs/repository-skeleton-implementation-plan.md` | In progress | S004 | Execute S004 after user approval |
| Pure engine | `docs/game-engine-implementation-plan.md` | Plan approved; prerequisites missing | — | Execute E001 after skeleton is complete |
| Rooms subsystem | `docs/rooms-subsystem-implementation-plan.md` | Plan approved; prerequisites missing | — | Execute R001 after skeleton and engine are complete |
| UI and visual design | `docs/ui-visual-implementation-plan.md` | Plan approved; prerequisites missing | — | Execute U001 after skeleton, engine and rooms are complete |

## Last completed unit

S003 — Add configuration and injected runtime primitives — this unit commit
(`feat(server): add runtime configuration`).

- Verification: one-off `tsx` assertions covered exact configuration defaults and overrides,
  invalid ports/origins/log levels, scheduler cancellation and closure, 1,000 bounded random
  integers, random bytes, the system clock, and distinct configured logger instances on
  2026-09-14.
- Repository checks: `nix develop -c pnpm typecheck`, `nix develop -c pnpm lint`,
  `nix develop -c pnpm build`, and `git diff --check` all exited 0.
- Boundary inspection: `Date.now`, `node:crypto` randomness, and timer calls occur only in runtime
  adapters; server source has no direct `process.env` access.
- Next unit: S004, Establish the swappable storage boundary and migration baseline.

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
