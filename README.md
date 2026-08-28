# Product Engineer Challenge

A multi-service e-commerce API (NestJS + PostgreSQL + Redis + TypeORM) shipped with
deliberately seeded bugs. The task was to find the root causes and fix them, without
adding features or redesigning the system.

## What was found

27 hypotheses were raised during the investigation: **20 were real bugs, 7 were false
alarms**. Everything marked confirmed was reproduced against the running application,
not just read in the code.

The headline finding: **Redis was never used**. `CacheModule` received the store under
`store` (singular) where `@nestjs/cache-manager` v3 only reads `stores` (plural), so the
option was silently dropped and the cache ran in memory the whole time — with Redis
connected and idle.

## The fixes

| PR | Area | Issues |
|---|---|---|
| [#1](../../pull/1) | Cache never reached Redis; ~65 s hangs when Redis was down | C11, C12 |
| [#2](../../pull/2) | Stock oversell, no transaction, double restock on cancel | C1, C2, C10, C19 |
| [#3](../../pull/3) | Full order detail built a circular reference | C3 |
| [#4](../../pull/4) | Category tree broke past level 2; no cycle guard | C4, C5 |
| [#5](../../pull/5) | One cache key for every search; nothing invalidated it | C6, C7, C18 |
| [#6](../../pull/6) | Double charge on payment; 1000 retries with no backoff | C8, C9, C16 |
| [#7](../../pull/7) | Decimals as strings, swallowed batch errors, no DTO whitelist | C13, C14, C15, C17 |

Full write-up in [`docs/`](docs/): every problem with its repro and fix in
[`docs/PROBLEMS.md`](docs/PROBLEMS.md), the debatable calls in
[`docs/DECISIONS.md`](docs/DECISIONS.md).

## Verifying the fixes

With the stack up (`docker compose up -d && pnpm install && pnpm run start:dev`):

```bash
# C13 — decimals come back as numbers, not strings
curl -s localhost:3000/orders/2/full | jq '.total, .items[0].product.price'

# C15 — properties not declared in the DTO are rejected
curl -s -X POST localhost:3000/users -H 'Content-Type: application/json' \
  -d '{"email":"a@b.com","name":"Ann","isAdmin":true}'
# -> 400 "property isAdmin should not exist"

# C14 — a failing batch names the ids that failed instead of reporting success
curl -s -X POST localhost:3000/products/batch -H 'Content-Type: application/json' \
  -d '{"productIds":[1,99999]}'
# -> {"success":false,"processed":1,"failed":[99999]}

# C6 — each search term gets its own cache entry
curl -s 'localhost:3000/products/search?q=laptop'  | jq -r '.[].name'
curl -s 'localhost:3000/products/search?q=zapatos' | jq -r '.[].name'
# before: the second query returned the first one's results, because every
# search was cached under the same key

# C8 — paying the same order twice charges once
ORDER=$(curl -s -X POST localhost:3000/orders -H 'Content-Type: application/json' \
  -d '{"userId":1,"items":[{"productId":1,"quantity":1}]}' | jq -r .id)
curl -s -X POST localhost:3000/orders/$ORDER/pay   # 201 + transactionId
curl -s -X POST localhost:3000/orders/$ORDER/pay   # 400, no second charge

# C1 — concurrent orders cannot oversell.
# Reset stock to 10 first (the run consumes it):
docker exec challenge-db psql -U postgres -d challengedb \
  -c "update products set stock = 10 where id = 1;"

# Then fire 4 concurrent orders of 3 units each — 12 units against 10 in stock:
for i in $(seq 1 4); do
  curl -s -o /dev/null -w "%{http_code} " -X POST localhost:3000/orders \
    -H 'Content-Type: application/json' \
    -d '{"userId":1,"items":[{"productId":1,"quantity":3}]}' &
done; wait; echo

# -> three 201s and one 400 (the order they print varies), stock left at 1:
docker exec challenge-db psql -U postgres -d challengedb \
  -c "select stock from products where id = 1;"
# Before the fix all four succeeded and stock went negative.
```

Each problem's original reproduction is in [`docs/PROBLEMS.md`](docs/PROBLEMS.md).

## What was deliberately left alone

- **Pagination** on `findAll()` — adding `?page=&limit=` is a new feature, and a hard cap
  would silently turn "all" into "some". Removing the redundant `eager` relations is the
  in-scope mitigation.
- **`synchronize: true`** (C20) — switching it off requires migrations, which is a redesign.
- **`updateStock()`** — pre-existing public API left without callers by #2. Deleting it
  changes the service's surface; it carries a comment pointing at the atomic methods.

---

## Original challenge README

Everything below is the brief as delivered, kept for reference.

A multi-service e-commerce API built with NestJS, PostgreSQL, and Redis.

## Architecture

This application uses:
- **NestJS** - Backend framework
- **PostgreSQL** - Primary database
- **Redis** - Caching layer
- **TypeORM** - Database ORM

## Setup

### Prerequisites

- Node.js 20+
- pnpm
- Docker and Docker Compose

### Installation

```bash
pnpm install
```

### Create environment file

```bash
cp .env.sample .env
```

### Start services

```bash
docker-compose up -d
```

### Run the application

```bash
pnpm run start:dev
```

The API will be available at `http://localhost:3000`

## API Endpoints

### Users

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /users | Get all users |
| GET | /users/:id | Get user by ID |
| POST | /users | Create a user |
| DELETE | /users/:id | Delete a user |

### Products

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /products | Get all products |
| GET | /products/:id | Get product by ID |
| GET | /products/search?q=term | Search products |
| POST | /products | Create a product |
| POST | /products/batch | Process batch of products |
| DELETE | /products/:id | Delete a product |

### Categories

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /categories | Get all categories |
| GET | /categories/:id | Get category by ID |
| GET | /categories/:id/tree | Get category tree |
| POST | /categories | Create a category |

### Orders

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /orders | Get all orders |
| GET | /orders?userId=1 | Get orders by user |
| GET | /orders/:id | Get order by ID |
| GET | /orders/:id/full | Get order with full details |
| POST | /orders | Create an order |
| POST | /orders/:id/pay | Process payment for order |
| PATCH | /orders/:id/status | Update order status |
| POST | /orders/:id/cancel | Cancel an order |

## Data Models

### User

| Field | Type | Description |
|-------|------|-------------|
| id | number | Unique identifier |
| email | string | User email (unique) |
| name | string | User name |
| isActive | boolean | Account status |
| createdAt | Date | Creation timestamp |

### Product

| Field | Type | Description |
|-------|------|-------------|
| id | number | Unique identifier |
| name | string | Product name |
| description | string | Product description |
| price | decimal | Product price |
| stock | number | Available stock |
| isAvailable | boolean | Availability status |
| categoryId | number | Category reference |

### Category

| Field | Type | Description |
|-------|------|-------------|
| id | number | Unique identifier |
| name | string | Category name |
| description | string | Category description |
| parentId | number | Parent category (for hierarchy) |

### Order

| Field | Type | Description |
|-------|------|-------------|
| id | number | Unique identifier |
| status | enum | pending, confirmed, shipped, delivered, cancelled |
| total | decimal | Order total |
| userId | number | User reference |
| items | array | Order items |
| createdAt | Date | Creation timestamp |

## Features

- **Caching**: Redis caching for improved performance
- **Validation**: Request validation using class-validator
- **Relations**: Complex entity relationships
- **Batch Processing**: Bulk operations support
- **Payment Processing**: Simulated payment with retry logic

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| PORT | Application port | 3000 |
| DB_HOST | PostgreSQL host | localhost |
| DB_PORT | PostgreSQL port | 5432 |
| DB_USER | PostgreSQL user | postgres |
| DB_PASSWORD | PostgreSQL password | postgres |
| DB_NAME | Database name | challengedb |
| REDIS_HOST | Redis host | localhost |
| REDIS_PORT | Redis port | 6379 |
| REDIS_DB | Redis database number | 1 |
