# Server-Side Finder Symbol Universe

Finder Symbol Universe runs in the Vite server process. The server retains
full OHLCV datasets during evaluation; the browser receives scalar survivor
rows and runs the existing OOS validation on the final merged candidates.
Current-chart Finder remains browser-side.

## Runtime contract

- Start with `npm run dev` for development. `vite preview` also registers the
  Finder Universe endpoint; a static-only deployment does not.
- Each selected entry strategy is submitted as one sequential server request.
  The browser merges and sorts survivors across requests before OOS validation.
- Polymarket scoring remains unsupported in Symbol Universe scope.
- Stop posts `/api/finder/stop` and also cancels browser-side OOS work.
- Tab reload reattach is not supported. `/api/finder/status` is used only to
  recover an interrupted terminal stream after the server has completed.

## Memory

Large universes require a larger Node heap:

```powershell
$env:NODE_OPTIONS="--max-old-space-size=16384"; npm run dev
```

`run_playground.bat` applies this default unless a heap value is already set.
The server rejects 400-799 symbols below 8192 MB and 800+ below 12288 MB.

## Wire contract

`FinderUniverseCandidate` is scalar-only. `toScalarCandidate(...)` and
`assertCandidateIsScalar(...)` reject `data`, `signals`, `trades`, and
`equityCurve` before streaming.

| Event | Purpose |
| --- | --- |
| `start` | Declares symbol/candidate counts and strategy key. |
| `progress` | Updates bounded progress and status. |
| `candidate` | Streams a scalar survivor. |
| `symbol_failed` | Reports one dataset failure. |
| `done` | Supplies the authoritative final slice, totals, and diagnostics. |
| `fatal` | Terminates the run with an error. |

The terminal `done.candidates` slice is authoritative. If the NDJSON stream
ends early, the client checks `/api/finder/status`; provisional candidates are
never accepted as a completed result.

## Data flow

The server loader reuses `createBatchDatasetLoaderCore`, preserving Batch
synthetic-pair construction, cache limits, gap filling, and data slicing. The
server evaluates IS candidates and releases datasets when the request ends.
There is no Mine artifact directory or TTL. The browser then reloads only the
survivor datasets needed by `applyUniverseOosValidationIfNeeded`.

Server-side modules imported by `vite.config.ts` must not import browser-bound
managers or anything that transitively imports `lightweight-charts`.

## Validation

- `npm run typecheck`
- `npm run typecheck:tests`
- `..\..\..\node_modules\.bin\esno tests\finder-server-plugin.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-server-loader-parity.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\finder-universe-runner.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`

Manual smoke: run one and multiple strategies over 50 symbols, then 400
symbols with the larger heap. Confirm progress scaling, Stop, diagnostics,
merged sorting, and OOS filtering.
