# Execution Lab Live Trade Hardening Plan

## Purpose

Plan and track small, speed-first hardening changes for Execution Lab live Polymarket trading.

## Scope

Included:

- Bind live trade and cancel submissions to active Execution Lab sessions.
- Restrict HTTP executor URLs to loopback hosts by default.
- Preserve endpoint rejection categories across the browser-to-Vite boundary.
- Add a performance-neutral HTTP executor response-size fast guard.
- Add optional non-secret live executor metadata already available on the existing path.
- Update live-trade documentation and focused tests.

Excluded:

- No strategy, Finder, Hunt, Worker, bridge export, charting, or Polymarket scoring changes.
- No side-executor implementation changes.
- No executor health probes, status polling, startup network preflights, or extra live submission round trips.
- No new database tables, migrations, localStorage keys, or UI storage for executor config/secrets.
- No broad adapter refactor, order-status polling, reconciliation feature, or diagnostics expansion.

## Current Architecture

- Browser orchestration and live session state: `lib/execution-lab/execution-lab-service.ts`.
- Browser API wrapper: `lib/execution-lab/execution-lab-api.ts`.
- Vite local endpoints and process-local ledgers: `lib/execution-lab/execution-lab-vite-plugin.ts`.
- Request validation, response normalization, and JSONL builders: `lib/execution-lab/live-trade-request.ts`.
- Executor config and CLI/HTTP adapter: `lib/execution-lab/live-executor-adapter.ts`.
- Shared live types: `lib/execution-lab/execution-lab-model.ts`.
- JSONL schema validation: `lib/execution-lab/paper-log-schema.ts`.
- Operational docs: `docs/live-trade-plan.md`, `docs/polymarket.md`.

## Assumptions And Unknowns

Assumptions:

- Strategy Finder remains a local Vite boundary for live trade submission.
- Browser code sends non-secret order intent only.
- The side executor remains the secret-bearing and durable idempotency boundary.
- Process-local Vite ledgers are useful for duplicate coalescing but are not durable safety storage.
- HTTP executor mode is intended for loopback use.

Unknowns:

- Whether any local workflow intentionally uses a non-loopback HTTP executor.
- Whether future side-executor responses will include transport metadata.

Default for unknowns: fail closed without adding latency. Add explicit opt-ins only when a real workflow requires them.

## Data Flow

Current live submission flow:

1. `execution-lab-service.ts` builds a live trade/cancel request from accepted paper decisions.
2. Service writes the matching `live_*_request` JSONL record.
3. Service posts through `execution-lab-api.ts`.
4. `execution-lab-vite-plugin.ts` validates, deduplicates, and dispatches to `live-executor-adapter.ts`.
5. Adapter calls the local HTTP executor or one-shot CLI executor.
6. Service writes the live result record and updates local live-position state.

Target additions:

- Vite endpoint performs a cheap active-session check before status resolution, validation, ledger insertion, or executor dispatch.
- API wrapper throws a typed error for endpoint failures so service code can record endpoint-specific failure categories.
- Adapter rejects loopback-unsafe executor URLs during config resolution.
- Adapter rejects declared over-limit HTTP responses from `Content-Length` before buffering.
- JSONL builders include only already-known non-secret metadata: `executorKind`, `liveEnabled`, existing `dryRun`, existing `sizingMode`, and `latencyMs`.

## Performance Considerations

Execution speed takes priority over low-impact hardening.

- Live submit/cancel adds only an O(1) `Map.has(sessionId)` check before existing work.
- No executor health probe, extra browser-to-Vite call, executor request, database query, or poll-loop traversal is added.
- HTTP response handling keeps the existing `response.text()` path for normal responses.
- Unknown-length HTTP responses remain capped after read by the existing byte check; streaming caps are deferred to avoid unproven latency cost.
- Metadata is assembled from current in-memory status/context only.

## Security Considerations

