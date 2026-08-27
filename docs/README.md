# What This Is (Read First)

**Technical Challenge — Product Engineer.**

## The Task, In One Line

An e-commerce API (NestJS + PostgreSQL + Redis + TypeORM) with bugs deliberately planted.
**Nothing to build**: find root causes and fix them.

The explicit request: investigate root causes → fix them → leave the app working correctly under normal conditions. Two hard constraints: **no new features and no system redesign**.

## The 5 Symptoms in the Requirements

1. Requests extremely slow or hanging indefinitely
2. Intermittent errors on certain flows
3. Data sometimes inconsistent or missing
4. Cache does not behave as expected
5. Failures with vague or misleading messages

## What's in This Folder

| File | Purpose |
|---|---|
| `README.md` | This summary. What the challenge is and where everything is. |
| `PROBLEMS.md` | The 20 confirmed issues (C1-C20) + 7 refuted hypotheses (R1-R7). Each with file:line, how to reproduce, and the fix. |
| `DECISIONS.md` | Decisions made and their rationale. Especially the debatable ones. |
| `LOG.md` | Current status: what's done, what's pending, in what order. |

## How to Start This

```bash
docker compose up -d      # postgres + redis
pnpm install
pnpm run start:dev        # http://localhost:3000
```

Note: on this machine, ports 5432 and 6379 are occupied by an SSH tunnel unrelated to this project.
A `compose.override.yaml` (git-ignored) moves the infrastructure to **5433/6380**, with the
`.env` adjusted accordingly. On another machine, it's not needed.

## The One-Sentence Summary

Of ~27 suspicions raised during investigation, **20 are real bugs and 7 were false alarms**.
The main finding: **Redis is never used** — the cache has been running in memory the entire time
because a key was `store` when it should be `stores`.
