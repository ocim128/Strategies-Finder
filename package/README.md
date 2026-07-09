# Vendored Polymarket CLOB Client

This directory is a vendored snapshot of `@polymarket/clob-client`.

It is not the Strategy Finder live-trading integration guide. Strategy Finder live order flow is documented in [`../docs/execution-lab-live-trading.md`](../docs/execution-lab-live-trading.md).

Do not put wallet private keys in browser code, examples, or Vite `VITE_*` environment variables. The local executor owns signing and reads secrets from its own server-side environment.