- Live endpoints must reject out-of-session requests before executor dispatch.
- HTTP executor URLs must be `http`/`https` on `localhost`, `127.0.0.1`, or `::1`, with no username or password.
- JSONL metadata must not include executor path, cwd, args, URL, wallet address, headers, signatures, private keys, or full payload hashes.
- Broad cancel scope remains explicit and unchanged.

## Phase 1: Session-Bound Endpoints And Loopback URL

### Objective

Block live executor dispatch from stale/out-of-session requests and unsafe HTTP executor URLs.

### Scope

- `/api/execution-lab/live/trade`
- `/api/execution-lab/live/cancel-all`
- `live-executor-adapter.ts` URL parsing
- focused middleware and adapter tests

### Technical Tasks

- Extract `sessionId` from the JSON body immediately after body parsing.
- Reject missing or inactive sessions with HTTP 404 and `Unknown execution lab session`.
- Keep full live request validation after the active-session gate.
- Reject HTTP executor URLs with remote hosts or embedded credentials.
- Preserve existing CLI fallback behavior for unreachable loopback HTTP executors.

### Dependencies

- Existing `sessions` map in `execution-lab-vite-plugin.ts`.
- Existing live request validators in `live-trade-request.ts`.
- Existing adapter config resolution in `live-executor-adapter.ts`.

### Risks/Blockers

- Direct endpoint tests need to create a session first unless they intentionally assert unknown-session rejection.
- A non-loopback HTTP executor workflow would now be rejected by default.

### Deliverables

- Active-session guard on live trade and cancel endpoints.
- Loopback-only HTTP executor URL parsing.
- Tests for valid in-session live calls, unknown-session rejection, remote URL rejection, and credentialed URL rejection.

### Validation/Testing Criteria

- `..\..\..\node_modules\.bin\esno tests\execution-lab-live-quote.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\execution-lab-live-executor-adapter.spec.ts`
- `npm run typecheck`

### Exit Criteria

- No live endpoint path can invoke the executor adapter without an active session.
- Unknown sessions are rejected before live status resolution or ledger insertion.
- Existing valid live endpoint behavior remains intact.

## Phase 2: Structured Endpoint Failure Propagation

### Objective

Avoid mislabeling local endpoint failures as executor transport failures.

### Scope

- `execution-lab-api.ts`
- live submission catch blocks in `execution-lab-service.ts`

### Technical Tasks

- Add a typed API error carrying endpoint, HTTP status, and endpoint error text.
- Map known endpoint failures to stable live result reasons:
  - `unknown_execution_lab_session`
  - `live_endpoint_rejected`
  - `live_endpoint_error`
  - `live_endpoint_timeout`
  - `live_endpoint_unavailable`
- Preserve current `ok: true` executor-level rejection semantics.

### Dependencies

- Phase 1 active-session guard.
- Existing `buildLiveTradeFailureResponse(...)` and `buildLiveCancelAllFailureResponse(...)`.

### Risks/Blockers

- Endpoint error text can be free-form; keep result reasons categorical and stable.
- Browser/network aborts vary by runtime; only map clear `AbortError` to timeout.

### Deliverables

- Typed API error class/helper.
- Service catch paths that preserve endpoint-failure categories.

### Validation/Testing Criteria

- `..\..\..\node_modules\.bin\esno tests\execution-lab-live-quote.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\execution-lab-live-trade-request.spec.ts`
- `npm run typecheck`

### Exit Criteria

- Endpoint validation/session failures no longer collapse into `executor_unavailable`.
- Executor-level failures still use existing executor reasons.

## Phase 3: HTTP Response Size Fast Guard

### Objective

Reject declared oversized HTTP executor responses before buffering without slowing successful small responses.

### Scope

- `live-executor-adapter.ts`
- adapter tests

### Technical Tasks

- Read `Content-Length` after the HTTP executor response arrives.
- If the declared length is finite and greater than the configured byte limit, return `executor_invalid_stdout` without calling `response.text()`.
- Keep the existing post-read byte check for missing/invalid length headers.
- Do not add stream-reading until it is proven latency-neutral.

