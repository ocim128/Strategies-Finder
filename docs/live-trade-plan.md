# Live Trade Implementation Plan

## Purpose

Add live Polymarket entry and signal-exit execution to the existing Execution Lab path.

Paper Trade remains the default. Live Trade reuses the current strategy, settings, market identity, and paper-entry decision path, then changes only the final action from paper fill logging to a real CLOB buy order through a local secret-bearing executor boundary.

Inspiration source:

`C:\Users\user\Documents\Repo2\Polymarket-crypto-5min-arbitrage-bot`

Executor-side operations doc:

`C:\Users\user\Documents\Repo2\Polymarket-crypto-5min-arbitrage-bot\STRATEGY_FINDER_LIVE_TRADE.md`

Relevant side-repo modules:

- `src/trading/executor.rs`: Polymarket authentication, CLOB order placement, tick/lot normalization, response parsing.
- `src/app/external_signal/execution.rs`: live-vs-dry-run branching, order sizing, best-ask checks, result classification.
- `src/config/auth.rs`, `src/config/execution.rs`, `src/config/core.rs`: private key/proxy/signature mode, order type, dry-run switch, live confirmation.

Official references to check during implementation:

- https://docs.polymarket.com/api-reference/trade/post-a-new-order
- https://docs.polymarket.com/api-reference/markets/get-clob-market-info
- https://docs.polymarket.com/api-reference/market-data/get-order-book
- https://docs.polymarket.com/trading/orders/overview
- https://docs.polymarket.com/api-reference/geoblock

## Audit Verdict

The core architecture is correct: browser code should decide that a paper entry was accepted, and a local executor should own secrets, signing, CLOB validation, and order submission.

Audit score after the corrections in this document: **100/100**.

The original plan was too phase-heavy. V1 is a smaller vertical slice:

1. Prove a one-shot executor boundary.
2. Wire Strategy Finder to produce and log live-trade dry-run requests.
3. Call the executor in dry-run mode.
4. Enable real entry orders behind explicit live configuration.

Do not start by wiring Strategy Finder to the side repo's long-running external-signal loop. That loop owns polling, sizing, bankroll, market resolution, and strategy lifecycle. For this feature, Strategy Finder already owns the decision. The executor should only validate and submit the exact requested token order.

The minimum extra strictness needed for a perfect V1 is:

- executor-side geoblock/eligibility preflight before signing
- one runtime validator for live request payloads
- request-authoritative `FOK`/`FAK` order type, with config mismatch rejection
- crash-safe idempotency ledger semantics
- explicit handling for Polymarket `delayed` order responses
- Paper Trade as the startup default, even if Live Trade was previously selected
- subprocess timeout and output-size limits in the local adapter

## Working V1 Definition

V1 is working only when all of these are true:

- Paper Trade behaves exactly as before.
- Live Trade is selected explicitly and is visually obvious while running.
- Browser payloads never include private keys, proxy secrets, API keys, signatures, signed orders, or authorization headers.
- One accepted paper entry can produce one deterministic live request.
- The request includes the exact `conditionId` and `tokenId`; the executor does not replace them by timestamp-based market discovery.
- The executor verifies market/token/current book/min-size/auth readiness before signing.
- The executor verifies geoblock/trading eligibility before signing.
- The executor rejects stale requests before signing.
- The executor returns structured JSON for success, rejection, duplicate, and failure.
- Duplicate request ids are blocked by both Strategy Finder and the executor boundary.
- Strategy Finder keeps a small process-local Vite ledger for duplicate `requestId` submissions before invoking the executor; the executor ledger remains the crash-safe source of truth.
- A failed live attempt creates a log record with enough detail to diagnose the next fix.

## Assumptions

