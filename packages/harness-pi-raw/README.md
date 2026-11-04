# @local/harness-pi-raw

Internal runtime adapter used by `runcell`.

This package is not part of the public API. Users should import and use
`runcell` from `packages/agent` instead.

## Pi upgrade review

Concurrency limits depend on Pi internals. `pi-provider-gate.ts` wraps the
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
6. Run the tests, the live tests (`RUNCELL_LIVE=1`), and the multi-process
   PostgreSQL tests (`RUNCELL_PG_TEST_URL`).

Last review: Pi 1.5.0. It added no new request path. It added the stream
function identity check, so the gate moved from `agent.streamFunction` to
the session's `ModelRuntime`.
