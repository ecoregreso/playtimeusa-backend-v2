# Playtime USA Backend v2

This is a clean Postgres/Sequelize backend skeleton for the Playtime USA funcoin casino engine.

## Stack

- Node.js + Express
- PostgreSQL
- Sequelize ORM
- JWT-based player auth

## Core Concepts

- **Tenants**: DEV / OPERATOR / AGENT
- **Wallets**: For tenants, players, and (later) jackpots
- **Vouchers**: Issued by agents, include a 50% bonus charged up front
- **Players**: Ephemeral accounts (loginCode + pin) created when vouchers are redeemed
- **Bonuses**: Trigger when player balance reaches 1.00 FUN (100 minor units)
- **Bets**: Simple RNG demo endpoint
- **Ledger Events**: Canonical telemetry stream (bets, wins, deposits, vouchers, errors)

## Quickstart (local)

```
npm i
npm run migrate
npm run dev
npm run staff:create -- admin YourPassword owner
curl -s http://localhost:3000/api/health
curl -s -X POST http://localhost:3000/api/v1/staff/login -H "Content-Type: application/json" -d '{"username":"x","password":"y"}'
```

Optional smoke check:
```
API_BASE=http://localhost:3000 ./scripts/smoke_api.sh
```

## Endpoints (v1)

Base path: `/api/v1`

- `POST /voucher/agents/:tenantId/vouchers` — issue voucher (agent)
- `POST /voucher/redeem` — redeem voucher, create player
- `POST /player/login` — login with player loginCode + pin
- `GET /player/me` — get player state (auth required)
- `POST /player/bonus/ack` — acknowledge bonus popup (auth required)
- `POST /bet/spin` — place a demo bet (auth required)

You will need to seed at least one AGENT tenant row and fund its wallet manually (or via future admin routes) to issue vouchers.

## Analytics & Operator Intelligence

Analytics endpoints are staff-protected (JWT) and accept:

Query params:
- `from` / `to` (ISO)
- `bucket` (`hour` | `day` | `week`, default `day`)
- `timezone` (IANA tz, default `America/Los_Angeles`)
- Optional filters: `agentId`, `cashierId`, `gameKey`, `provider`, `region`

Routes:
- `GET /api/v1/admin/analytics/overview`
- `GET /api/v1/admin/analytics/revenue`
- `GET /api/v1/admin/analytics/players`
- `GET /api/v1/admin/analytics/games`
- `GET /api/v1/admin/analytics/ops`
- `GET /api/v1/admin/analytics/funnel`
- `GET /api/v1/admin/analytics/ltv`
- `GET /api/v1/admin/analytics/attribution?metric=ngr`
- `GET /api/v1/admin/audit/run`

Metric definitions:
- **Handle**: total bet volume (cents)
- **Payout**: total wins paid (cents)
- **NGR**: handle - payout - bonuses
- **RTP**: wins / bets
- **LTV (operator)**: bets - wins

Data sources:
- `ledger_events` is the normalized event stream used by analytics and safety
- `session_snapshots` is derived from ledger events for session-based metrics
- `game_configs` stores expected RTP per game

To add a new game to analytics:
1) Emit ledger events with `gameKey` on every bet/spin/win.
2) Include a stable `actionId` (spin/round id) so events are idempotent.
3) Add or update `game_configs` with the expected RTP.

## Player Safety Engine (PSE)

PSE is a telemetry + risk scoring layer that does **not** affect game outcomes. Safety scoring
reads session activity from `ledger_events`; games may optionally call `/safety/event` for
advisory UI actions and set a loss limit at session start.

Player routes:
- `POST /api/v1/safety/loss-limit` — set a session loss limit
- `POST /api/v1/safety/event` — request advisory safety action (no ledger writes)

Example: set loss limit (once per session; can be lowered, never increased):
```
POST /api/v1/safety/loss-limit
Headers: Authorization: Bearer <player_access_token>
Headers: x-session-id: <session_id>
Body: { "lossLimitCents": 5000 }
```

Example response:
```
{ "ok": true, "lossLimitCents": 5000, "locked": true }
```

Example: request advisory safety action:
```
POST /api/v1/safety/event
Headers: Authorization: Bearer <player_access_token>
Headers: x-session-id: <session_id>
Body: {
  "gameKey": "neon-slot",
  "eventType": "SPIN"
}
```

Example responses:
```
// Nudge
{
  "ok": true,
  "risk": { "score": 35, "band": "ELEVATED", "reasons": ["BET_ACCEL"] },
  "action": { "actionType": "NUDGE", "message": "Quick check-in: your pace/bets changed a lot in the last few minutes. Want to take a short break?" }
}
```

```
// Cooldown
{
  "ok": true,
  "risk": { "score": 60, "band": "TILT_RISK", "reasons": ["LOSS_STREAK", "SPIN_RATE"] },
  "action": { "actionType": "COOLDOWN", "cooldownSeconds": 90, "message": "Let’s pause for 90s. Your balance and session will still be here." }
}
```

```
// Loss limit reached (enforced at bet/settlement)
{
  "ok": false,
  "code": "LOSS_LIMIT_REACHED",
  "message": "Loss limit reached for this session.",
  "action": { "actionType": "STOP" }
}
```

## Ledger Deduplication (one-time cleanup)

Run in order:
```
node scripts/dedupe_ledger_events.js
node scripts/rebuild_session_snapshots.js
```

## Tenant Isolation

Tenant isolation is enforced with Postgres RLS policies. See `docs/tenant-isolation.md` for
the table list, context rules, and test instructions.

## Scripts

- `npm run migrate` — apply SQL migrations
- `npm run test:rls` — run the tenant isolation integration test
- `npm run smoke` — run a minimal sanity check
- `npm run staff:create -- <username> <password> [role]` — create a staff user

## Changelog

- Enforced tenant isolation using `tenant_id` + RLS (owner override policy).
- Added tenant/distributor tables, tenant wallets, voucher pools, and credit ledger.
- Added migration runner + RLS integration test harness.
- Allowed owner staff accounts with `tenant_id` = NULL and owner login without tenant scoping.
- Dropped global ledger event uniqueness and extended RLS to legacy telemetry tables when present.