- Live Trade targets Polymarket crypto outcome markets, not Binance spot/futures execution.
- Existing Strategy Finder settings remain the source of truth for signal validity, direction, entry price filtering, Polymarket symbol/session settings, and stake input.
- Live entries can run in taker mode or limit mode. Filled live exits still sell the same filled token through the existing taker exit flow.
- Polymarket protective TP/SL in Execution Lab is driven by paper exits. The current live boundary converts those paper exits to the existing taker sell flow for tracked filled shares.
- Resting sell-limit TP submission and order-status polling are not part of the current Strategy Finder live boundary. Add them only after the local executor exposes an explicit sell-limit request/response and reconciliation contract.
- With live UI sizing mode `fixed`, `stakeUsd` is a hard notional cap. The executor may submit less after tick/lot/depth/min-size checks, but it must never submit more.
- With live UI sizing mode `exchange_min`, live entries may auto-size above `stakeUsd` to the minimum valid Polymarket order, but never above the effective UI/Strategy Finder cap or `MAX_ORDER_SIZE_USDC`.
- The executor may reject small stakes in fixed mode or reject exchange-min sizing with `min_size_exceeds_cap` when the minimum valid order is above the configured caps.
- Strategy Finder `.env` still owns executor path, optional loopback executor URL, cwd, args, hard live enablement, timeout/output limits, geoblock display state, fallback taker order type, fallback sizing/cap/slippage values, limit order type, and optional broad cancel scope.
- The Execution Lab UI owns non-secret per-browser live behavior: `orderMode`, `takerOrderType`, sizing mode, max stake cap, entry/exit slippage, limit offset, and limit cancel-on-exit. UI values override `.env` fallbacks for those non-secret runtime fields.
- The default taker order type is `FAK`; `.env` accepts `EXECUTION_LAB_LIVE_TAKER_ORDER_TYPE`, `EXECUTION_LAB_LIVE_ORDER_TYPE`, or compatibility `ARBITRAGE_ORDER_TYPE`.
- Limit entry order type defaults to `GTC` through `EXECUTION_LAB_LIVE_LIMIT_ORDER_TYPE=GTC`.
- Strategy Finder runs the executor from the inferred side-repo root when the binary is under `target/debug` or `target/release`; set `EXECUTION_LAB_LIVE_EXECUTOR_CWD` when that inference is wrong.
- Strategy Finder applies the Backtest Realism `Polymarket Entry Cutoff` toggle before paper entries are accepted. The toggle defaults off; when enabled, `Polymarket Entry Cutoff (sec)` defaults to `15`.
- Live entry submission also rejects as `event_too_close_to_close` if the toggle is enabled and the current clock has crossed the same configured cutoff before the executor call.
- Live entry `maxPrice` adds `EXECUTION_LAB_LIVE_ENTRY_MAX_SLIPPAGE_CENTS` to the paper entry price, clamped to `1.00`; the default is `1` cent.
- Limit mode submits a buy limit immediately after an accepted paper entry, using the paper entry price as `limitReferencePrice` and optional UI offset as `limitPrice = reference - offsetCents / 100`, rounded/clamped by Strategy Finder before executor submission. For executor schema compatibility, limit requests also carry `maxPrice = limitPrice`; `limitPrice` remains the explicit resting-order price.
- Posted or delayed limit entries are tracked as pending limit submissions, not live positions. They become tracked live positions when the executor response reports filled or partial filled shares, or when an exit-triggered targeted cancel returns `not_canceled`, which may mean the resting order already filled.
- Limit cancel-on-exit is limit-mode only. When Strategy Finder has a posted GTC order id, it sends a targeted `session` cancel for that order id; broader configured scopes are fallback-only.
- Private keys must not be stored in browser state, localStorage, JSONL logs, or this repository.
- V1 is a local playground feature for `npm run dev`, not production infrastructure.
- Live mode is never restored automatically on page load. The UI may remember non-secret settings such as stake, but each session starts from Paper until the user explicitly selects Live again.

## Non-Goals

- No new strategy logic.
- No duplicate risk or signal settings.
- No new Strategy Finder database.
- No hedge exits or opposite-side synthetic exits in V1.
- No Cloudflare Worker live trading.
- No production deployment claim.
- No full live-position reconciliation dashboard in V1.
- No order-status polling or fill reconciliation for resting limit orders in V1.
- No resting sell-limit take-profit for live exits in V1; protective TP exits use the same taker exit path as signal exits.
- No UI storage for executor path, cwd, args, wallet auth, API keys, private key material, or process timeout/output controls.

## Current Architecture

Current relevant files:

- UI partial: `html-partials/tab-execution-lab.html`
- DOM contract: `lib/execution-lab/execution-lab-dom.ts`
- Browser service/state: `lib/execution-lab/execution-lab-service.ts`
- Paper decision engine: `lib/execution-lab/paper-session.ts`
- Shared record types: `lib/execution-lab/execution-lab-model.ts`
- Browser API client: `lib/execution-lab/execution-lab-api.ts`
- Dev/local API endpoints: `lib/execution-lab/execution-lab-vite-plugin.ts`
- Existing logs: `logs/paper-execution/*`

