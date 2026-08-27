# Findings — Product Engineer Challenge

Investigation was conducted by area (orders / products / users+infra) and each hypothesis was then subjected to review designed to refute it. Everything marked CONFIRMED was reproduced against the running application (real NestJS + Postgres 17 + Redis 7), not just by code inspection.

Baseline unmodified: commit `055fade`. See `DECISIONS.md` for the rationale behind each decision.

## Test Environment

The host's ports 5432 and 6379 are occupied by an SSH tunnel unrelated to the challenge. Infrastructure was moved to **5433 / 6380** via `compose.override.yaml` (git-ignored) + `.env`. This mattered: initially the app connected to the remote Redis via the tunnel, which would have invalidated the entire cache diagnosis.

---

## CONFIRMED — To Fix

### C1. Stock Oversell via Lost Update — CRITICAL
`src/orders/orders.service.ts:89` · `src/products/products.service.ts:41-45`

Two defects that combine:
1. `this.productsService.updateStock(...)` is called **without `await`** (floating promise).
2. `updateStock` does read-modify-write with an **absolute value** (`product.stock = quantity`) computed from a stale read, instead of an atomic decrement in the DB.

Repro A: stock 5, 4 concurrent orders of 3 units → **all 4 return 201**, final stock 2. Sold 12 units from 5.
Repro B: stock 100, 10 concurrent orders of 1 → final stock **99**. Lost 9 of 10 decrements.

Fix: `UPDATE products SET stock = stock - :qty WHERE id = :id AND stock >= :qty` verifying affected rows, within C2's transaction. And add the `await`.

### C2. `create()` Without Transaction Leaves Corrupt Data — CRITICAL
`src/orders/orders.service.ts:63-96`

Order, each `order_item`, and each stock update are committed separately. If a later item fails stock validation, what came before is already persisted.

Repro: product A stock=100, product B stock=1. `POST /orders` with `[{A, qty:2}, {B, qty:999}]` → HTTP **400**, but in the DB: orphaned order (`total = 0.00`), A's `order_item`, and A's stock dropped to 98. Permanent.

Fix: wrap the entire body in `dataSource.transaction(...)`.

### C3. `GET /orders/:id/full` Broken 100% of the Time — CRITICAL
`src/orders/orders.service.ts:142-157`

Code manually builds a circular reference (`enriched.user.latestOrder = enriched`) and then passes it through `JSON.parse(JSON.stringify(...))`.

Repro: any call → 500. Log: `TypeError: Converting circular structure to JSON`.

Fix: don't create the cycle. Also, `JSON.parse(JSON.stringify())` is unnecessary — Nest already serializes the return.

### C4. `GET /categories/:id/tree` Broken with Normal Data — CRITICAL
`src/products/products.service.ts:94-110` (crashes at :96, recurses at :102)

**Initial diagnosis was wrong**: not infinite recursion. `findCategory` loads `parent` one level only; when recursing on `category.parent`, the next level has `parent === undefined` and line 96 fails reading `.id`.

Repro: normal 3-level hierarchy (Electronics > Laptops > Gaming). `/categories/3/tree` → 500, and `/categories/1/tree` → 500. With 2 levels it worked by accident.
Log: `TypeError: Cannot read properties of undefined (reading 'id')` with stack in `buildCategoryTree`.

Fix: don't recurse upward on an unloaded relation — explicitly load ancestors or traverse a single direction. Add cycle guard (see C5).

### C5. Cycle in Categories → 500 — MEDIUM
`src/products/products.service.ts:94-110`

No `visited`-set or depth limit. With cyclic `parent_id` in DB (A→B, B→A), the endpoint returns 500. No validation prevents creating the cycle.

Repro: `UPDATE categories SET parent_id=2 WHERE id=1` (with 2 being a child of 1) → `/categories/2/tree` → 500.

Fix: `Set` of visited ids + validate `parentId` when creating category.

### C6. Poisoned Search Cache — CRITICAL
`src/products/products.service.ts:53`

`const cacheKey = 'product-search'` — constant, completely ignores the `query` parameter on which the entire result depends.

Repro: `?q=laptop` (returns Laptop) then `?q=zapatos` → **returns Laptop**.

Fix: include normalized query in the key.

### C7. Search Without Cache Invalidation — MEDIUM
`src/products/products.service.ts:36-50`

`create`, `updateStock`, and `remove` do not invalidate search cache.

Repro: search `?q=teclado` → 0 results. Create "Teclado mecanico" (201). Search again → **still 0**.

Fix: invalidate after each mutation (with versioned key or pattern deletion).

