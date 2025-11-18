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