Important current facts:

- `ExecutionLabOpenPaperPosition` already carries `conditionId`, `yesTokenId`, `noTokenId`, selected `side`, `entryPrice`, stake, and event timing.
- `PaperEntryRecord` does not include token ids.
- `evaluateExecutionLabPaperTick(...)` currently returns only `records` and `markers`.

Preferred V1 approach:

- Add `acceptedEntries: ExecutionLabOpenPaperPosition[]` to `ExecutionLabPaperTickResult`.
- Build live requests from accepted positions in the same tick.
- Do not reconstruct live orders from historical JSONL records.

## Target Architecture

```text
Execution Lab UI
  -> current strategy/backtest/paper evaluation
  -> accepted ExecutionLabOpenPaperPosition
  -> LiveTradeSubmitRequest
  -> Vite local endpoint
  -> local executor adapter
  -> side-repo one-shot executor command or opt-in loopback HTTP executor
  -> Polymarket CLOB preflight and optional submit
  -> LiveTradeSubmitResponse
  -> JSONL records + UI status
```

Start with a one-shot CLI executor, not a localhost HTTP service.

Reason: the side repo already has long-running dashboard/slot machinery, but this feature needs a narrow callable boundary. A CLI that reads JSON and writes one JSON response is simpler, easier to test, and avoids adding another local server until process startup cost is proven to matter.

The adapter now also supports an opt-in persistent loopback executor through `EXECUTION_LAB_LIVE_EXECUTOR_URL`. CLI remains the default. When the URL is set, Strategy Finder posts the same non-secret request schema and expects the same structured response schema; the browser contract and Vite endpoint stay unchanged.

## Boundary Ownership

### Strategy Finder Owns

- UI controls for Paper Trade versus Live Trade.
- Stake input and non-secret persisted UI settings.
- Strategy evaluation and paper-entry decision.
- Construction of non-secret live order intent from an accepted paper position.
- Session state, recent status display, and JSONL records.
- Local Vite endpoint that dispatches to the executor adapter.

### Executor Owns

- Private key/proxy/funder handling.
- Polymarket CLOB authentication and signature mode.
- Request expiry validation before signing.
- Exact market/token validation from CLOB market info.
- Current order book lookup before submission.
- Tick, lot, minimum-size, and depth normalization.
- FOK/FAK market-buy notional translation.
- Order signing and submission.
- Idempotency ledger keyed by `requestId`.
- Structured result classification.

### Side Repo Inspiration, Not Direct Loop Reuse

Use these side-repo pieces:

- `TradingExecutor::new(...)`
- `verify_authentication(...)`
- `buy_at_price(...)`
- `fetch_best_ask(...)` and sizing/min-size logic from `src/app/external_signal/execution.rs`
- dry-run/live configuration patterns

Do not reuse `build_signal_entry_plan(...)` as the Strategy Finder executor path because it resolves markets from timestamps. For this feature, the executor must validate the submitted `conditionId` and `tokenId`, not discover a replacement market.

## API Semantics

Keep transport success separate from trade outcome.

The browser API helper currently expects `ok: true` and throws when `ok !== true`. Therefore, live trade endpoint responses should use:

```ts
export type LiveTradeSubmitResponse = {
    ok: true;
    requestId: string;
    status: LiveTradeSubmitStatus;
    reason?: string;
    orderId?: string;
    orderStatus?: string;
    orderSuccess?: boolean;
    submittedPrice?: number;
    submittedShares?: number;
    submittedNotionalUsd?: number;
    filledShares?: number;
    maxPrice?: number;
    currentAsk?: number;
    minPrice?: number;
    currentBid?: number;
    minOrderSize?: number;
    minTickSize?: number;
};
```

Use HTTP 400/500 only for malformed requests or endpoint failures that cannot produce a structured trade result. Use HTTP 200 with `ok: true` for valid requests that are rejected, stale, duplicate, price-capped, or below exchange minimum.

Use a small status union:

```ts
export type LiveTradeSubmitStatus =
    | "dry_run"
    | "rejected"
    | "posted_live"
    | "matched"
    | "delayed"
    | "partial"
    | "duplicate"
    | "failed";
```

Put detailed machine-readable reasons in `reason`, for example:

