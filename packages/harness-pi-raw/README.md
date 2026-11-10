# @local/harness-pi-raw

Internal runtime adapter used by `runcell`.

This package is not part of the public API. Users should import and use
`runcell` from `packages/agent` instead.

## Cache identity and observations

`providerSessionId` supplies `SessionManager.create(..., { id })` for fresh
journals. `SessionManager.open` retains the resumed journal's identity. This is
separate from the harness/sandbox session id and host mirror directory.

`onProviderRequest` observes settled model-runtime calls with reported usage;
`onEngineEvent` observes Pi retry and compaction lifecycle events. Both are
best-effort and exclude prompt and error text. Request observation uses the same
runtime boundary as the concurrency gate and does not replace Pi's agent stream
function. It does not change cache warming. Parked sessions receive the resuming
run's observers; a session without the required runtime instrumentation restarts
from its journal instead.

Do not introduce shared logical workspace aliases without resolving the
process-global VFS collision risk for concurrent isolated sandboxes.

## Pi upgrade review

Concurrency limits and request observations depend on Pi internals. `pi-provider-gate.ts` wraps the
`streamSimple` and `stream` methods of each session's `ModelRuntime`. A Pi
release can add a request path that skips these methods. Such requests are
not limited, and no test fails. Do this review for every
`@earendil-works/pi-coding-agent` upgrade, including Dependabot PRs:

1. List the request call sites in the old and the new version, and compare
   them:

   ```sh
   grep -rnoE "\.streamSimple\(|\.completeSimple\(|\bstreamSimple\(|\bcompleteSimple\(|streamFunction|streamFn\b|\.stream\(|\.complete\(" \
     node_modules/@earendil-works/pi-coding-agent/dist \
     node_modules/@earendil-works/pi-agent-core/dist --include=*.js \
     | grep -v /bundle/ | sed -E 's/:[0-9]+:/:/' | sort | uniq -c
   ```

2. Make sure that every new call site sends its request through the
   session's `ModelRuntime`. A direct provider call or a new HTTP client
   skips the gate.
3. Make sure that `createAgentSession` still passes its `modelRuntime` to
   the agent's stream function, and that the cache warmer still uses it.
4. Make sure that the virtual-model `api` id is still `"pi-virtual"`
   (`VIRTUAL_MODEL_API` in `dist/core/virtual-models.js`). If it changes,
   one virtual-model request takes two slots and a limiter with one slot
   deadlocks.
5. Read the changelog for changes to request auth or to how Pi identifies
   the agent's stream function. Pi 1.5.0 keys compaction auth on that
   identity (pi #11520), so the gate must not replace the stream function.
6. Check `SessionManager`'s explicit id option, provider `sessionId` propagation,
   and retry/compaction event shapes against `pi-telemetry.ts`. The offline
   `cache-telemetry.test.ts` checks the real Codex payload before any HTTP request.
7. Run the tests, the live tests (`RUNCELL_LIVE=1`), and the multi-process
   PostgreSQL tests (`RUNCELL_PG_TEST_URL`).

Last review: Pi 1.5.0. It added no new request path. It added the stream
function identity check, so the gate moved from `agent.streamFunction` to
the session's `ModelRuntime`.
