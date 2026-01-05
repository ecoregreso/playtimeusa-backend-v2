# Tenant Isolation (RLS)

This backend enforces hard multi-tenant isolation using Postgres Row Level Security (RLS).

## Why RLS
- Guards against missing tenant filters in application code.
- Prevents cross-tenant reads/writes at the database level.
- Supports owner-only cross-tenant visibility without weakening tenant routes.

## Tenant-Owned Tables
All tenant-owned tables include `tenant_id` and are protected by RLS policies:
- users, wallets, transactions, vouchers, game_rounds, sessions
- deposit_intents, withdrawal_intents
- ledger_events, session_snapshots
- game_configs, api_error_events, support_tickets
- player_safety_limits, player_safety_actions
- staff_users, staff_keys, staff_messages, staff_push_devices
- purchase_orders, purchase_order_messages
- tenant_wallets, tenant_voucher_pools, credit_ledger
- legacy: players, bets, bonuses, ledger_entries (if present)

## How Context Is Applied
Every tenant-scoped request runs inside a DB transaction and sets:
- `SET LOCAL app.tenant_id = <tenant uuid>`
- `SET LOCAL app.role = <role>`
- `SET LOCAL app.user_id = <user id>`

This is done by `initTenantContext` in `src/middleware/tenantContext.js`. All authenticated routes must use existing auth middleware, which initializes the tenant context.

## Owner Access
Owner requests are authenticated via staff tokens with role `owner`. RLS includes an owner override policy:
- `current_setting('app.role', true) = 'owner'`
Owner staff accounts may have `tenant_id` set to `NULL`.

Owner-only endpoints live under:
- `/api/v1/owner/*`

## Running RLS Test
Bring up Postgres, run migrations, and execute the integration test:
```
npm run test:rls
```

## Migrations
Run migrations explicitly (sync is disabled by default):
```
npm run migrate
```