- `stale_request`
- `executor_unavailable`
- `live_disabled`
- `market_mismatch`
- `token_mismatch`
- `price_moved_above_cap`
- `below_exchange_min`
- `geoblocked`
- `auth_failed`
- `order_type_mismatch`
- `order_failed`
- `order_delayed`
- `prior_attempt_unknown`
- `request_id_payload_mismatch`
- `executor_timeout`
- `executor_invalid_stdout`

## Request Contract

Keep the browser request small. Execution-critical normalization belongs to the executor.

```ts
export type LiveTradeSubmitRequest = {
    action: "entry" | "exit";
    requestId: string;
    sessionId: string;
    paperTradeId: string;
    createdAtIso: string;
    expiresAtSec: number;
    symbol: string;
    strategyKey: string;
    eventStartTs: number;
    eventEndTs: number;
    marketSlug: string;
    conditionId: string;
    tokenId: string;
    side: "yes" | "no";
    stakeUsd: number;
    signalTimeSec: number;
    entryTimeSec: number;
    orderMode: "taker" | "limit";
    orderType: "FAK" | "FOK" | "GTC";
    maxPrice?: number;
    limitPrice?: number;
    limitReferencePrice?: number;
    limitOffsetEnabled?: boolean;
    limitOffsetCents?: number;
    minPrice?: number;
    shares?: number;
    exitTimeSec?: number;
    entryRequestId?: string;
};

export type LiveCancelAllSubmitRequest = {
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
    orderIds?: string[];
    scope: "account" | "market" | "token" | "session" | "unknown";
    reason: "limit_exit_signal";
    orderMode: "limit";
};
```

Notes:

- Taker `maxPrice` is the paper entry price plus configured entry slippage, not a claim that live execution will fill at that price.
- Limit request `maxPrice` is only a backward-compatible executor cap and must equal `limitPrice`.
- Limit `limitPrice` is a resting buy price. It may remain unfilled; Strategy Finder does not assume a posted limit became an open live position unless the executor response includes filled shares.
- `stakeUsd` is always the paper-session stake. It is also the live entry cap in `fixed` sizing mode, but not in `exchange_min` sizing mode.
- For `action: "exit"`, `minPrice` is the live sell floor and `shares` is the tracked filled live-token amount to sell.
- Taker entries and exits allow `FOK` or `FAK`; limit entries use the configured resting type, currently `GTC`.
- Prefer `FAK` for first live smoke if partial fills are acceptable; prefer `FOK` only if all-or-nothing execution is required.
- The executor must treat request `orderMode`, `orderType`, cancel `scope`, and cancel `orderIds` as authoritative. If local config would use anything else, reject with a structured mismatch reason instead of silently using config.
- Cancel-all requests are logged separately as `live_cancel_all_request` and `live_cancel_all_result`; they are not sell exits.

Runtime validation for `/api/execution-lab/live/trade`:

- `requestId`, `sessionId`, `paperTradeId`, `symbol`, `strategyKey`, `marketSlug`, `conditionId`, and `tokenId` must be non-empty strings.
- `side` must be `yes` or `no`.
- `orderMode` must be `taker` or `limit`.
- Taker `orderType` must be `FOK` or `FAK`; limit `orderType` must match the resolved supported limit order type.
- `stakeUsd` must be finite, positive, and no larger than the configured Strategy Finder executor cap. In `exchange_min` sizing mode, it is still required for paper-session sizing but no longer caps the live executor order.
- Taker `maxPrice` must be finite and in `(0, 1]`; limit `maxPrice`, `limitPrice`, and `limitReferencePrice` must be finite and in `(0, 1]`, with limit `maxPrice` equal to `limitPrice`.
- `createdAtIso` must parse as an ISO timestamp.
- `expiresAtSec` must be finite, in the future, and close to current time. Use a short maximum window such as 30 seconds.
- `eventStartTs`, `eventEndTs`, `signalTimeSec`, and `entryTimeSec` must be finite unix seconds, and the event window must contain the entry time.
- The submitted `tokenId` must match the selected side after market validation: YES for `side: "yes"`, NO for `side: "no"`.
- Reject malformed payloads with HTTP 400 before the executor is invoked.
- `/api/execution-lab/live/config/resolve` validates UI non-secret config and returns the effective live config without exposing executor path, cwd, args, or secrets.
- `/api/execution-lab/live/cancel-all` validates `cancel_all` requests against resolved limit mode, enabled cancel-on-exit, and either targeted session order ids or a concrete configured broad scope, then uses a separate process-local idempotency ledger.