### Dependencies

- Existing `stdoutByteLimit`/`stderrByteLimit` config.
- Existing HTTP executor path in `postExecutorJson(...)`.

### Risks/Blockers

- Unknown-length responses remain fully read before the existing post-read cap.
- Some servers omit or misstate `Content-Length`; the post-read cap remains authoritative.

### Deliverables

- `Content-Length` over-limit fast rejection.
- Test proving over-limit declared length does not read the body.

### Validation/Testing Criteria

- `..\..\..\node_modules\.bin\esno tests\execution-lab-live-executor-adapter.spec.ts`
- `npm run typecheck`

### Exit Criteria

- Declared oversized HTTP executor responses are rejected before buffering.
- Normal HTTP executor response handling remains the existing `response.text()` path.

## Phase 4: Cheap JSONL Metadata

### Objective

Improve incident review without extra calls or poll-loop work.

### Scope

- `execution-lab-model.ts`
- `live-trade-request.ts`
- `paper-log-schema.ts`
- `execution-lab-service.ts`
- JSONL schema tests

### Technical Tasks

- Add optional `executorKind?: "cli" | "http"` and `liveEnabled?: boolean` to live request/result records.
- Reuse existing `dryRun`, `sizingMode`, and `latencyMs` context.
- Populate metadata only from `currentLiveExecutorStatus()` and existing timing context.
- Validate optional metadata in `paper-log-schema.ts`.

### Dependencies

- Existing live status cache in `execution-lab-service.ts`.
- Existing live record builders.

### Risks/Blockers

- Metadata may be absent when no current status is cached; this is acceptable and avoids extra calls.
- Old JSONL records must remain valid.

### Deliverables

- Backwards-compatible optional JSONL fields.
- Schema tests covering the new fields.

### Validation/Testing Criteria

- `..\..\..\node_modules\.bin\esno tests\execution-lab-log-schema.spec.ts`
- `..\..\..\node_modules\.bin\esno tests\execution-lab-live-trade-request.spec.ts`
- `npm run typecheck`

### Exit Criteria

- New records validate.
- Old records remain valid.
- No secret-bearing or path/URL fields are exposed.

## Phase 5: Documentation And Final Validation

### Objective

Keep the live-trade operational contract aligned with implemented behavior.

### Scope

- `docs/live-trade-plan.md`
- `docs/polymarket.md`
- focused tests

### Technical Tasks

- Document active-session requirements for live endpoints.
- Document loopback-only HTTP executor URL behavior.
- Document no health probes or new hot-path calls.
- Document `Content-Length` response cap behavior.
- Document cheap non-secret live metadata.

### Dependencies

- Phases 1-4 complete.

### Risks/Blockers

- Docs must not claim startup health checks, transport fallback metadata, payload-hash logging, or diagnostics work that was not implemented.

### Deliverables

- Updated docs matching the actual implementation.
- Test results recorded in implementation summary.

### Validation/Testing Criteria

- `npm run typecheck`
- `npm run test -- execution-lab`
- `..\..\..\node_modules\.bin\esno tests\feature-dom-contracts.spec.ts`

### Exit Criteria

- Docs and tests reflect implemented behavior.
- No planned hardening item remains overstated.

## Rollback Strategy

- Revert phases independently if needed.
- Optional JSONL fields are backwards-compatible and require no migration.
- If loopback-only executor URLs block a real workflow, add an explicit env opt-in instead of silently broadening defaults.
- If any latency regression is measured, keep Phase 1 and URL hardening and revert response-size or metadata additions first.

## Edge Cases

- Duplicate request id with a different payload remains `request_id_payload_mismatch`.
- Duplicate request id with the same payload remains process-local coalesced.
- Unknown session rejects before status resolution, ledger insertion, and executor invocation.
- HTTP executor timeout remains terminal; no CLI fallback after a timeout.
- HTTP connection unavailable can still fallback to CLI when CLI is valid.
- Paper Trade remains the startup default and is unaffected.
