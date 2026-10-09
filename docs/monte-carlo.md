# Monte Carlo

Open **More → Monte Carlo** after a chart backtest, then click **Run Monte Carlo**.
The service uses `state.currentBacktestResult` and requires at least five trades.
Without a backtest, Run is disabled. An insufficient trade sample is reported in
the status bar.

Sequence randomization shuffles the observed trades; bootstrap resampling draws
trades with replacement. With both enabled, the service runs three scenarios:
sequence only, bootstrap only, and combined. The combined scenario supplies the
main summary, with all three shown in Method Comparison. The seed makes runs
reproducible. Simulation counts are capped according to trade count and active
scenarios; Cancel aborts the running simulation.

Paths use the chart's current capital sizing settings and the Monte Carlo
Initial Capital control. Results include profit, drawdown and Sharpe
distributions, confidence intervals, equity paths and ruin frequency.

## Layout and implementation

- `lib/monte-carlo-service.ts` binds controls and orchestrates simulations.
- `lib/strategies/monte-carlo/monte-carlo-engine.ts` simulates trade paths.
- `lib/monte-carlo-renderer.ts` renders tables and canvas charts.
- `lib/monte-carlo-dom.ts` owns the required DOM contract.
- `html-partials/tab-monte-carlo.html` owns the lazily loaded markup.

The engine owns sequence/bootstrap sampling and path metrics. The older
standalone simulation helpers and unused parameter-perturbation API have been
removed; current Monte Carlo operates on the chart's observed trades.

Every control, result section and the empty state must remain inside
`#montecarloTab`: the lazy loader copies only that root's children. All result
sections belong inside `#mc-results`, while `#mc-empty-state` is its sibling.
An early closing tag can leave IDs in the source but drop them from the runtime
tab, preventing the service from initializing.

Run `npm run test -- monte-carlo feature-dom-contracts.spec.ts` for engine and
parsed-layout regressions. `npm run test:e2e` also opens the lazy tab, publishes
a combined next-open TypeScript backtest with long and short trades, clicks Run,
and verifies all three scenarios render.