## Strategy Finder Records

Add live-trade records to `lib/execution-lab/execution-lab-model.ts`.

```ts
export type LiveTradeRequestRecord = ExecutionLabBaseRecord & {
    recordType: "live_trade_request";
    requestId: string;
    paperTradeId: string;
    eventStartTs: number;
    eventEndTs: number;
    marketSlug: string;
    conditionId: string;
    tokenId: string;
    side: "yes" | "no";
    stakeUsd: number;
    signalTimeSec: number;
    entryTimeSec: number;
    maxPrice: number;
    orderType: "FOK" | "FAK";
};

export type LiveTradeResultRecord = ExecutionLabBaseRecord & {
    recordType: "live_trade_result";
    requestId: string;
    paperTradeId: string;
    status: LiveTradeSubmitStatus;
    reason?: string;
    orderId?: string;
    orderStatus?: string;
    orderSuccess?: boolean;
    submittedPrice?: number;
    submittedShares?: number;
    submittedNotionalUsd?: number;
    filledShares?: number;
    currentAsk?: number;
    maxPrice?: number;
};
```

Update `paper-log-schema.ts` to validate these records. Existing paper logs must remain readable.

## Browser API Contracts

Add functions in `lib/execution-lab/execution-lab-api.ts`:

```ts
submitExecutionLabLiveTrade(request: LiveTradeSubmitRequest): Promise<LiveTradeSubmitResponse>
loadExecutionLabLiveExecutorStatus(): Promise<LiveExecutorStatus>
```

Add Vite plugin endpoints in `lib/execution-lab/execution-lab-vite-plugin.ts`:

```text
GET  /api/execution-lab/live/status
POST /api/execution-lab/live/trade
```

Important endpoint guard:

- Register live trade submission only in `configureServer`, or require an explicit env flag if registered in `configurePreviewServer`.
- Do not accidentally expose live submission in preview builds just because existing Execution Lab endpoints register in both server modes.

## State Management

Extend `ExecutionLabService` with:

- `executionMode: "paper" | "live"`
- `liveTradeInFlightByPaperTradeId: Set<string>`
- `liveTradeSubmittedByPaperTradeId: Set<string>`
- `latestLiveTradeResult`

Persist only non-secret UI settings through `readPersistedJson(...)`:

- stake may persist
- execution mode must not persist in V1; startup always defaults to Paper Trade
- executor path/status should stay env-driven for V1
- secrets never persist in browser storage

Executor-side state:

- keep a small idempotency ledger keyed by `requestId`
- duplicate request returns `status: "duplicate"` with the original known outcome when possible
- write a `pending` ledger entry before signing or posting the order
- update the ledger with the terminal result after the executor receives a response
- if a duplicate finds an existing `pending` entry, return `status: "duplicate"` and `reason: "prior_attempt_unknown"` instead of submitting again
- include a payload hash in the ledger; if the same `requestId` arrives with a different payload hash, reject with `reason: "request_id_payload_mismatch"`
- ledger path must be outside browser storage and must not contain secrets

Strategy Finder also keeps a non-durable Vite-process duplicate ledger for the local endpoint. It coalesces in-flight duplicate submissions, reuses the first result for an identical payload, and rejects the same `requestId` with a different payload hash as `request_id_payload_mismatch`.

Before invoking the executor, Strategy Finder appends the matching `live_*_request` JSONL record. This keeps an audit trail for real side effects even if the executor call, browser session, or local process fails before the result record is written.

Live polling uses the local second-market SQLite DB for complete recent candle ranges when available, then falls back to upstream Binance. Live quotes prefer exact stored second-market CLOB quotes; if the exact latest quote is missing, a same-event local quote up to two seconds old may be used with `recent_local_fallback` quality flags before falling back to live CLOB REST. The executor current-book preflight remains authoritative for real order submission.

## Failure Handling

V1 failure behavior should be simple and explicit:

