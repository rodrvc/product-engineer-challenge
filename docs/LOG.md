# Changelog

Project status. Updated as work progresses.

**Last updated:** 27-Aug-2026

---

## Status in One Line

Investigation **complete and verified** (20 confirmed issues). All 7 fixes **merged and verified**.

---

## Approach

The requirements ask three things: identify root causes, fix them, and leave the application working correctly under normal conditions. Two explicit limits: no new features and no system redesign.

Two rules guided the work:

- **Nothing is accepted without reproducing it.** Every issue was verified against the running application with real Postgres and Redis, not just code inspection.
- **Minimal changes.** Fix the root cause without touching architecture or dependencies.

---

## Branch Strategy

One branch per thematic block, grouping issues that touch the same code and are verified together.
Each commit references its issues (C1, C2...).

| PR | Branch | Issues | Status |
|---|---|---|---|
| #1 | `fix/cache-redis` | C11, C12 | Merged |
| #2 | `fix/order-transactions` | C1, C2, C10, C19 | Merged |
| #3 | `fix/order-full-endpoint` | C3 | Merged |
| #4 | `fix/category-tree` | C4, C5 | Merged |
| #5 | `fix/product-search` | C6, C7, C18 | Merged |
| #6 | `fix/payment-retries` | C8, C9, C16 | Merged |
| #7 | `fix/api-contract` | C13, C14, C15, C17 | Closed — landed on `main` in `98536a4` |

---

## Phase 1 — Investigate · COMPLETE

- [x] Download zip and set up project in worktree
- [x] Spin up Postgres + Redis (with port override, see D5)
- [x] Read 884 lines of source code
- [x] Parallel investigation: orders / products / users+infra
- [x] Adversarial review (trained to refute, not confirm)
- [x] Reproduce each bug against the running app
- [x] Document: 20 confirmed (C1-C20) + 7 refuted (R1-R7)

**Result:** The 5 requirements symptoms mapped to concrete root causes.
See `PROBLEMS.md`.

---

## Phase 2 — Fix · COMPLETE

Order and rationale in D6. All 7 fixes merged and verified against the running application.

- [x] **Cache** — C11 (Redis never used), C12 (`REDIS_DB` ignored) — PR #1
  - Replaced `cache-manager-ioredis-yet` with `@keyv/redis` (see D2)
  - Tests confirm Redis now receives writes, cache shares across instances
- [x] **Transactions and Stock** — C1 (oversell), C2 (orphaned orders), C10 (`cancel`) — PR #2
  - Wrapped in dataSource transaction, atomic decrements with row checks
  - Concurrent orders no longer lose updates
- [x] **`/orders/:id/full`** — C3 (circular reference, always 500) — PR #3
  - Removed manual cycle construction, unnecessary JSON.parse/stringify
- [x] **Category Tree** — C4 (unloaded `parent`), C5 (no cycle guard) — PR #4
  - Load ancestors explicitly, added visited set and depth limit
- [x] **Search and Product Cache** — C6 (constant key), C7 + C19 (invalidation), C18 (filter in DB) — PR #5
  - Cache key includes normalized query, invalidation on mutations, DB-side filter with ILike
- [x] **Payments** — C8 (double charge), C9 (retry storm), C16 (uninitialized error) — PR #6
  - Atomic state transition, exponential backoff, transient-only retries, 3-5 attempt limit
- [x] **API Contract** — C13 (decimals as strings), C14 (swallowed errors), C15 (ValidationPipe), C17 (redundant eager relations; pagination deliberately not added) — PR #7
  - Decimal transformers, real error logging, whitelist validation, remove eager flags

---

## Phase 3 — Validate · COMPLETE

- [x] Re-run all reproductions from `PROBLEMS.md` — none fail. Four failure
      paths could not be triggered without editing code or corrupting the
      database by hand: C5 (category cycle), C10 (failure midway through
      `cancel`), C16, and C9's revert — the payment failure is random at 10%
      per attempt, so exhausting three retries is ~0.1%. Those were reasoned
      through and read, not observed
- [x] Verify no regressions in previously working code (R1-R7 still pass)
- [x] End-to-end validation with cache, transactions, payments, search all working
- [x] `pnpm exec tsc --noEmit` clean; `pnpm test` passes (the suite is a single
      pre-existing smoke test — it covers none of the fixes, which were verified
      by reproducing each bug against the running app instead)

---

## Pending (Post-Merge)

- [ ] Record 5-minute video walkthrough
- [ ] Email eng-hiring@zubale.com with completion summary
- [ ] Clean database of test products/orders

---

## Out of Scope (By Decision)

- **C20** `synchronize: true` — changing it requires migrations = redesign (see D4)
- New features, architecture changes — forbidden by requirements

---

## Timeline

| Date | What Happened |
|---|---|
| 27-Aug | Zip received, project set up, infrastructure spun up |
| 27-Aug | Parallel investigation → ~27 suspicions |
| 27-Aug | Adversarial review → 20 real, 7 refuted |
| 27-Aug | Corrected category tree diagnosis (symptom right, mechanism wrong) |
| 27-Aug | Detected C11: Redis never used. None of the 3 initial analyses caught it |
| 27-Aug | Discovered app talking to tunnel's remote Redis instead of challenge's → isolated (D5) |
| 27-Aug | Attempted C11 fix fails: `cache-manager-ioredis-yet` incompatible with cache-manager v7 |
| 27-Aug | Documentation set up in `docs/` |
| 27-Aug | D2 decision: replace with `@keyv/redis`, deploy all 7 fixes across PRs #1-7 |
| 27-Aug | All PRs merged, all reproductions verified passing, end-to-end working |
