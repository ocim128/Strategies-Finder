# Execution Lab UI Live Config And Limit Order Plan

## Purpose

Add non-secret live-trade configuration controls to the Execution Lab UI and add an optional limit-order mode for live Polymarket execution.

This plan is planning-only. It does not implement the feature.

## Current Architecture

- Execution Lab UI markup lives in `html-partials/tab-execution-lab.html`.
- Required Execution Lab DOM ids are declared in `lib/execution-lab/execution-lab-dom.ts`.
- Browser-side Execution Lab orchestration lives in `lib/execution-lab/execution-lab-service.ts`.
- Browser-to-local-Vite API calls live in `lib/execution-lab/execution-lab-api.ts`.
- Local Vite endpoints live in `lib/execution-lab/execution-lab-vite-plugin.ts`.
- Local CLI executor config and process spawning live in `lib/execution-lab/live-executor-adapter.ts`.
- Live entry/exit request construction and validation live in `lib/execution-lab/live-trade-request.ts`.
- Live trade request/result record types live in `lib/execution-lab/execution-lab-model.ts`.
- JSONL record validation lives in `lib/execution-lab/paper-log-schema.ts`.
- Execution Lab settings currently persist through `executionLabSettings` using `readPersistedJson(...)` and `writePersistedJson(...)`.
- Current live order types are limited to `FOK` and `FAK`.
- Current docs explicitly treat order cancellation and `GTC`/`GTD` support as non-goals.

## V1 Decisions

These decisions are part of the target contract unless Phase 1 proves the side executor cannot support them.

- Browser/UI config is non-secret only.
- Wallet private keys, proxy credentials, API keys, signatures, signed orders, auth headers, and side-executor wallet configuration remain `.env`/side-executor-owned.
- Strategy Finder `.env` remains the source for executor path, executor cwd, executor args, hard live enablement, timeout/output limits, and geoblock display state.
- The UI owns live order behavior for the current browser profile: order mode, taker order type, live sizing mode, max stake cap, entry/exit slippage, limit offset enable/value, and limit cancel-on-exit.
- UI-owned fields are persisted under `executionLabSettings`; Live Trade mode itself is still never persisted and must reset to Paper Trade on reload.
- Config precedence is: validated UI non-secret overrides > Strategy Finder `.env` fallback > code defaults. Secret and hard safety fields never have UI overrides.
- Live start is still gated by explicit Live Trade selection and confirmation. If `.env` live enablement is false, executor submission remains dry-run even when UI mode is Live Trade.
- V1 order mode is `orderMode: "taker" | "limit"`. `orderType` remains executor-specific. Taker order types are `FAK`/`FOK`; limit order type must be the resting type confirmed in Phase 1.
- Limit mode changes live entries only in V1. Filled live positions still use the existing taker sell-exit flow.
- Limit entries submit immediately after an accepted paper entry and skip the current ask-cap preflight. "Immediately" means no Strategy Finder price-cap filter before executor submission, not guaranteed fill.
- Limit offset is disabled by default. When enabled, the buy limit price is `referencePrice - offsetCents / 100`, rounded to the executor tick and clamped to the valid Polymarket price range.
- Posted/resting limit orders are tracked separately from filled live positions. They are not treated as open live positions unless the executor response reports matched or partial filled shares.
- Limit cancel-on-exit is limit-mode-only and sends cancel-all without checking whether Strategy Finder knows about open orders.
- Cancel-all must be idempotent per paper exit trigger in a session to avoid repeated cancel spam while preserving the requested no-open-order-lookup behavior.

## Assumptions And Phase 1 Blockers

Assumptions:

- UI configuration must cover only non-secret fields.
- Private keys, proxy credentials, API keys, signatures, signed orders, and wallet auth remain in the side-repo executor `.env`.
- Live mode must still reset to Paper Trade on page reload.
- "Limit order" means a resting order type supported by the local side executor, not current `FAK`/`FOK` taker flow.
- "Always execute immediately" means submit immediately when a signal is accepted, not guarantee immediate fill.
- Limit-order price offset applies to buy entry limit price as `referencePrice - offsetCents`.
- The requested exit-signal cancel behavior is limit-mode-only and intentionally sends cancel-all without checking whether Strategy Finder knows about open orders.

