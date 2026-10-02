# Security

## Reporting a vulnerability

Email **security@savemybudget.io**. Don't open a public issue. Include the toolkit version, steps to reproduce, and what you believe the impact is. You'll get an acknowledgement within three working days and updates as we work on a fix. We'll credit you in the release notes unless you'd rather we didn't.

## Supported versions

The latest minor release. Security fixes are released as patch versions and announced in the changelog and the in-app update notice.

## What the toolkit exposes

The only routes meant to be public are `POST /collect`, `GET /collect/healthz`, `GET /sdk/*`, `/mcp` (including its sign-in pages under `/mcp/oauth/`) and the OAuth discovery documents under `/.well-known/`. The shipped Compose file and Caddyfile expose nothing else. Findings about the UI being reachable are still welcome — someone will expose it — but the intended threat model is: an attacker on the internet can send beacons and fetch the SDK, and without the MCP token gets nothing else.

## The MCP endpoint

`/mcp` serves AI assistants (see [docs/ai-assistants.md](docs/ai-assistants.md)). It answers 404 until a token exists. The token is created in Settings (only its SHA-256 is written to the database; the plain value is held in process memory for at most 10 minutes so the next Settings view can show it once) or set as `SMB_MCP_TOKEN` (at least 24 characters, or it is ignored), compared in constant time, accepted only in the `Authorization` header, and never logged. Messages are limited to 120 a minute per client (IPv6 by /64); failed sign-ins have their own limit of the same size, so guessing is capped without locking out the token holder, and are counted under `mcp_unauthorized`. A tool call sent as a JSON-RPC notification is not run.

Assistants that can't send a fixed header (Claude's custom connectors) sign in with OAuth 2.1: dynamic client registration, the authorization-code flow with PKCE S256, and a consent page on `/mcp/oauth/authorize` where the operator pastes the instance token. That page names the requesting app and the host it returns to, refuses redirect URIs the app didn't register (loopback http matches on any port), is served with a strict CSP and `frame-ancestors 'none'`, and limits wrong tokens per client. Issuer and resource come from the configured public URL, never from request headers. Access tokens last an hour; refresh tokens 30 days, single use, and replaying a used one revokes the whole sign-in. Codes, tokens and client secrets are stored only as SHA-256. Every sign-in carries a fingerprint of the instance token, so a new token, Turn off or a changed `SMB_MCP_TOKEN` invalidates all of them; Settings also has Sign out all. The token grants read access to everything the UI shows, including visitor IPs, plus saving an analysis and building a claim package; it can't change sites, settings, uploads or anything in Google Ads. The endpoint sits outside the UI's cookie and CSRF layer, so a browser session can't be used against it.

## Threat model for beacons

**The site key is a public identifier, not a secret.** It sits in the page source of every page the tag is on. Anyone who has it can post beacons to the collector that name your site. Beacons are client telemetry: the click ID, dwell time, interaction counts, automation markers and the like are whatever the sending browser (or script) says they are.

What the collector does about it:

- **It records the connecting IP itself.** The address on every event row is taken from the TCP connection (or, with `SMB_TRUST_PROXY=1`, from the hop your own proxy appended to `X-Forwarded-For` — the rightmost one; the parts a client could have written are ignored). It is the one field a sender cannot choose, and the rate limit (120 a minute per address, IPv6 per /64) is keyed on it. With `SMB_TRUST_PROXY=1` a second, larger cap applies per connecting address, so a client that reaches the port directly and invents `X-Forwarded-For` hops is still bounded.
- **Browser-side forgery is refused.** Browsers always send an `Origin` header on a cross-origin `POST`, including `sendBeacon`, so a page on another site cannot post beacons that claim to be yours: the collector drops any beacon whose `Origin` (or, failing that, `Referer`) host is not the site's host, its www/apex twin or a subdomain of it, and counts it under `collect_bad_origin` on the Settings page. A beacon with no `Origin` at all is accepted — same-origin `sendBeacon`, some older browsers and non-browser clients send none.
- **Scripted forgery is not prevented.** A script can set any header, so a determined party can still inject events with a fabricated click ID and behaviour, at up to the rate limit per address. The evidence file should be read with that in mind: the server-recorded IP, timestamp and the fact that a request arrived are the collector's own observations; everything the beacon carries is the sender's claim. `summary.md` is written as observations for that reason, and Google's own click records are the reference the request is judged against.

If you need stronger guarantees, cross-check beacons against your web server log (the "request seen, no beacon" and "beacon, no request" rules exist for exactly this) and keep the collector on its own subdomain so the `Origin` check has a clean host to compare against.

## What we consider in scope

- Anything that lets a beacon or an upload execute code, read files, or reach other routes
- Anything that lets a public request read or alter stored data, including through `/mcp` or its sign-in flow without the token
- Denial of service through the public routes beyond what rate limiting covers
- The SDK sending anything to a host other than the configured collector
- The telemetry module including data it shouldn't

## Out of scope

- Issues that require the UI to be exposed without authentication, contrary to the documentation
- Vulnerabilities in Docker, Caddy, Node or the host OS themselves
- Missing security headers on the loopback-only UI
