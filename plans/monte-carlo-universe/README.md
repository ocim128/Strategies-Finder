# Universe Monte Carlo plan

Status: **planned, not implemented**. Based on HEAD `de390aae`, reviewed
2026-10-23. This revision simplifies the design and retains both audits'
numerical corrections. Recheck current source before implementation.

## Read order and authority

| File | Owns |
| --- | --- |
| This file | Product scope and user workflow. |
| [technical-design.md](technical-design.md) | Exact formulas, interfaces, limits, and failure rules. |
| [implementation.md](implementation.md) | File ownership and ordered delivery checklist. |
| [validation.md](validation.md) | Independent examples and acceptance checks. |

These files form one plan. Use the owning file for each decision. Later user
instructions override the plan. New names are proposed, not existing APIs.
Plans stay outside `docs/` under the
[documentation policy](../../docs/README.md#maintenance-rules); shipped behavior
belongs in [the Monte Carlo guide](../../docs/monte-carlo.md).

## Goal

Add **Symbol Universe** beside **Current Chart** in the Monte Carlo tab. Run
one captured strategy configuration across a list, bootstrap each instrument's
observed trades, and show which instruments satisfy two robustness conditions.

The main result is **universe pass rate plus coverage**, supported by a sortable
table. Each instrument has its own capital account and counts once. There is
no pooled trade sample or combined portfolio equity curve.

## V1 scope

| Area | Decision |
| --- | --- |
| Strategy | Current entry strategy/parameters, confirmation rules, active exit override, costs, and execution settings. One configuration; no search. |
| Universe | Paste the existing Batch symbol syntax. Copy from Finder Universe copies its current list without changing Finder. |
| Instruments | Ordinary symbols, ratio pairs `BASE+QUOTE`, and equal-dollar pairs `BASE+QUOTE@` / `@50/50`. |
| Time and source | Capture interval, inclusive chart date selection, provider/Spot/Futures context, and one server as-of time. |
| Capital | MC Initial Capital seeds both the universe backtests and simulations. Support fixed and percent sizing. |
| Partial exits | Unsupported in Universe v1; reject explicitly. Existing chart partial-record sizing stays unchanged. |
| Method | Bootstrap only. Existing Current Chart methods remain available in chart mode. |
| Defaults | 1,000 paths, seed 1337, minimum 30 trade records, at least 90% profitable paths, P95 simulated drawdown at most 20%. These are editable screening settings. |
| Results | Coverage summary, sortable table with 100 rows per UI page, selected-row detail, Copy CSV, Download JSON. |
| Execution | Local Vite backend; one worker; bounded status snapshots; browser reload reattachment. No browser compute fallback. |
| Retention | Keep the latest terminal result and the active run. Replace the old result after the new run terminates. No history browser or expiry scheduler. |

Deferred: portfolio Monte Carlo, extra Universe simulation methods, smart
sizing, fraction-preserving partial exits, parameter discovery, automatic
universe generation, OOS optimization, parallel worker pools, and resuming
computation after a server restart. Preserve retired-feature removals.

## User workflow

1. Choose Symbol Universe, paste/copy instruments, and review the captured
   strategy summary. No prior chart backtest is required.
2. Set paths, capital, minimum trade count, and the two pass conditions. Put
   seed and ruin threshold under Advanced.
3. Click Run. Show the current instrument/stage and processed/requested counts.
4. Read the coverage summary and sort the table. Example:
   **34/50 eligible instruments pass (68%); 60 requested, 8 insufficient,
   2 load failures. Complete.**
5. After termination, open a row's saved detail or export the inventory.

Table columns: instrument/mode, actual date coverage, bars, trade records,
observed account return, profitable-path percentage, median simulated return,
P95 simulated closed-trade drawdown, status/verdict, and Details.

Default order: Pass first, profitable-path percentage descending, P95 drawdown
ascending, canonical key ascending. Column buttons sort numerically, keep
missing values last, and use canonical key for ties.

Keep the coverage denominator beside pass rate. Zero eligible instruments
means **No eligible instruments**, with no percentage. Running, cancelled,
failed, and interrupted runs say **Partial**. Failed/excluded rows remain visible.

Edits apply to the next run; existing results retain their captured metadata.
Chart changes and tab switches do not cancel a Universe job. Details do not
load an instrument onto the live chart. A static site without the backend shows
that Universe requires the local research server; Current Chart still works.

## Non-negotiable correctness

The technical design defines the audited allocation formulas, partial-exit
gate, overflow handling, and legacy detail units. Implement those rules before
adding orchestration. Correct chart 50/50 normalization and non-finite success
results; preserve other valid chart outputs, including its existing partial
record behavior. Simulated drawdown measures equity after closed trades, not
intratrade or combined-portfolio risk.

## Completion

- [x] Planning and audit revisions.
- [ ] Complete the implementation checklist and acceptance checks.
- [ ] Update maintained Monte Carlo/synthetic-pair guides and retire this plan.

Planning does not establish that any runtime defect has been fixed.