Phase 1 blockers to confirm:

- Exact side-repo executor request shape for resting limit orders.
- Exact side-repo executor request shape for cancel-all-open-orders.
- Exact cancel-all scope: account-wide, market-scoped, token-scoped, or session-scoped.
- Whether the executor supports `GTC`, `GTD`, or a different Polymarket order type for resting orders.
- Whether the executor can return reliable synchronous fill information for resting limit orders, or whether order-status polling/reconciliation is required.

Resolved non-goals for V1:

- No UI storage for executor path, cwd, args, wallet auth, API keys, or private key material.
- No order-status polling or reconciliation endpoint unless Phase 1 proves it already exists and is required for safe request validation.
- No limit exits in V1; filled live positions continue to use the current taker sell-exit path.

## Conceptual Weaknesses To Resolve Before Coding

- Resting limit orders can fill after the submit response. Current Strategy Finder live-position tracking only becomes reliable when the executor response includes matched or partial filled shares. Without order-status polling or executor-side fill reconciliation, Strategy Finder must not assume a `posted_live` limit order became an open live position.
- Cancel-all can be dangerous if executor scope is account-wide. The implementation must name the scope explicitly in UI/docs and should prefer the narrowest executor-supported scope that still satisfies the requested no-precheck behavior.
- The existing status endpoint is `GET /api/execution-lab/live/status`. UI overrides cannot safely be implied by a plain GET unless they are query params. Runtime submissions should carry the active non-secret config in POST bodies, or a separate POST resolve/validate endpoint should be added.
- Reusing `maxPrice` language for resting limit entries can confuse taker price caps with limit order prices. Limit-mode records should use explicit field names such as `limitPrice`, while retaining backward-compatible taker fields where needed.

## Module Boundaries

- UI controls: `html-partials/tab-execution-lab.html`.
- DOM contract: `lib/execution-lab/execution-lab-dom.ts`.
- UI state, persistence, and session behavior: `lib/execution-lab/execution-lab-service.ts`.
- HTTP client wrappers: `lib/execution-lab/execution-lab-api.ts`.
- Local API validation, idempotency, and endpoint routing: `lib/execution-lab/execution-lab-vite-plugin.ts`.
- Executor config, environment mapping, and subprocess boundary: `lib/execution-lab/live-executor-adapter.ts`.
- Request construction, validation, and record construction: `lib/execution-lab/live-trade-request.ts`.
- Types and logs: `lib/execution-lab/execution-lab-model.ts` and `lib/execution-lab/paper-log-schema.ts`.
- Documentation: `docs/live-trade-plan.md` and `docs/polymarket.md`.

## UI Config Ownership Matrix

| Field | UI owned | Persisted | `.env` fallback | Notes |
| --- | --- | --- | --- | --- |
| `executionMode` | yes | no | no | Always resets to `paper` on reload. |
| `stakeUsd` | yes | yes | no | Existing field; keep migration for old `{ stakeUsd }` payloads. |
| `orderMode` | yes | yes | yes | `taker` default. `.env` fallback is optional for backward compatibility if added. |
| `takerOrderType` | yes | yes | yes | `FAK` default; valid values `FAK`/`FOK`. |
| `sizingMode` | yes | yes | yes | `fixed`/`exchange_min`; still validated against executor cap. |
| `maxStakeUsd` | yes | yes | yes | Non-secret cap. The lower effective cap should win if the side executor also enforces its own cap. |
| `entryMaxSlippageCents` | yes | yes | yes | Taker mode only. |
| `exitMaxSlippageCents` | yes | yes | yes | Existing taker exit path. |
| `limitOffsetEnabled` | yes | yes | no | Default `false`. |
| `limitOffsetCents` | yes | yes | no | Default `0`; enabled example: 25c reference with 6 offset sends 19c limit. |
| `limitCancelAllOnExitEnabled` | yes | yes | no | Default `false`; disabled unless `orderMode === "limit"`. |
| `cancelScope` | display only | no | side executor | Read from config/resolve response when possible; docs must name the exact scope. |
| `liveEnabled` | no | no | yes | Hard safety gate remains `.env`/server-side only. |
| `executorPath` / `executorCwd` / `executorArgs` | no | no | yes | Keep local-machine execution config out of browser localStorage in V1. |
| `timeoutMs` / stdout/stderr limits | no | no | yes | Keep operational process controls server-side in V1. |