- If executor is unavailable, log `live_trade_result` with `status: "failed"` and `reason: "executor_unavailable"`.
- If executor is not live-enabled, return/log `status: "rejected"` and `reason: "live_disabled"`.
- If geoblock/eligibility fails, return/log `status: "rejected"` and `reason: "geoblocked"`.
- If the executor cannot complete the geoblock preflight, normalize it to `status: "rejected"` with `reason: "geoblock_check_failed"` and block further Strategy Finder live submissions for the current session.
- If the same paper trade already dispatched in the current session, do not dispatch again.
- If the same `requestId` reaches the executor again, executor returns `status: "duplicate"`.
- If paper entry has no token/market information, do not submit and log `missing_market_identity`.
- If current ask is above `maxPrice`, do not submit and log `price_moved_above_cap`.
- In `fixed` sizing mode, if stake is below exchange minimum after tick/lot/min-size checks, do not auto-upsize.
- If `exchange_min` sizing would require an order above the configured caps, log `status: "rejected"` and `reason: "min_size_exceeds_cap"`.
- If Polymarket says a `FAK`/`FOK` order found no matching liquidity, log `status: "rejected"` and `reason: "no_matching_orders"` instead of treating it as an executor failure.
- If Polymarket returns `delayed`, preserve it as `status: "delayed"` or `orderStatus: "delayed"` with `reason: "order_delayed"`. Do not collapse it into success or failure.
- Do not retry live entry order submission in Strategy Finder V1.

## Live Exit V1.1

Live exit is intentionally conservative:

- Strategy Finder tracks a live position after an entry result is `matched` or `partial`. For limit entries, if an exit-triggered targeted cancel returns `not_canceled`, Strategy Finder promotes the pending limit submission into a provisional live position and submits the normal exit sell.
- When the matching paper trade emits `paper_exit`, Strategy Finder submits `action: "exit"` for the same `tokenId`.
- If the paper trade reaches an executable backtest exit but the exact Polymarket exit quote is missing, Strategy Finder still queues a live exit for the matching tracked live position and anchors the first exit floor to the latest same-event bid when available.
- Exit requests sell the tracked remaining live shares; they do not buy the opposite outcome.
- The exit floor is `min(paperExitPrice, liveEntryPrice) - EXECUTION_LAB_LIVE_EXIT_MAX_SLIPPAGE_CENTS`, clamped to at least `0.01`. This prevents a favorable live entry fill from making the exit floor impossible to reach.
- Strategy Finder preflights the latest same-event bid against that floor and records a local rejected exit attempt every one-second retry cooldown while the bid is already below `minPrice`.
- The executor re-fetches the current book and rejects with `price_moved_below_floor` if best bid is below `minPrice`.
- Exit sizing submits the tracked remaining shares at the lowest valid limit price: `max(minPrice, exchangeMinNotional / shares)`, rounded to tick size. If best bid cannot support that minimum executable price, the executor rejects with `below_exchange_min` and Strategy Finder may retry.
- The executor submits the sell using the configured `FAK`/`FOK` order type. Existing side-repo GTC wind-down logic remains unchanged.
- If a live position remains open after an exit rejection or partial fill, Strategy Finder blocks new same-event live entries with `live_position_open`.
- Exit retries use a 1-second cooldown and a new request id per attempt. Retries stop when the position is closed, the event window is no longer tradeable, or the executor reports an ambiguous accepted state (`delayed`/`posted_live`) that needs reconciliation before another sell attempt is safe.
- If a paper entry and its paper exit are first observed in the same poll batch, Strategy Finder rejects the live entry with `paper_exit_same_tick`; it must not enter live after the paper exit already happened.

## Implementation Phases

### Phase 0: Prove One-Shot Executor

Objective:

Create or confirm a callable executor entrypoint before Strategy Finder can place real orders.

Scope:

- Side repo only.
- No Strategy Finder UI changes required.
- Dry-run and real-live modes must be distinct.

Technical tasks:

- Add an explicit Rust binary in side repo, for example `live_trade_once`.
- Because `Cargo.toml` uses `autobins = false`, register the new binary explicitly.
- Input is `LiveTradeSubmitRequest`-shaped JSON from stdin or `--input path`.
- Output is one `LiveTradeSubmitResponse`-shaped JSON object on stdout.
- Human logs go to stderr or a log file, not stdout.
- Reuse `TradingExecutor::new(...)`, `verify_authentication(...)`, and `buy_at_price(...)`.
- Add current-market preflight:
  - request not expired
  - geoblock/trading eligibility is allowed
  - CLOB market exists for submitted `conditionId`
  - submitted `tokenId` belongs to that market
  - current ask exists
  - current ask <= `maxPrice`
  - stake passes min order size/notional rules
  - balance/allowance/auth are valid enough to submit
