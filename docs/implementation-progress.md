# Implementation progress

This is the durable handoff for new chats. Keep it short. Detailed requirements live in specs and
implementation plans.

## Current state

| Track | Plan | Status | Current unit | Next action |
|---|---|---|---|---|
| Repository skeleton | `docs/repository-skeleton-implementation-plan.md` | Complete | S009 | Await user approval before E001 |
| Pure engine | `docs/game-engine-implementation-plan.md` | Ready | E001 | Execute E001 after user approval |
| Rooms subsystem | `docs/rooms-subsystem-implementation-plan.md` | Plan approved; engine prerequisite missing | — | Execute R001 after engine is complete |
| UI and visual design | `docs/ui-visual-implementation-plan.md` | Plan approved; prerequisites missing | — | Execute U001 after skeleton, engine and rooms are complete |

## Last completed unit

S009 — Verify the integrated skeleton and hand off to engine implementation — this unit commit
(`docs: complete repository skeleton`).

- Workspace verification: `pnpm build`, the final direct `pnpm typecheck` and `pnpm lint`,
  `nix build`, and `nix flake check` succeeded on 2026-09-14. Flake evaluation returned package
  derivations for exactly `aarch64-darwin`, `aarch64-linux`, and `x86_64-linux`; the host native
  addon links to nixpkgs SQLite 3.51.2.
- Runtime smoke: focused `tsx` harnesses covered configuration, first/idempotent migrations,
  healthy/failed storage, and browser reconnect. The packaged server covered static assets, SPA
  fallback, `/healthz`, reserved `/debug`, every bootstrap WebSocket rejection, token-safe logs,
  and clean SIGTERM with an open socket, all against an explicit removed-after-use temporary DB.
- Deployment and boundaries: the unchanged S008 NixOS evaluations cover disabled/default/custom,
  firewall, credential, and hardening variants. A complete-tree `rg` audit found no dependency,
  ambient-input, UI-string, secret, migration, fake-hash, or generated-artifact violations;
  `git diff --check` also succeeded.
- Next unit: E001, Define cards, seats, configuration, and stakes, after user approval.

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
