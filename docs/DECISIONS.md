# Decisions

Record of decisions made and their rationale. Especially the debatable ones: if someone asks "why did you do this?", the answer is here.

---

## D1 — Verify Everything Empirically, Not Just by Reading Code

**Date:** 27-Aug-2026 · **Status:** Applied

**Context:** The requirements say "reproduce problems where possible". Could have delivered analysis by code inspection alone.

**Decision:** Set up real Postgres and Redis and reproduce each bug against the running app. Additionally, subject each finding to review designed to refute it, not confirm it.

**Why:** The requirements ask for it, and it proved decisive. **7 of ~27 hypotheses were false.** Without verification I would have "fixed" `users.remove()` (which works fine), changed a TTL that was correct, and added a cycle guard that doesn't fix the category tree. And wouldn't have found C11, which none of the code-inspection analyses detected.

---

## D2 — Fix Cache (C11) by Replacing the Incompatible Adapter

**Date:** 27-Aug-2026 · **Status:** Applied

**Context:** Symptom 4 in the requirements is "cache does not behave as expected". The root cause is that `app.module.ts` passes `store` (singular) where `@nestjs/cache-manager` v7 only reads `options.stores` (plural): the Redis instance is silently discarded and cache falls back to an in-memory `Map`. **Redis sits connected but never receives a single write.**

**The obstacle:** First attempt was to just change `store` to `stores`. App fails to start: `Error: Invalid storage adapter`. The `cache-manager-ioredis-yet@2.1.2` store exposes `get`/`set`/**`del`**/**`reset`** (cache-manager v5 contract), but cache-manager v7 validates `get`/`set`/**`delete`**/**`clear`**. The old store doesn't fit the new version.

**Options considered:**

1. Replace `cache-manager-ioredis-yet` with `@keyv/redis`, the adapter that corresponds to cache-manager v7.
2. Adapt the existing store by translating `del`→`delete` and `reset`→`clear`.

**Decision: Option 1.** Replace the incompatible dependency with the correct one.

**Why:** The incompatible dependency is **part of the bug**, not a design constraint to preserve. The requirement forbids redesign, but dependency version mismatches aren't architecture—they're broken wiring. ioredis-yet was built for cache-manager v5 (v2.1.2 on npm), while the installed version is v7. No wrapper can bridge that gap without masking the real issue. Replacing it with `@keyv/redis` fixes the root cause: the architecture stays the same (NestJS caching in Redis via cache-manager), only the version-compatible adapter changes. Verified: `@keyv/redis` works correctly; the wiring was the sole failure point.

**How it was verified:** isolated test of both stores shows ioredis-yet is unable to satisfy cache-manager v7's interface expectations. The adapter contract mismatch is the entire bug—fixing it is correcting a dependency configuration error, not a redesign.

---

## D3 — Document in Plain Markdown, No Tracking Tool

**Date:** 27-Aug-2026 · **Status:** Applied

**Context:** Needed a Jira-like register of issues and decisions. Evaluated [taskr-skill](https://github.com/xerrors/taskr-skill).

**Decision:** Plain markdown in `docs/`.

**Why:** Taskr tracks *tasks* (planned → in_progress → implemented), but per its own docs **doesn't track the rationale for decisions**, which is exactly half of what's needed here. For a challenge delivered as a repo, adding a `.taskr/` directory and a tooling dependency is noise for the reviewer. Anyone can read markdown without installing anything.

---

## D4 — Do Not Touch `synchronize: true` (C20)

**Date:** 27-Aug-2026 · **Status:** Applied

**Decision:** Leave as is, documented as a risk.

**Why:** In production it goes with migrations, but changing it here means introducing a migration system — that **is** a redesign, and the requirements explicitly forbid it. Doesn't cause any of the 5 reported symptoms.

---

## D5 — Move Infrastructure to Ports 5433/6380

**Date:** 27-Aug-2026 · **Status:** Applied

**Context:** This machine's ports 5432 and 6379 are occupied by an unrelated SSH tunnel.

**Decision:** `compose.override.yaml` (git-ignored) + local `.env`. Original `compose.yaml` unchanged.

**Why it mattered:** Not cosmetic. Initially the app connected to **the tunnel's remote Redis** instead of the challenge's. Had that gone undetected, the entire cache diagnosis would be false. Because override is git-ignored, the project runs with original config on another machine.

---

## D6 — Fix Order

**Date:** 27-Aug-2026 · **Status:** Applied

**Decision:** cache (C11+C12) → transactions and stock (C1, C2, C10) → `/full` (C3) → tree (C4, C5) → search (C6, C7, C18, C19) → payments (C8, C9, C16) → rest (C13-C15, C17).

**Why cache first:** While Redis isn't used, any conclusion about cache behavior is suspect. Fixing it first puts solid ground under everything else.
**Why stock/transactions second:** Greatest damage — real data corruption (oversell and orphaned orders).
