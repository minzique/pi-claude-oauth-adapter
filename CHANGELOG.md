# Changelog

All notable changes to `pi-claude-oauth-adapter` live here.

## Unreleased

- Normalize the Claude billing header and identity block on the final provider payload inside the adapter's OAuth `streamSimple`: the caller's `onPayload` (including Pi's `before_provider_request` chain) runs first and its replacement is honored, then the adapter normalizes the result. Nested requests through the model registry (compaction, summaries, extension `complete` calls) now carry billing too, and billing always matches the messages actually sent regardless of extension load order. The body normalization no longer runs in the `before_provider_request` hook; API-key requests are unchanged.

## 0.2.2 — 2026-09-14

- Stop blocking every request with `You're out of usage credits`: `extra_usage.disabled_reason` is set on any account that never enabled extra usage, so it no longer creates a usage-exhausted state on its own. Exhaustion now requires a spent or locked primary limit.
- Import `streamSimpleAnthropic` from `@earendil-works/pi-ai/compat`. Pi's extension loader only aliases the pi-ai root, `/compat`, `/oauth`, and `/providers/all`, so the previous `/api/anthropic-messages` subpath import made the whole extension fail to load.
- Advertise Claude Code `2.1.270`. Anthropic rejects newer models (for example Claude Fable 5.1) when the advertised version is older than the model requires.
- Learn the required version automatically: a `version X or newer is required` rejection is retried once with the demanded version, the result is cached in `~/.cache/pi-claude-oauth-adapter/`, and the published Claude Code release is refreshed at most every 12 hours (`PI_CLAUDE_OAUTH_VERSION_CHECK=0` to disable).
- Send Claude Code client headers (`user-agent`, `x-app`, `x-claude-code-session-id`) on the inference path instead of only on the quota probe, so the version fallback and pi's stale `claude-cli/2.1.75` user agent agree (`PI_CLAUDE_OAUTH_CLIENT_HEADERS=0` to disable).
- Decide `cch` from the model's own base URL instead of only `ANTHROPIC_BASE_URL`.
- Add a vitest suite covering usage parsing, footer status, version handling, and the billing header.
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