Effective UI config should be represented as a typed object, for example:

```ts
type ExecutionLabLiveUiConfig = {
    orderMode: "taker" | "limit";
    takerOrderType: "FAK" | "FOK";
    sizingMode: "fixed" | "exchange_min";
    maxStakeUsd: number;
    entryMaxSlippageCents: number;
    exitMaxSlippageCents: number;
    limitOffsetEnabled: boolean;
    limitOffsetCents: number;
    limitCancelAllOnExitEnabled: boolean;
};
```

The resolved server-side config should include the UI fields plus hard server fields, for example:

```ts
type ExecutionLabResolvedLiveConfig = ExecutionLabLiveUiConfig & {
    liveEnabled: boolean;
    dryRun: boolean;
    available: boolean;
    supportedTakerOrderTypes: Array<"FAK" | "FOK">;
    supportedLimitOrderType: string | null;
    cancelScope: "account" | "market" | "token" | "session" | "unknown";
};
```

## Request And Log Contracts

Live trade submission should remain one typed POST boundary, but the request shape must separate taker caps from resting limit prices.

Target entry fields:

- Common: `action`, `requestId`, `sessionId`, `paperTradeId`, `createdAtIso`, `expiresAtSec`, symbol/strategy/event/market/token identity, `side`, `stakeUsd`, `signalTimeSec`, `entryTimeSec`, `orderMode`.
- Taker entry: `orderMode: "taker"`, `orderType: "FAK" | "FOK"`, `maxPrice`.
- Limit entry: `orderMode: "limit"`, `orderType: <Phase 1 resting type>`, `limitPrice`, `limitReferencePrice`, `limitOffsetEnabled`, `limitOffsetCents`.
- Existing taker exits keep `action: "exit"`, `orderMode: "taker"`, `minPrice`, `shares`, and `attempt`.

Cancel-all should use a separate endpoint and record family so it is not confused with sell exits:

```ts
type LiveCancelAllSubmitRequest = {
    action: "cancel_all";
    requestId: string;
    sessionId: string;
    paperTradeId?: string;
    exitTriggerKey: string;
    createdAtIso: string;
    symbol: string;
    strategyKey: string;
    marketSlug?: string;
    conditionId?: string;
    tokenId?: string;
    scope: "account" | "market" | "token" | "session" | "unknown";
    reason: "limit_exit_signal";
    orderMode: "limit";
};
```

```ts
type LiveCancelAllSubmitResponse = {
    ok: true;
    requestId: string;
    status: "dry_run" | "submitted" | "partial" | "duplicate" | "rejected" | "failed";
    reason?: string;
    scope: "account" | "market" | "token" | "session" | "unknown";
    canceledOrderIds?: string[];
    canceledCount?: number;
};
```

Add JSONL record types:

- `live_cancel_all_request`.
- `live_cancel_all_result`.
- `live_limit_order_submitted` only if a distinct pending-limit record is useful for UI display beyond `live_trade_result`.

If the implementation does not add `live_limit_order_submitted`, then `live_trade_result` must carry enough limit metadata to reconstruct pending submissions.

## Pending Limit Order State

Limit submissions need state separate from `liveOpenPositionByPaperTradeId` because current live-position tracking is fill-based.

Target in-session state:

