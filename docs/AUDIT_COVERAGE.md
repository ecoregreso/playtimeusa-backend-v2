# Audit Coverage Report

This document inventories state-changing routes, current audit emissions, existing audit storage, and gaps.

## State-Changing Routes & Audit Emission

`/src/routes/auth.js`
- `POST /auth/register` (user create), `POST /auth/login` (player/admin), `POST /auth/admin/login`, `POST /auth/refresh`: **Audit:** only player login emits `recordLedgerEvent` (`eventType: LOGIN`, `source: auth.login`); registration/admin/staff logins have **no audit**.

`/src/routes/staffAuth.js`
- `POST /api/v1/staff/login`: staff session create. **Audit:** none.

`/src/routes/playerRoutes.js`
- `POST /api/v1/player/login` (voucher redeem + wallet credit): emits `LOGIN` ledger event and `VOUCHER_REDEEMED` ledger event.
- `POST /api/v1/player/bonus/ack`: clears bonus flags. **Audit:** none.

`/src/routes/vouchers.js` (staff voucher issue/redeem flows)
- Issue voucher (staff/cashier): emits `VOUCHER_ISSUED` ledger event with `actionId: voucher.id`.
- Redeem voucher via staff: emits `VOUCHER_REDEEMED` ledger event.

`/src/routes/finance.js`
- Mark deposit paid: wallet credit + transaction insert; emits `DEPOSIT` ledger event (`actionId: intent.id`, amountCents>0).
- Mark withdrawal sent: updates intent; emits `WITHDRAW` ledger event (`actionId: intent.id`, amountCents<0).

`/src/routes/wallets.js`
- Balance adjustments (credit/debit), transfers, and voucher wallet helpers. **Audit:** no ledger/audit emission.

`/src/routes/games.js`
- Spin settlement endpoints (bet/win): emit `SPIN`/`BET`/`WIN` ledger events with shared `actionId` (spin/round id).
- Failed bet resolution: emits `ERROR` ledger event when applicable.

`/src/routes/purchaseOrders.js`
- Create/update/approve/reject purchase orders, add messages. **Audit:** none (no ledger or audit log writes).

`/src/routes/adminPlayers.js`
- Create/update players, adjust balances, comp bonuses. **Audit:** none.

`/src/routes/adminStaff.js`
- Create/update staff users and permissions. **Audit:** none.

`/src/routes/safety.js` and `/src/routes/adminSafety.js`
- Safety limit/action creation. **Audit:** PlayerSafetyAction stored (see storage), but no ledger/audit event for limit set.

`/src/routes/ownerTenants.js`
- Create tenants/distributors; issue tenant credits; allocate voucher pool. **Audit:** writes `CreditLedger` for tenant credit/pool transfers; no ledger/audit event.

`/src/routes/staffMessages.js`, `staffPush.js`
- Message send/register/unregister devices. **Audit:** none.

`/src/routes/adminTransactions.js`, `adminSessions.js`, `adminReports.js`, `adminAnalytics.js`, `reports.js`, `adminAudit.js`
- Read-only reporting/analytics. **Audit:** none.

`/src/routes/reports.js`, `betRoutes.js`, `cashier.js`, `staffRoutes.js`, `staff.js` (legacy)
- Contain create/redeem voucher, bet logging, or staff ops. Most have **no audit emission** except voucher redeem in `cashier.js` (no ledger event).

## Audit Storage

`LedgerEvent` (table `ledger_events`):
- Fields: `id`, `tenantId`, `ts`, `playerId`, `sessionId`, `actionId`, `agentId`, `cashierId`, `gameKey`, `eventType`, `amountCents`, `betCents`, `winCents`, `balanceCents`, `source`, `meta`, timestamps. Unique `(tenantId, actionId, eventType)`.
- Used as canonical event stream and primary audit trail for login/bet/wallet flows where implemented.

`PlayerSafetyAction` (table `player_safety_actions`):
- Fields: `id`, `tenantId`, `playerId`, `sessionId`, `gameKey`, `actionType`, `reasonCodes`, `severity`, `details`, timestamps. Audit for safety governance actions only.

`CreditLedger` (table `credit_ledger`):
- Fields: `id`, `tenantId`, `actor_user_id`, `action_type`, `amount_cents`, `memo`, timestamps. Used for owner-issued tenant credit and voucher-pool allocations.

`PlayerSafetyLimit`, `SessionSnapshot`, `Voucher`, `Transaction`:
- Not audit logs but contain historical state that can be used for audit reconstruction (balance changes, voucher issuance/redemption, session stats).

No dedicated “audit events” table exists; admin audit endpoint derives events on demand from `Transaction`, `Voucher`, and `GameRound`.

## Gaps & Missing Coverage

- **401/403 and validation failures**: No audit/ledger emission for auth failures, permission denials, or validation errors across routes.
- **Staff actions**: Creating/updating staff users, permissions, messages, device registration—all unaudited.
- **Wallet adjustments**: Manual credits/debits/transfers in `wallets.js` and admin player adjustments have no ledger/audit entry.
- **Voucher flows**: Some legacy voucher endpoints (`cashier.js`, legacy `voucherRoutes.js`) do not emit ledger events; staff redemption in those paths is unaudited.
- **Owner/tenant actions**: Creating tenants/distributors and issuing tenant credits/pool allocations are only logged in `CreditLedger`; no unified audit or ledger event.
- **Purchase orders**: Create/update/approve/reject and messaging have no audit events.
- **Safety limits**: Setting loss limits records to `player_safety_limits` but does not emit a ledger/audit entry; 403 limit hits are not audited.
- **Error surfaces**: 500s and validation errors in analytics/reports endpoints are not captured in audit/ledger.
- **Session/auth lifecycle**: Staff login/logout, refresh tokens, admin logins do not write audit/ledger entries.

## Notes

- The admin audit API (`/api/v1/admin/audit`) currently builds a synthetic stream from `Transaction`, `Voucher`, `GameRound` rather than consuming a dedicated audit log; coverage is partial and misses many mutations above.
- For comprehensive coverage, consider a unified audit event writer (reusing `LedgerEvent` or a new `audit_events` table) invoked from every state-changing route, including failure paths.
