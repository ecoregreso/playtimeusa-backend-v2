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
- **Ledger Entries**: Trace of all money movements

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
- `ledger_events` is the normalized event stream used by analytics
- `session_snapshots` is derived from ledger events for session-based metrics
- `api_error_events` tracks API error rates
- `game_configs` stores expected RTP per game

To add a new game to analytics:
1) Emit ledger events with `gameKey` on every bet/spin/win.
2) Add or update `game_configs` with the expected RTP.