### C8. Double Charge — HIGH
`src/orders/orders.service.ts:104-124`

No state guard before charging.

Repro: `POST /orders/18/pay` → `TXN-1787850343999`, order becomes `confirmed`. Second `POST /orders/18/pay` → **201 with `TXN-1787850344542`**.

Fix: reject if status is not `PENDING`, and make the transition atomic (`UPDATE ... WHERE status='pending'`).

### C9. Retry Storm on Payments — HIGH
`src/orders/orders.service.ts:26,104-124`

`maxRetries = 1000`, fixed 100ms sleep, no backoff, no global timeout, and no distinction between transient and permanent errors (generic `catch`).

Worst-case analysis: 1000 × ~200ms ≈ **200 s** hanging the HTTP request.
Observed: 7 of 8 payments at ~0.11s; one that retried → **0.317s**, consistent with ~200ms per retry. (Worst case is analytical: the failure is random 10% and can't be forced without editing.)

Fix: 3-5 attempts, exponential backoff with jitter, global timeout, retry only transient errors.

### C10. `cancel()` Without Transaction or Atomicity — HIGH
`src/orders/orders.service.ts:126-140`

Same pattern as C1/C2. Happy path **does work** (verified: 2 items, both products restocked exactly, order → `cancelled`), but a failure mid-loop leaves some products restocked and others not, and order uncancelled. State is saved only after the loop.

Fix: transaction + atomic increment.

### C11. Redis Is Never Used: Cache is an In-Memory `Map` — CRITICAL
`src/app.module.ts:33`

**None of the 3 explorers detected this.** The factory returns `{ store: ... }` (singular), but `@nestjs/cache-manager` v3 only reads `options.stores` (**plural**). The option is silently discarded → `stores: undefined` → `createCache` falls back to `[keyv]` → default `Keyv` → in-process `Map`.

Evidence:
- `cache.providers.js` only inspects `options.stores`.
- `createCache({ttl:60000})` → `stores.length === 1`, type **`Map`**.
- After `FLUSHDB` on both DBs and 3 caching requests: **0 keys** in Redis.
- `SCAN` across 16 logical DBs (not just `KEYS`, in case there's a prefix): nothing from the app.
- `INFO commandstats`: `set`/`get` counters **don't move**. Zero writes (not "writes and expires").
- Yet cache **works**: insert a user via direct `psql` and `GET /users` still returns the old set → in-memory cache intercepting.
- `redisStore` in isolation (port 6380) **does** write and key appears in Redis → the failure is wiring, not Redis or the driver.

Consequences: cache doesn't share between instances, is lost on restart, and Redis runs unused. Root cause of the symptom "cache does not behave as expected".

Fix: `stores: [await redisStore({...})]`.

### C12. Hardcoded `db: 0` Ignores `REDIS_DB` — LOW (No Effect Today)
`src/app.module.ts:36`

`.env` defines `REDIS_DB=1` and is never read. **No observable impact while Redis isn't used** (C11); becomes important when fixing C11, so both are corrected together.

Fix: `db: parseInt(process.env.REDIS_DB || '0', 10)`.

### C13. Decimals Returned as Strings — MEDIUM
`src/products/product.entity.ts:16` · `src/orders/order.entity.ts:21` · `src/orders/order-item.entity.ts:27`

TypeORM `decimal` columns come back as text: API responds `price: "100.50"` and `total: "301.50"` where the declared type is `number`. Breaks the API contract.

Important nuance: **total calculation is NOT corrupted**. `total += product.price * qty` uses `*`, which coerces to number. Verified: `100.50*2 + 20*3` → `261.00`, exact. The risk is a future `+` (`0 + "100.50"` → `"0100.50"`).

Fix: `transformer: { to: v => v, from: v => parseFloat(v) }` on decimal columns.

### C14. Errors Swallowed in `processProductBatch` — MEDIUM
`src/products/products.service.ts:122-124`

`catch (error) { console.log('Error processing product'); }` — discards the error, doesn't say which id failed, and response reports `{success: true, processed: N}` without flagging failures.

Repro: `POST /products/batch` with `[1, 999, 2]` → `{success:true, processed:2}`, the 999 disappears silently. Symptom "vague or misleading messages".

Fix: log the real error and id; return failed ones with their reason.

### C15. `ValidationPipe` Without `whitelist` — MEDIUM
`src/main.ts:7`

Without `whitelist`/`forbidNonWhitelisted`, extra body fields reach `repository.create()`.
A client can attempt to set fields they don't control (`id`, `isActive`).

Fix: `new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })`.

### C16. Uninitialized `lastError` — LOW
`src/orders/orders.service.ts:107,123`

`let lastError: Error;` and `throw lastError!`. Today unreachable (`maxRetries=1000` guarantees an iteration), but if made configurable to 0 → `throw undefined` → opaque error. Resolved when fixing C9.

### C17. Eager Relations + `findAll()` Without Pagination — MEDIUM
`src/orders/order.entity.ts:24,31` · `src/orders/order-item.entity.ts:17` · `src/products/product.entity.ts:28`

`user`, `items`, `items.product`, and `product.category` are `eager: true`, and services *also* explicitly request the same `relations`. `GET /orders` loads the complete graph of all orders without pagination. `searchProducts` fetches the entire table with its category join.

Contributes to the symptom "extremely slow requests" as data grows.

Fix: remove `eager` and load explicitly where needed. Pagination is **not** added:
`?page=&limit=` is a new feature, and a hard cap would silently turn "all" into
"some" with no way to fetch the rest. Recommended for a follow-up cycle, out of
scope here.

### C18. `searchProducts` Filters in Memory — HIGH
`src/products/products.service.ts:59-63`

`productsRepository.find()` without `where`: fetches **entire** table and filters in JS with `includes()`.

Fix: filter in the DB with `ILike`.

### C19. Product Cache Not Invalidated from Orders — MEDIUM
`src/orders/orders.service.ts:35-36`

`cacheManager` is injected and **never used**. `create()` and `cancel()` change stock but don't invalidate the search cache, which embeds stock. Up to 60s serving stale stock.

Fix: invalidate after mutating stock (or centralize invalidation in `ProductsService`).

### C20. `synchronize: true` — LOW (Out of Scope)
`src/app.module.ts:28`

Risk of data loss on any entity change. Acceptable in a local challenge; in production it goes with migrations. **Not touched**: changing it exceeds "fixing the reported bugs".

---

## REFUTED — NOT Bugs

Reported by explorers and **disproven** with evidence. Do not fix.

### R1. `users.remove()` Broken by Cached Object — REFUTED
Initial reading flagged it as critical. Verified: `GET /users/8` (populates cache) → `DELETE /users/8` → **200**, and `SELECT` returns **0 rows**. Then `GET` → 404 correct. TypeORM only needs the PK for DELETE. At most, a code smell.

### R2. `createdAt` String vs `Date` After Cache — REFUTED (No Observable Impact)
In-memory type differs, but HTTP responses on cache-miss and cache-hit are **identical byte for byte**: Nest serializes Date to the same ISO string. No observable difference.

### R3. TTL in Wrong Units — REFUTED
`60000` is **milliseconds** = 60s, correct. Verified three ways: cache-manager v7 `.d.ts`, `cache-manager-ioredis-yet` using `'PX'` (ms) in Redis, and measuring actual TTL (exact 60000ms delta) plus observed expiration at ~71s.

### R4. Totals Corrupted by String Concatenation — REFUTED
`100.50*2 + 20*3` → `"261.00"`, arithmetically exact. `*` coerces before summing. String type in response is a contract issue (C13), but **doesn't corrupt the calculation**.

### R5. Infinite Recursion in Tree with Normal Data — REFUTED (Wrong Mechanism)
Initial hypothesis was infinite mutual recursion due to bidirectional relations. False: with 2 levels it returns **200**; TypeORM doesn't populate relations in both directions as assumed. Endpoint is broken, but due to unloaded `parent` (C4), not recursion.

### R6. Postgres and Redis on Separate Docker Networks — NOT a Bug
`backend` vs `cache-network` in `compose.yaml`. App runs on the host and reaches via published ports; they don't need to see each other. Red herring.

### R7. Route Shadowing in Products Controller — NOT a Bug
`@Get('search')` is declared **before** `@Get(':id')`, which is the correct order.
`/products/search` resolves fine. Already done right.

---

## Proposed Fix Order

1. **C11 + C12** — cache to Redis. Unblocks true diagnosis of all cache issues.
2. **C1 + C2 + C10** — transaction + atomic stock. Greatest damage (oversell, corruption).
3. **C3** — `/full` endpoint, always broken, trivial fix.
4. **C4 + C5** — category tree.
5. **C6 + C7 + C19 + C18** — search cache (key, invalidation) and DB filtering.
6. **C8 + C9 + C16** — payments: idempotence and retries.
7. **C13 + C14 + C15 + C17** — API contract, logging, validation, redundant eager relations.

Out of scope per explicit challenge instruction ("no new features and no redesign"):
C20, and any architecture change.