- Enforce request `orderType` as the order type used for submission, limited to `FOK` and `FAK`.
- Require an explicit live-enabled env flag before signing or posting real orders.
- Write and read the idempotency ledger before any signing or order submission.

Validation:

- Side repo unit tests for request validation, sizing, and status mapping.
- Side repo unit tests for geoblocked, duplicate-pending, duplicate-completed, payload-hash mismatch, order-type mismatch, and delayed response mapping.
- Manual dry-run with a real current market.
- Manual real-live smoke only after dry-run response is correct.

Exit criteria:

- A deterministic local executor contract exists.
- No browser code is needed for the executor proof.

### Phase 1: Strategy Finder Dry-Run Vertical Slice

Objective:

Add Live Trade mode and produce deterministic request/result logs without calling a real executor.

Scope:

- Strategy Finder only.
- No real order path yet.

Technical tasks:

- Add execution mode UI: Paper Trade / Live Trade.
- Keep existing `startPaper()` behavior intact. Prefer a thin wrapper such as `startExecutionSession()` over broad renaming.
- Add live request/result types and log validation.
- Add `acceptedEntries: ExecutionLabOpenPaperPosition[]` to `ExecutionLabPaperTickResult`.
- Add `lib/execution-lab/live-trade-request.ts`.
- Build deterministic `requestId` from session id, paper trade id, token id, and entry time.
- Use `position.entryPrice + EXECUTION_LAB_LIVE_ENTRY_MAX_SLIPPAGE_CENTS` as `maxPrice`, clamped to `1.00`.
- Add short request expiry, such as `expiresAtSec = now + 10`.
- In Live Trade mode, append `live_trade_request` and synthetic `live_trade_result` with `status: "failed"` and `reason: "executor_unavailable"`.
- Display latest live result in existing status/recent-trades surface.
- Do not persist Live Trade mode. Persist stake only.

Validation:

