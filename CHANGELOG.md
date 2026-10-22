# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Security
- The web UI now answers only to its own addresses: `127.0.0.1`, `localhost` and `[::1]` on the listening port, plus the host of the new `SMB_UI_URL` setting if you set it. Any other host name gets `421`. If you reach the UI by another name, such as a proxy address or a server's IP, set `SMB_UI_URL` to it (see Exposing the UI in the configuration docs).
- State-changing requests from the UI must now carry a same-site `Origin` (or `Referer`); requests without one, or with `Origin: null`, are refused with `403`.
- The form token cookie is now `HttpOnly`.

### Fixed
- Telemetry payloads are checked against a fixed list of fields per event, each limited to a set value, bucket, flag or small count. Previously only long strings were refused, so an identifier such as an ID, address, click ID, email or hostname could have been sent if code ever passed one. Anything outside the list is now refused and the event is dropped. [TELEMETRY.md](TELEMETRY.md) is updated.
- Telemetry wire format, as a result of that check: Node is sent as its major version only; durations (uptime, hours since install), counters and per-rule counts are sent as bucket labels; the site count is capped at 1000; the version is the toolkit's own version only; an error is reported as one of a fixed list of class names (`OtherError` otherwise). Each event also asks the receiving service not to look up a location.

## [1.1.0] — 2026-10-12

### Added
- **AI assistants (MCP).** `/mcp` serves Claude Code, Claude Desktop, Cursor and other MCP clients over Streamable HTTP: 13 tools (sites and tag health, summaries, flagged clicks, breakdowns, repeat offenders, IP history, CRM lead matching, saved analyses, claim window, notices, rules, run analysis, build claim package) and 3 prompts (audit CRM leads, weekly summary, prepare a claim). Off until a token is created in Settings → AI assistants or set as `SMB_MCP_TOKEN`. See [docs/ai-assistants.md](docs/ai-assistants.md).
- **Sign-in for Claude's custom connectors.** claude.ai, Claude Desktop and Claude mobile can add the toolkit as a custom connector: they sign in with OAuth 2.1 (registration, PKCE, rotating refresh tokens) on a page where you paste the token once. Settings lists signed-in assistants and can sign them all out; a new token signs everyone out.
- Caddyfile forwards `/mcp` and the two OAuth discovery paths under `/.well-known/` (an `@mcp` path matcher, request bodies capped at 1 MB). Existing installs: add the block to reach them from another machine.
- Settings counters `mcp_calls`, `mcp_unauthorized` and `mcp_signins`; the daily heartbeat reports whether MCP is on and the call count.

### Fixed
- Detection false positives on ordinary iPhone and Safari visitors:
  - **Rule 1 (hosting network):** iCloud Private Relay networks — Cloudflare (AS13335), Akamai (AS36183 and AS20940) and Fastly (AS54113) — are no longer treated as hosting. Fastly and Akamai AS20940 are removed from `data/hosting-asns.txt`, and the rule skips all four even for clicks stored before this release, so re-running an analysis corrects older windows.
  - **Rule 8 (fingerprint collision):** iPhone, iPad and Safari fingerprints are shared by everyone with the same device model, so those visitors need 50 IPs on one fingerprint (new `webkit_min_ips` default) instead of 5.
  - **Rule 13 (click ID replay):** repeated hits now need a second IP or device, or hits more than 10 minutes apart (new `min_spread_min` default). One visitor reloading the landing page is no longer flagged. A click ID seen again after 24 hours still is.
  - **Rule 14 (IP velocity):** counts distinct click IDs, so reloads, and a beacon with its matching log line, count as one paid click.
- Collector rate limit behind a proxy: with `SMB_TRUST_PROXY=1` the 120-a-minute limit is now per visitor (the hop the proxy appended; IPv6 per /64) instead of per connection. Behind Caddy every beacon arrives from Caddy's address, so the whole instance shared one 120-a-minute bucket and a busy site — or a distributed click burst — lost beacons as `collect_ratelimited`.
- `X-Forwarded-For` is believed only from a trusted proxy address: new `SMB_TRUSTED_PROXIES`, default loopback and private ranges (where Caddy sits in the Compose file). A client reaching the port directly is recorded and limited on its own address. If your proxy connects from a public address, list it there. A rightmost hop that isn't an address now falls back to the connecting address rather than an earlier, client-written hop.
- IPv6 /64 grouping (subnet clustering, top ranges) expands compressed addresses first, so `2001:db8::1` and `2001:db8:0:0::2` land in the same range.

## [1.0.0] — 2026-09-29

### Security
- Collector: with `SMB_TRUST_PROXY=1` the visitor IP is the last `X-Forwarded-For` hop (the one the proxy appended), not the first; the rate limit is keyed on the connecting address.
- Collector: beacons whose browser `Origin`/`Referer` host is not the site's host (or a subdomain) are dropped and counted as `collect_bad_origin`. Threat model written up in SECURITY.md and the FAQ.
- Setup check is `POST` with CSRF, resolves the host and refuses private, loopback, link-local, CGNAT and ULA addresses; it no longer echoes the upstream status.
- Uploads: `.gz` inflation is capped at `SMB_MAX_UPLOAD_MB`; multipart bodies are counted on the wire (chunked uploads can no longer bypass the size cap).
- `_next` redirect target restricted to a plain local path; CSRF cookie is `Secure` behind a trusted TLS-terminating proxy; hostname validation is linear-time.

### Fixed
- Every selected targeting country is stored, not only the last one.
- A CSV with unknown headers now offers the column-mapping form; the mapping is stored with the staged file and re-checking does not re-upload.
- Claim packages get one file each (named by package id); deleting one no longer removes another's file.
- Overview Flagged/Watch cards count the selected range, not the whole analysis window.
- Unicode hostnames are accepted (stored as punycode, shown as typed); zip/xlsx uploads get their own message; staged uploads are swept after an hour; `/settings?error=url` shows a message; the setup check shows the http warning; earlier runs show their run time; site names capped at 60 chars; mobile switcher, SRI line, chart labels, snippet Copy button and flagged table layout on phones.

### Added
- Self-hosted collector for the SaveMyBudget SDK, one container with SQLite.
- Web server log and click-log CSV import with validation and preview.
- Ten detection rules with documented defaults and a convergence guard.
- Claim package: `evidence.csv`, `summary.md`, `form-answers.md`, `report.json`, optional `exclusions.txt`.
- Install page with platform-specific instructions and live first-beacon check.
- Site overview with flagged-clicks table and tag-health notifications.
- Anonymous, opt-out telemetry and a separate version check.
- Docker Compose deployment with Caddy for TLS.