```ts
type PendingLimitSubmission = {
    requestId: string;
    paperTradeId: string;
    eventStartTs: number;
    eventEndTs: number;
    marketSlug: string;
    conditionId: string;
    tokenId: string;
    side: "yes" | "no";
    limitPrice: number;
    submittedAtIso: string;
    orderId?: string;
    lastStatus: string;
};
```

Required behavior:

- Add pending limit submissions when the executor returns `posted_live`, `delayed`, or another Phase 1 resting status.
- Do not add pending limit submissions for rejected/failed/duplicate requests unless the duplicate response identifies an existing order.
- If the executor reports filled shares in the limit response, also update filled live-position state using the existing fill logic.
- Paper exit records and missing-exit trigger records must be able to trigger cancel-all from pending limit submissions even when no filled live position exists.
- Cancel-on-exit must not require a pending submission lookup before sending cancel-all. The pending registry is for UI/logging and optional scope narrowing only.
- Duplicate cancel suppression key should include `sessionId`, `eventStartTs`, side/token when available, paper trade id when available, and exit time/reason.

## Target Data Flow

1. User edits non-secret live config in Execution Lab.
2. Browser persists settings under `executionLabSettings`.
3. Browser refreshes base executor status through `GET /api/execution-lab/live/status`.
4. Browser resolves effective non-secret config through a dedicated POST validation endpoint or sends active UI config with each trade/cancel POST.
5. Live session starts only after explicit Live Trade selection and confirmation.
6. Accepted paper entries build live requests from the active UI live-trade settings.
7. Taker mode follows existing `FAK`/`FOK` request flow.
8. Limit mode submits immediately with a computed limit price and no browser-side ask/bid cap prefilter.
9. Limit-mode `posted_live` or resting responses are logged and stored in pending-limit state, not treated as filled live positions unless the response includes matched or partial filled shares.
10. Paper exit signals trigger cancel-all in limit mode when enabled, even if Strategy Finder has no pending order or filled live position for that event.
11. The cancel path does not query known open orders before request submission; it only uses known event/token fields when available to narrow scope if the executor supports scoped cancellation.
12. Request/result/cancel records are appended to the existing JSONL session log.

## Phase 1: Contract Clarification

Objective:

- Lock down the feature contract before changing UI or request types.

Scope:

- Planning and contract decisions only.
- No code changes except this planning document.

Technical tasks:

- Confirm exact side executor order type for resting limit orders.
- Confirm cancel-all request payload and response shape.
- Confirm cancel-all scope and whether Strategy Finder can request market/token-scoped cancellation.
- Confirm whether resting limit order fills are returned synchronously or require a reconciliation endpoint.
- Confirm executor path/cwd/args remain `.env`-only and are not persisted in browser localStorage.
- Confirm limit mode applies to entries only in V1; filled live exits continue through the existing taker sell path.
- Confirm `posted_live`/resting limit responses populate pending-limit state and do not create live positions without filled shares.
- Confirm naming from this plan: `orderMode: "taker" | "limit"` plus executor-specific `orderType`.
- Confirm every hard gate that must change: `LiveTradeOrderType`, request validation, log schema, adapter supported types, status payload, API request bodies, live result record builders, and tests.

Dependencies:

- Side-repo executor capabilities and CLI/stdin contract.
- Existing Strategy Finder live executor adapter.

Risks/blockers:

- If side executor has no cancel-all support, resting limit mode is unsafe to expose.
- If side executor cannot distinguish taker vs resting limit cleanly, current `orderType` model will drift.
- If side executor cannot report fills or reconcile order status, Strategy Finder cannot safely manage live exits for resting limit fills.
- If cancel-all is account-wide, enabling it from one Strategy Finder session may affect unrelated manual or automated limit orders.

Deliverables:

- Finalized request/response contract for limit entry and cancel-all.
- Finalized cancel-all scope and user-facing wording.
- Finalized policy for `posted_live` limit responses and live-position tracking.
- Final confirmation that UI-editable fields match the UI Config Ownership Matrix.

Validation/testing criteria:

- Contract can be represented without sending secrets to browser state, localStorage, logs, or request payloads.
- Contract can be validated in `live-trade-request.ts` without ad hoc checks in the service layer.
- Contract clearly separates order submission, order fill tracking, and order cancellation.

Exit criteria:

- No unknown request fields remain for limit order, fill tracking, or cancel-all behavior.

## Phase 2: UI Settings And State

Objective:

- Add Execution Lab UI controls for non-secret live configuration.

Scope:

- Execution Lab tab only.
- No global Settings tab changes.
- No backtest behavior changes.

Technical tasks:

- Add controls to `html-partials/tab-execution-lab.html`.
- Add ids to `lib/execution-lab/execution-lab-dom.ts`.
- Extend persisted `executionLabSettings` schema and migration.
- Add UI sync logic in `execution-lab-service.ts`.
- Add a single read/write path for `ExecutionLabLiveUiConfig` so live entry, status display, and cancel logic cannot read different config snapshots.
- Disable limit offset and cancel-on-exit controls unless `orderMode === "limit"`.
- Disable taker slippage/order-type controls only when they are irrelevant to the current mode, while keeping exit slippage visible because filled limit entries still use taker exits.
- Add explicit UI wording for cancel-all scope if the executor contract is broader than the current market/token.
- Keep Live Trade mode reset to Paper on reload.
- Disable live config controls while a session is running.

Dependencies:

- Phase 1 field list.
- Existing `readPersistedJson(...)` and `writePersistedJson(...)` helpers.

Risks/blockers:

- Too many config fields in the header can clutter Execution Lab.
- If the UI stores too much local-machine executor configuration, shared-machine risk increases; V1 avoids this by keeping path/cwd/args `.env`-only.

Deliverables:

- UI controls for exactly the fields in the UI Config Ownership Matrix.
- Status display that shows resolved order mode, effective taker order type, sizing mode, cap, entry/exit slippage, limit offset state, cancel-on-exit state, dry-run/live state, and cancel scope.
- Migrated settings object preserving old `{ stakeUsd }` payloads.

Validation/testing criteria:

- `npm run typecheck`.
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`.
- Manual reload check: stake and non-secret config persist, execution mode resets to Paper.

Exit criteria:

- UI settings render, persist, restore, and disable while running.

## Phase 3: Live Config API Contract

Objective:

- Pass UI live config to the local Vite execution boundary without weakening existing validation.

Scope:

- Local Vite API and browser API client only.
- No side-repo executor implementation.

Technical tasks:

- Add a typed live config payload shared by `execution-lab-api.ts`, `execution-lab-model.ts`, and Vite route handlers.
- Keep `GET /api/execution-lab/live/status` as base executor status with no browser-local overrides.
- Add `POST /api/execution-lab/live/config/resolve` to validate UI config, merge it with `.env` fallback/hard safety fields, and return `ExecutionLabResolvedLiveConfig`.
- Add the active non-secret live config to `/api/execution-lab/live/trade` POST handling so each request is validated against the same resolved config used to build it.
- Add `/api/execution-lab/live/cancel-all` POST handling with the cancel request/response shape from this plan.
- Validate request mode/type against the resolved `.env` plus UI config.
- Preserve process-local idempotency ledger behavior.
- Add a separate process-local idempotency ledger for cancel-all requests keyed by `requestId` and payload hash.
- Avoid exposing executor path or secrets in status or config-resolve responses.

Dependencies:

- Phase 1 config contract.
- Phase 2 UI settings model.

Risks/blockers:

- Merging `.env` config with UI overrides can create unclear precedence if the V1 Decisions precedence rule is not implemented exactly.
- A GET status endpoint with implicit browser-local overrides would be misleading.
- Existing tests assume `.env` is the single live config source.

Deliverables:

- Implemented config precedence rule: UI overrides non-secret runtime fields; `.env` remains fallback and secret/hard-safety source.
- Updated trade endpoint validation, config resolve endpoint, and cancel-all endpoint.

Validation/testing criteria:

- `npm run typecheck`.
- `..\..\..\node_modules\.bin\esno tests\execution-lab-live-executor-adapter.spec.ts`.
- Add tests for config precedence and order-mode mismatch rejection.

Exit criteria:

- Existing taker-mode behavior remains compatible with `.env`-only config.

## Phase 4: Limit Entry Request Support

Objective:

- Build and validate limit-mode live entry requests.

Scope:

- Entry requests only.
- Existing paper trade generation remains unchanged.

Technical tasks:

- Extend model types with order mode and limit-price fields.
- Keep taker request behavior unchanged.
- Add limit entry price resolver:
  - reference price from accepted paper entry or latest same-event quote.
  - optional offset in cents.
  - tick-size rounding based on executor/market constraints when available.
  - clamp to valid Polymarket range.
- Skip current ask cap preflight in browser service for limit mode.
- Do not treat `posted_live` or `delayed` limit-entry responses as open live positions unless filled shares are returned.
- Store/log pending limit submission metadata separately from filled live-position state.
- Preserve the existing `trackLiveEntryPosition(...)` behavior for matched/partial responses and reuse it when limit responses include filled shares.
- Include limit-mode fields in live request records and result records.
- Update paper log schema validation.

Dependencies:

- Phase 1 limit request contract.
- Phase 3 API validation.

Risks/blockers:

- A below-market buy limit may not fill immediately; UI/docs must avoid implying guaranteed fill.
- Existing code uses `maxPrice` as cap language; reusing it for resting limit price may confuse logs and docs.
- Without reconciliation, a limit order may fill after Strategy Finder has already logged it as merely posted.

Deliverables:

- Valid typed limit entry request and records.
- Pending-limit submission state keyed by paper trade id and request id.
- Clear separation between submitted limit orders and tracked filled live positions.
- Existing taker request tests still pass.
- New tests for offset price calculation and validation.

Validation/testing criteria:

- `npm run typecheck`.
- `..\..\..\node_modules\.bin\esno tests\execution-lab-live-trade-request.spec.ts`.
- `..\..\..\node_modules\.bin\esno tests\execution-lab-log-schema.spec.ts`.

Exit criteria:

- Limit entry requests can be constructed, validated, logged, and submitted through the local adapter.

## Phase 5: Executor Adapter Support

Objective:

- Forward limit-mode and cancel-all requests to the local CLI executor safely.

Scope:

- `live-executor-adapter.ts` and Vite route integration.
- No private secret handling in browser code.

Technical tasks:

- Map order mode/type into executor environment and/or stdin request.
- Keep safe parent environment allowlist.
- Add cancel-all adapter function if side executor supports it.
- Use the same subprocess timeout and stdout/stderr byte-limit pattern for trade and cancel-all calls.
- Normalize cancel-all executor stdout into a structured response.
- Pass cancel scope explicitly when supported by the executor.
- If executor cancellation is broader than the known market/token/session, require that broad scope to be visible in resolved config, logs, UI status, and docs.
- Preserve dry-run behavior.

Dependencies:

- Side executor limit and cancel-all support.
- Phase 1 stdout response contract.

Risks/blockers:

- Side executor may require different auth or market scope for cancel-all.
- Cancel-all may cancel manual orders outside Strategy Finder unless scoped by market/token.
- A broad cancel-all contract may satisfy speed but has larger blast radius than the UI tab suggests.

Deliverables:

- Adapter support for limit-mode trade submission.
- Adapter support for cancel-all-open-orders using the Phase 1 contract.
- Tests proving cancel scope is forwarded exactly as configured.

Validation/testing criteria:

- `..\..\..\node_modules\.bin\esno tests\execution-lab-live-executor-adapter.spec.ts`.
- Tests for environment mapping, mismatch rejection, timeout, invalid stdout, and no parent secret forwarding.

Exit criteria:

- Fake executor tests prove Strategy Finder sends the expected payloads without leaking secrets.

## Phase 6: Cancel-All-On-Exit Flow

Objective:

- Add limit-mode exit-signal cancellation behavior.

Scope:

- Execution Lab live mode only.
- Limit mode only.
- Existing paper exits and taker live exits remain unchanged.

Technical tasks:

- Detect paper exit triggers from the `paper_exit` and `paper_unfilled` records before the existing filled-position-only `queueLiveExit(...)` filter can drop them.
- If limit mode and cancel-on-exit are enabled, send cancel-all immediately.
- Do not query known open orders before sending cancel-all.
- Do not infer from local state that no cancel is needed; the requested behavior is unconditional on exit signal.
- Use pending limit-order state and exit record fields only to populate optional market/token scope fields; lack of pending state must not suppress cancel-all.
- If cancel scope is broad, label records and UI status with that scope.
- Add cancel request/result records.
- Prevent duplicate cancel spam for the same paper exit trigger using an in-session fingerprint.
- Keep existing live sell exit flow for tracked filled positions.

Dependencies:

- Phase 5 cancel-all adapter support.
- Existing live exit trigger records, plus new pre-`queueLiveExit(...)` cancel-all dispatch.

Risks/blockers:

- Cancel-all without known order checking can cancel orders not created by the current session if executor scope is broad.
- Cancel requests could race with fills; logs must preserve both cancel and fill/exit responses.
- If a resting entry fills after cancel request submission, Strategy Finder may not know unless the executor response reports it or reconciliation exists.

Deliverables:

- Cancel-all request/result path.
- JSONL schema support for cancel records.
- In-session duplicate suppression for cancel-all requests.
- Tests proving cancel-all can fire when no filled live position exists.
- UI status text reflecting latest cancel result.
- Explicit logs showing cancel mode was unconditional and whether the scope was broad or scoped.

Validation/testing criteria:

- `npm run typecheck`.
- `npm run test -- execution-lab`.
- Specific tests for exit-trigger cancel behavior and duplicate suppression.

Exit criteria:

- Limit-mode exit signal sends cancel-all without a prior open-order lookup and logs the outcome.

## Phase 7: Documentation

Objective:

- Update operational docs so live behavior is unambiguous.

Scope:

- Existing docs only.
- No new architecture docs unless needed.

Technical tasks:

- Update `docs/live-trade-plan.md`.
- Update `docs/polymarket.md`.
- Update side-executor live-trade documentation/request contract if that repo is part of the delivered change.
- Replace old "no cancellation controls" / "no GTC/GTD" language with the new scoped behavior.
- Document that limit mode submits immediately but may rest unfilled.
- Document that cancel-on-exit intentionally sends cancel-all without checking whether an open order is known locally.
- Document that `posted_live` limit orders are not treated as live positions unless fills are reported or reconciliation is implemented.
- Document which settings are UI-owned and which remain `.env`/side-executor-owned.
- Document that executor path/cwd/args remain `.env`-only in V1 and are not stored in browser localStorage.

Dependencies:

- Phases 1 through 6 final behavior.

Risks/blockers:

- Docs can become misleading if side executor scope for cancel-all is broader than Strategy Finder session scope.

Deliverables:

- Updated live-trade and Polymarket docs.
- Updated side-executor docs if the executor request shape changes.

Validation/testing criteria:

- Manual doc review against implemented request fields and UI labels.

Exit criteria:

- A user can distinguish taker mode, limit mode, price offset behavior, and forced cancel-all behavior from docs alone.
- A user can understand whether cancel-all is account-wide, market-scoped, token-scoped, or session-scoped.

## Security Considerations

- Do not store wallet private keys, proxy credentials, API keys, signatures, signed orders, or authorization headers in browser state, localStorage, JSONL logs, or request payloads.
- Keep executor secret loading inside the side executor process.
- Keep parent process environment allowlist in `live-executor-adapter.ts`.
- Do not expose executor path/cwd/args as UI-provided settings in V1.
- Live mode must remain opt-in per session.
- Dry-run/live-enabled status must remain visible before and during live sessions.

## Observability And Logging

- Existing JSONL logs should record:
  - live trade request/result.
  - order mode.
  - taker order type or limit order type.
  - explicit limit price and offset settings when applicable.
  - whether a limit submission was filled, partial, posted, delayed, or only submitted.
  - pending limit submission request id, paper trade id, token id, and order id when available.
  - cancel-all request/result when applicable.
  - cancel scope when applicable.
  - cancel duplicate-suppression key or request id.
  - dry-run/live context.
  - executor latency.
- Logs must not include secrets.
- Status panel should summarize active mode and latest live/cancel result.

## Failure Handling

- Malformed browser requests return HTTP 400 before executor invocation.
- Config/order-mode mismatches return structured rejected responses.
- Executor unavailable, timeout, invalid stdout, and output-limit failures continue to map to structured failure responses.
- Cancel-all failures are logged but should not corrupt paper state.
- Duplicate cancel-all triggers return or log a duplicate result instead of spawning another executor process.
- If a limit entry rests and later fills outside Strategy Finder awareness, Strategy Finder must not track it as an open live position until executor-side reconciliation exists.
- If cancel-all scope is broad, cancellation success means the executor accepted the cancel request, not that Strategy Finder knew which orders existed.

## Edge Cases

- Offset larger than current price clamps limit to minimum valid price.
- Offset disabled should use the selected reference price without applying a hidden default offset.
- Event closes before limit order fills.
- Exit signal occurs before executor returns entry result.
- Exit signal occurs when there is no pending limit submission and no filled live position; cancel-all still sends if limit mode and cancel-on-exit are enabled.
- Cancel-all races with partial fill.
- Limit order fills after Strategy Finder already sent cancel-all.
- Executor reports `posted_live` but never reports fill status.
- User switches settings while a session is running; controls should be disabled or ignored for the active session.
- Existing localStorage payload contains only `stakeUsd`.
- Existing `.env` config has `EXECUTION_LAB_LIVE_ORDER_TYPE` or `ARBITRAGE_ORDER_TYPE` set to `FAK`/`FOK`.

## Performance Considerations

- No polling for open orders should be added for the requested cancel-on-exit behavior.
- Existing one-second poll cadence should remain unchanged.
- Additional UI settings should not add work to chart crosshair or rendering hot paths.
- Cancel-all should use the existing bounded subprocess timeout/output limit pattern.

## Rollback Strategy

- Keep taker mode as the default.
- Preserve `.env`-only behavior when no UI override is saved.
- Gate limit-mode behavior behind an explicit UI mode.
- If limit mode is unsafe, hide or disable only limit controls while leaving Paper and taker Live Trade intact.
- LocalStorage migration should tolerate unknown fields and fall back to safe defaults.

## Final Validation Set

Run from repo root:

```bash
npm run typecheck
npm run test -- execution-lab
..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
..\..\..\node_modules\.bin\esno tests\execution-lab-live-trade-request.spec.ts
..\..\..\node_modules\.bin\esno tests\execution-lab-live-executor-adapter.spec.ts
..\..\..\node_modules\.bin\esno tests\execution-lab-log-schema.spec.ts
```

Targeted test coverage to add or update:

- UI settings migration and persistence for legacy `{ stakeUsd }` and new live config fields.
- Config resolve precedence: UI non-secret overrides, `.env` fallback, and hard `.env` safety fields.
- Taker compatibility with old `.env`-only config.
- Limit offset price calculation, rounding/clamping, and disabled-default behavior.
- Pending limit submissions are not tracked as filled live positions without filled shares.
- Cancel-all fires from an exit signal even when no filled live position and no pending limit submission is known.
- Duplicate cancel-all suppression for the same exit trigger.
- Cancel scope appears in request/result logs, status text, and docs.

Manual checks:

- Execution Lab opens with Paper Trade selected after reload.
- Non-secret UI settings persist after reload.
- Live start still requires explicit user confirmation.
- Taker mode produces the same request shape as before, apart from additive fields if any.
- Limit mode computes the expected offset price.
- Limit cancel-on-exit sends cancel-all without an open-order lookup, including when Strategy Finder has no known open order, and logs that behavior.