- `npm run typecheck`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\execution-lab-log-schema.spec.ts`
- Unit test for request construction:
  - YES token for long
  - NO token for short
  - paper entry price plus configured entry slippage becomes `maxPrice`
  - duplicate paper trade does not emit twice

Exit criteria:

- Paper Trade still works.
- Live Trade produces request/result JSONL records.
- No real order can be placed yet.

### Phase 2: Local Executor Adapter Dry-Run

Objective:

Call the Phase 0 executor from Strategy Finder in dry-run mode.

Scope:

- Add Vite endpoints and adapter module.
- Still no real orders.

Technical tasks:

- Add `lib/execution-lab/live-executor-adapter.ts`.
- Add `/api/execution-lab/live/status`.
- Add `/api/execution-lab/live/trade`.
- Configure executor path through env, not a hardcoded absolute path.
- Adapter shells out to one-shot executor and parses structured stdout, or posts the same request to `EXECUTION_LAB_LIVE_EXECUTOR_URL` when that opt-in URL is configured.
- Adapter enforces a process timeout, stdout byte cap, stderr byte cap, and JSON-only stdout parsing.
- Map adapter response to `LiveTradeResultRecord`.
- Ensure all call errors become structured result records.
- Add status fields:
  - `configured`
  - `available`
  - `liveEnabled`
  - `dryRun`
  - `executorKind` (`cli` or `http`)
  - `geoblockAllowed`
  - `maxStakeUsd`
  - `orderType`
  - `supportedOrderTypes`
  - `message`

Validation:

- Adapter mapping test with fake executor output.
- Endpoint test with executor unavailable.
- Endpoint test rejects malformed request.
- Endpoint test maps executor timeout to structured `executor_timeout`.
- Endpoint test maps invalid stdout to structured `executor_invalid_stdout`.
- Manual dry-run with real market preflight.
- `npm run typecheck`
- `npm run test -- execution-lab`

Exit criteria:

- Browser can call local endpoint without secrets.
- Dry-run executor produces one result per accepted live request.
- Endpoint behavior is deterministic when executor is unavailable.

### Phase 3: Real Live Entry Submission

Objective:

Enable real order submission through the executor after dry-run behavior is correct.

Scope:

- Submit one live entry request per accepted paper entry.
- Display and log executor result.
- Signal exits use the Live Exit V1.1 path above; no hedge or opposite-side synthetic exits.
- Taker entries use `FOK` or `FAK`; limit entries use the configured resting type, currently `GTC`.

Technical tasks:

- Require explicit live-enabled configuration in the executor boundary.
- Make UI status clearly say entries are real when live-enabled.
- Add a start-time confirmation gate for Live Trade sessions.
- Validate request `orderMode` and `orderType` against the resolved live config.
- Convert all executor responses into `live_trade_result`.
- Do not summarize `posted_live`, `matched`, `delayed`, `partial`, and `failed` as a single success state.

Validation:

- Review dry-run logs first.
- Manual small-stake live test only after executor status is clean.
- Manual live test only after geoblock status is allowed.
- `npm run typecheck`
- `npm run test -- execution-lab`

Exit criteria:

- Paper Trade still works.
- Live Trade produces one executor request per accepted entry.
- Result is visible and logged.
- No browser secret exposure.

## Future Scope

Only consider after V1 live entries are stable:

- Live order status polling.
- Live position reconciliation.
- Configurable exit retry/cancel controls.
- Limit exits and market/token open-order lookup beyond known Strategy Finder order ids.
- `GTD` support.
- Loopback HTTP executor service.
- Live execution summary dashboard.
- Multi-wallet support.
- Production deployment docs.

## Key Risks And Required Controls

| Risk | Why It Matters | Required Control |
| --- | --- | --- |
| Browser secret exposure | Vite browser code is not a wallet boundary. | Browser sends only non-secret order intent. Executor reads secrets from env/local config. |
| Restricted-location order attempt | Polymarket rejects blocked regions and live trading should fail before signing. | Executor checks geoblock/eligibility before signing and returns `geoblocked`. |
| Wrong market traded | Timestamp re-resolution can cross event boundaries. | Executor validates submitted `conditionId` and `tokenId`; it does not replace them. |
| Stale request | Browser delay or paused tab can submit late. | Include expiry and reject stale requests before signing. |
| Paper quote differs from live book | Paper `entryPrice` is historical decision context. | Treat paper `entryPrice` plus configured entry slippage as `maxPrice`; executor re-fetches current ask and rejects above cap. |
| Limit order rests unfilled | A posted limit is not the same as a filled live position. | Track posted/delayed limit submissions separately and only create live positions from reported fills. |
| Duplicate order | Retry/reload can repeat a valid request. | Deterministic `requestId` plus executor idempotency ledger. |
| Crash during order submission | A process can die after signing/submitting but before returning. | Ledger writes `pending` before signing; duplicate pending returns `prior_attempt_unknown`, never resubmits. |
| Wrong order type | Side-repo defaults can drift away from the resolved UI mode. | Request `orderMode` and `orderType` are authoritative; executor rejects config mismatch. |
| Below exchange minimum | Small stakes can fail min shares/notional. | Executor preflight returns min details; UI logs rejection. |
| Broad cancel-all scope | Account-wide cancellation can affect orders outside Strategy Finder. | Resolved config, UI status, logs, and docs expose `cancelScope`; prefer the narrowest executor-supported scope. |
| Resting unmanaged orders | V1 has cancellation but no polling/reconciliation. | Limit cancel-on-exit targets known posted order ids; posted orders are not treated as positions until fills are reported. |
| Vite endpoint exposure | Existing plugin registers preview endpoints too. | Guard live submission in dev server only or require explicit env flag. |
| Ambiguous order result | Posted, matched, delayed, partial, and failed differ materially. | Preserve structured result status and raw order status. |
| Executor adapter hang or noisy output | A child process can hang or mix logs with JSON. | Adapter uses timeout and output caps; stdout must be a single JSON response and human logs go to stderr. |

## Validation Checklist

Run from this repo after Strategy Finder changes:

```text
npm run typecheck
..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
..\..\..\node_modules\.bin\esno tests\execution-lab-log-schema.spec.ts
npm run test -- execution-lab
```

Run from the side repo after executor changes:

```text
cargo test
cargo run --bin live_trade_once -- --dry-run --input <request.json>
```

Do not run a real live smoke until dry-run validates:

- geoblock/eligibility allowed
- market/token match
- current ask
- min order size
- tick size
- submitted price/notional
- auth readiness
- explicit live-enabled flag
- request order type matches the submitted `FOK`/`FAK`
