# Execution Lab Live Trading

Execution Lab is the only browser surface that can dispatch live Polymarket orders. Paper Trade remains the startup default. Live Trade is a local executor integration, not a browser wallet path and not the Polymarket bridge export path.

## Runtime Boundary

- Browser code sends non-secret order intent to the Vite dev server.
- The Vite plugin in `lib/execution-lab/execution-lab-vite-plugin.ts` resolves local executor config and invokes either an HTTP loopback executor or the one-shot CLI executor.
- Wallet secrets stay in the executor process environment. They must not be sent to the browser, localStorage, request JSON, or JSONL logs.
- Live submission is enabled in the Vite dev-server path. Preview live trading stays disabled unless `EXECUTION_LAB_ALLOW_LIVE_TRADE_PREVIEW=1`.

Core files:

- `html-partials/tab-execution-lab.html`
- `lib/execution-lab/execution-lab-service.ts`
- `lib/execution-lab/live-trade-request.ts`
- `lib/execution-lab/live-executor-adapter.ts`
- `lib/execution-lab/execution-lab-vite-plugin.ts`

## Supported Chart Contract

Use live trading only on supported `1s` BTCUSDT/XRPUSDT charts with Polymarket CLOB timing:

- `signal_close`
- `next_open`
- `next_close`

Paper/live entry decisions use the same selected YES/NO token as the paper decision path. Live exits sell tracked filled shares for that same token. Strategy Finder does not buy the opposite outcome as an exit hedge.

## Strategy Finder Environment

Configured in `.env` on the Strategy Finder side:

- `EXECUTION_LAB_LIVE_EXECUTOR_PATH` - path to the one-shot executor binary.
- `EXECUTION_LAB_LIVE_EXECUTOR_CWD` - optional working directory when the binary is not under the side repo's `target/debug` or `target/release`.
- `EXECUTION_LAB_LIVE_EXECUTOR_ARGS_JSON` - optional JSON array of extra CLI args.
- `EXECUTION_LAB_LIVE_EXECUTOR_URL` - optional loopback-only HTTP executor URL. Must target `localhost`, `127.0.0.1`, or `::1` without credentials.
- `EXECUTION_LAB_LIVE_ENABLED` - hard Strategy Finder enablement flag. Keep `0` until dry-run preflight is correct.
- `EXECUTION_LAB_LIVE_MAX_STAKE_USD` - local UI/server stake cap.
- `EXECUTION_LAB_LIVE_SIZING_MODE` - `fixed` or `exchange_min`.
- `EXECUTION_LAB_LIVE_EXIT_MAX_SLIPPAGE_CENTS` - fallback exit floor offset.
- `EXECUTION_LAB_LIVE_TIMEOUT_MS`
- `EXECUTION_LAB_LIVE_STDOUT_LIMIT_BYTES`
- `EXECUTION_LAB_LIVE_STDERR_LIMIT_BYTES`
- `EXECUTION_LAB_LIVE_GEOBLOCK_ALLOWED` - status display hint only; the executor performs the real check.
- `EXECUTION_LAB_ALLOW_LIVE_TRADE_PREVIEW` - keep `0` unless explicitly testing preview live trading.

The example file also includes side-executor variables for local convenience, but the executor process owns their semantics:

- `POLYMARKET_PRIVATE_KEY`
- `POLYMARKET_PROXY_ADDRESS`
- `CLOB_SIGNATURE_TYPE`
- `ARBITRAGE_ORDER_TYPE`
- `MAX_ORDER_SIZE_USD`
- `DRY_RUN`
- `LIVE_TRADE_ONCE_LIVE_ENABLED`
- `LIVE_TRADE_ONCE_LEDGER_PATH`

Do not prefix secrets with `VITE_`; `VITE_*` values are exposed to the browser bundle.

## HTTP vs CLI Executor

When `EXECUTION_LAB_LIVE_EXECUTOR_URL` is set, Strategy Finder tries HTTP mode first. The URL must be loopback-only.

Fallback behavior:

- Connection unavailable plus a valid CLI path/cwd can fall back to the one-shot CLI executor.
- Reached HTTP errors and timeouts do not fall back, because executor state may be ambiguous.
- Duplicate live request ids are coalesced by a process-local Strategy Finder ledger before invoking the executor. The executor still owns durable idempotency.

## Order Lifecycle

- Taker entries buy the selected YES/NO token with `maxPrice` capped by the paper entry price plus configured entry slippage.
- Limit entries submit immediately with `limitPrice` derived from the paper entry reference price, optional UI offset, and optional fixed cap. A posted limit is not a tracked live position until the executor reports filled shares.
- Exits sell tracked filled shares with `minPrice` floored by configured slippage against the lower of paper exit price and actual live entry fill.
- Known posted Strategy Finder order ids are targeted-canceled on paper exit by default. Broad account cancellation requires explicit config and is shown in UI/log status.
- Rejected or failed exits can retry with fresh request ids while the event remains tradeable.
- Ambiguous accepted states such as delayed or posted live stop blind retries until reconciliation.
- Order-status polling is not implemented. Posted TP state is tracked locally by request/order id.

## Protective TP/SL

Execution Lab has separate `Poly TP` and `Poly SL` controls in the Live Config panel. These are Execution Lab settings, not the global Polymarket Settings rows.

- With Live Trade active, a confirmed live entry and enabled TP immediately submit a resting GTC sell-limit for the filled shares.
- If the paper TP fires while a resting TP is still tracked, Strategy Finder target-cancels the resting TP before using the tracked-share taker exit path.
- SL remains a tracked-share taker exit when the paper SL trigger fires.
- In `resolve_hold`, Execution Lab treats the position as hold-to-resolution. Chart exits, time stops, signal exits, and Execution Lab TP/SL do not submit a live sell.

## Logging And Safety

- Paper and live records are JSONL logs; they must not contain private keys.
- Strategy Finder writes `live_*_request` before invoking the executor and writes the result after the adapter returns.
- Live request/result records can include resolved non-secret metadata such as `dryRun`, `liveEnabled`, `executorKind`, `sizingMode`, and `latencyMs`.
- Executor geoblock preflight failures are treated as live safety rejections and block further Strategy Finder live submissions for the current session.

## Validation

Run focused tests after live-trade changes:

```bash
npm run typecheck
npm run test -- execution-lab
..\..\..\node_modules\.bin\esno tests\execution-lab-live-trade-request.spec.ts
..\..\..\node_modules\.bin\esno tests\execution-lab-live-executor-adapter.spec.ts
..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts
```
