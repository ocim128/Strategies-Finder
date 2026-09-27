# Finder Arm Performance

Status: **Implemented.** This delivery plan is retired; the maintained guides
now describe the supported behavior:

- [Finder scope, metrics, Apply, and Re-Sort](finder.md#arm-performance)
- [Server lifecycle, ownership, teardown, and reattach](finder-server-side.md#arm-performance)

The implemented ranking is descending `topMean` at one explicit horizon.
All 15 TOP_MEAN arms are produced per configuration; Grid and Random are
supported; the pair list is explicit and capped at 5,000; Full and UTC Date
range replay windows are supported. The Finder server retains compact
terminal rows and frozen run context while it owns the sweep.

Scale smoke results must be recorded with the release or research run. The
maintained guides describe the current limitations, including the absence of
an atomic market-data snapshot and the fact that the bootstrap interval does
not correct for configuration search.
