# Execution Lab Plan

## Purpose

Execution Lab is a Strategy Panel tab for live paper trading a selected `1s` Polymarket candidate.

It must:

- stream closed Binance `1s` candles
- evaluate the active Strategy Panel configuration
- fill paper entries/exits from live Polymarket CLOB bid/ask
- show compact paper-session performance metrics
- optionally launch the local `1s` miner used by `scripts/run-1s-miner.bat`
- compare original/current/saved configurations against the active paper-session stream without writing comparison logs
- show YES/NO price lines on the chart
- log compact JSONL records for later analysis
- never place live orders

## Non-Goals

- no real Polymarket order placement
- no speculative future submenus
- no persistent JSONL logging for alternative comparison runs

## Session Snapshot

On `Start Paper`, snapshot:

- strategy key/name
- normalized strategy params
- current `1s` chart symbol
- resolved Polymarket outcome symbol
- backtest settings
- capital settings
- Polymarket settings
- fixed paper stake, default `$5`

Settings changes during a session do not apply until stop/start.

## Backtest Parity

The live stream must use the same trade lifecycle as the `1s` backtest:

- configured trade candidates come from `executeBacktest`
- paper entries only follow backtest trades, not raw strategy signals
- paper exits must follow backtest exits before the Polymarket event ends, including `signal`, `time_stop`, stop loss, take profit, and trailing stop exits
- max one paper position may be open at a time
- a new candidate while a paper position is open logs `paper_unfilled` with `reason: "open_position"`
- positions that reach event end without a resolved outcome move to pending settlement and must not block the next event
- Execution Parity reports paper/backtest lifecycle drift, not raw signal drift
- exact-second quote recovery during normal stream catch-up is not a parity mismatch; missing quotes and lifecycle drift are
- effective Polymarket exit mode is resolved through `resolveEffectivePolymarketExitMode`
- `Allow Multiple Trades Per Event` only applies when the effective mode is `signal_exit_same_event`

## Data Sources

Use local Vite APIs:

- `/api/execution-lab/live-candles` for Binance `1s` candles
- `/api/execution-lab/live-events` for active Gamma market token ids
- `/api/execution-lab/live-quote` for live CLOB bid/ask
- `/api/execution-lab/live-outcomes` for closed event settlement
- `/api/second-market/clob-quotes` for exact historical CLOB quotes used by missed-fill recovery and alternative replay
- `/api/execution-lab/miner/status`, `/api/execution-lab/miner/start`, and `/api/execution-lab/miner/stop` for local miner lifecycle
- `/api/execution-lab/session/start`, `/api/execution-lab/log`, and `/api/execution-lab/logs` for JSONL logs

Execution Lab paper sessions must not require the local second-market SQLite DB to start. The miner controls launch `scripts/second-market-miner.ts --mode live --symbols BTCUSDT,XRPUSDT --db price-data/1second-chart/second-market-data.sqlite`, matching `scripts/run-1s-miner.bat`, and write a latest-run log under `price-data/1second-chart/logs/`.

## Candle Rule

Evaluate only closed `1s` candles.

The stream time is the latest Binance candle timestamp. Gamma/CLOB timestamps do not advance strategy evaluation.

## Fill Rule

Paper fills use exact-second CLOB bid/ask:

- long trade = buy YES
- short trade = buy NO
- entry = ask
- backtest exit before event end = bid
- event settlement = `1` for the winning side and `0` for the losing side

Entry quote match must include:

- outcome symbol
- series id
- event start timestamp
- token ids
- exact fill timestamp

For exits, use only a captured quote at the exact backtest exit timestamp. If no exit quote was captured for that second, log `paper_unfilled` with `reason: "missing_exit_quote"` and remove the active paper position without realizing PnL, so a missed quote cannot become a fake late fill.

When a fill timestamp is already historical, recover the quote from the local second-market SQLite DB. Do not call the live CLOB price endpoint and label the current book as an old `sample_ts`.

## PnL

Default stake:

```text
stakeUsd = 5
```

For each filled entry:

```text
shares = stakeUsd / entryPrice
pnlUsd = shares * (exitPrice - entryPrice)
roiPct = pnlUsd / stakeUsd * 100
```

## Log Records

JSONL path:

```text
logs/paper-execution/<strategy-key>/<symbol>/<yyyy-mm-dd>/<session-id>.jsonl
```

Record types:

- `session_start`
- `signal_seen`
- `paper_entry`
- `paper_unfilled`
- `paper_exit`
- `paper_resolution_pending`
- `execution_parity_mismatch`
- `session_stop`

`paper_unfilled.reason` values:

- `missing_event`
- `missing_entry_quote`
- `missing_exit_quote`
- `duplicate_event`
- `open_position`
- `invalid_price`
- `entry_price_filtered`

## UI

The tab is `data-tab="executionlab"` and root is `#executionlabTab`.

Show:

- session config snapshot
- 1s miner status and controls
- latest stream candle time
- YES/NO bid/ask/mid
- feed lag and quote age
- active event
- latest executed signal
- execution parity and mismatch detail
- open paper position
- pending settlement count
- realized PnL
- compact performance metrics: trades, entries, win rate, profit factor, expectancy, average win/loss, total PnL
- alternative view metrics for original paper trade, current settings, or a saved configuration
- recent closed paper trades
- JSONL path

Alternative views reuse the active session candles, start scoring after the `Start Paper` baseline candle, merge local second-market DB quotes with captured live quotes, and run an in-memory comparison only. They must not append `paper_*`, parity, or session records to the JSONL log.

Chart overlays:

- live Binance `1s` candles
- YES/NO CLOB mid lines
- paper entry/exit markers only

## Validation

Required checks:

```bash
npm run typecheck
npm run test -- execution-lab
npm run test
npm run build
```
