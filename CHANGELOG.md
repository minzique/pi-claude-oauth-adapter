# Changelog

All notable changes to `pi-claude-oauth-adapter` live here.

## Unreleased

- `prepend-custom-message` now injects the docs block at the start of the conversation and keeps it there once any user message mentions a Pi topic. It used to sit in front of the latest user message and only appear when the current prompt matched, so the block moved between requests and the provider re-billed everything after the old position, usually the whole previous turn. The decision now reads only persisted messages (user messages plus compaction and branch summaries), so it holds across `pi -c`, resume, fork, and compaction, as long as the compacted summary still mentions Pi. The billing header now skips the injected block when sampling the first user message.

## 0.2.2 — 2026-08-22

- Migrate Pi runtime imports and peer dependencies to the `@earendil-works/*` package scope.

## 0.2.1 — 2026-08-22

- Move the package into its own standalone repository.
- Update npm metadata and local-development instructions for the new repository.
- Add a real TypeScript check and the previously missing MIT license file.

## 0.2.0 — 2026-08-08

- Sync the injected Claude billing header to Claude Code `2.1.226`, including conditional first-party `cch=00000` handling.
- Match the Claude Code quota probe more closely with the external CLI user agent and OAuth-only beta header for the Haiku probe.
- Prefer Claude Code's `GET /api/oauth/usage` check before falling back to the synthetic `max_tokens: 1` messages probe.
- Parse new unified rate-limit metadata for `7d_oi` / Fable 5 limits, overage utilization, overage in-use state, and grace-window warnings.
- Update usage-credit labels and disabled-reason messages to match the current Claude Code wording.

## 0.1.4 — 2026-05-03

- Sync the injected Claude billing header to Claude Code `2.1.126` while keeping the same hash salt and message-character sampling shape.
- Preserve newly observed unified rate-limit metadata (`fallback` availability and comma-separated `upgrade-paths`) for debug/status decisions.
- Treat 429 responses with representative-claim or overage headers but no explicit unified status as rejected, matching Claude Code's current fallback error path.

## 0.1.3 — 2026-04-23

- Surface Claude usage-limit state on the real 429 path by running a follow-up quota check and rewriting Anthropic's generic `rate_limit_error` into Claude-style limit/reset messages.
- Sync the injected Claude billing header to Claude Code `2.1.118` semantics (`cc_version`, fixed `cch=00000`, optional `cc_workload`).
- Stop Pi auto-retry thrash on Anthropic subscription limits by replacing the retryable `429` error text with the resolved Claude usage-limit message.
- Document that full `user-agent` parity belongs in `@mariozechner/pi-ai`, not this package, because package-level provider overrides are provider-wide rather than OAuth-scoped.

## 0.1.2 — 2026-04-17

- Added adapter health status in Pi's footer so Anthropic OAuth sessions can show `✓ Claude OAuth ready`, `✓ Claude OAuth active`, or `⚠ Claude OAuth setup`.
- Exposed the `claude-oauth-ready` and `claude-oauth-issue` status keys for Pi runtimes that want to gate the generic Anthropic subscription warning on real adapter readiness.
- Refreshed the package README so npm users get install, verification, and release guidance instead of repo-local notes only.

## 0.1.1 — 2026-04-17

- Hardened optional debug logging for adapter troubleshooting.

## 0.1.0 — 2026-04-08

- Initial public release of the Anthropic OAuth compatibility adapter for Pi.
