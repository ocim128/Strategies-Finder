// Test-only ambient type alias for the branded `Time` type from lightweight-charts.
// Test fixtures assign plain numbers to Time-typed fields (entryTime, exitTime,
// OHLCVData.time, etc.). `Time` is a branded UTCTimestamp so plain numbers do not
// satisfy it. This alias lets specs annotate numeric fixtures without per-site
// `as Time` casts, while still failing to typecheck if a non-number is used.
type TestTime = import("lightweight-charts").Time & number;
