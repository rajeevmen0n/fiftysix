# Implementation progress

This is the durable handoff for new chats. Keep it short. Detailed requirements live in specs and
implementation plans.

## Current state

| Track | Plan | Status | Current unit | Next action |
|---|---|---|---|---|
| Repository skeleton | `docs/repository-skeleton-implementation-plan.md` | Plan approved; ready | — | Execute S001 |
| Pure engine | `docs/game-engine-implementation-plan.md` | Plan approved; prerequisites missing | — | Execute E001 after skeleton is complete |
| Rooms subsystem | `docs/rooms-subsystem-implementation-plan.md` | Planned; prerequisites missing | — | Execute R001 after skeleton and engine are complete |
| UI and visual design | Not written | Design approved; planning deferred | — | Write the UI plan after the skeleton and engine plans |

## Last completed unit

None. No application code exists yet.

## Handoff procedure

1. Read `AGENTS.md`.
2. Read this file.
3. Read the relevant design spec.
4. Read only the current plan unit and the units named in its `Depends on` field.
5. Dispatch the unit to the plan's suggested fresh subagent.
6. Review the diff and run the unit's verification commands in the primary session.
7. Mark the unit complete here and in its plan, record the commit, and name the next unit.
