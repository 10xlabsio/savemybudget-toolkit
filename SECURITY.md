# Security

## Reporting a vulnerability

Email **security@savemybudget.io**. Don't open a public issue. Include the toolkit version, steps to reproduce, and what you believe the impact is. You'll get an acknowledgement within three working days and updates as we work on a fix. We'll credit you in the release notes unless you'd rather we didn't.

## Supported versions

The latest minor release. Security fixes are released as patch versions and announced in the changelog and the in-app update notice.

## What the toolkit exposes

The only routes meant to be public are `POST /collect`, `GET /collect/healthz`, `GET /sdk/*` and `POST /mcp`. The shipped Compose file and Caddyfile expose nothing else. Findings about the UI being reachable are still welcome — someone will expose it — but the intended threat model is: an attacker on the internet can send beacons and fetch the SDK, and without the MCP token gets nothing else.

## The MCP endpoint

`/mcp` serves AI assistants (see [docs/ai-assistants.md](docs/ai-assistants.md)). It answers 404 until a token exists. The token is created in Settings (only its SHA-256 is stored; the plain value is shown once) or set as `SMB_MCP_TOKEN`, compared in constant time, accepted only in the `Authorization` header, and never logged. Requests are limited to 120 a minute per client address, failed sign-ins included, and counted under `mcp_unauthorized`. The token grants read access to everything the UI shows, including visitor IPs, plus saving an analysis and building a claim package; it can't change sites, settings, uploads or anything in Google Ads. The endpoint sits outside the UI's cookie and CSRF layer, so a browser session can't be used against it.

## Threat model for beacons

**The site key is a public identifier, not a secret.** It sits in the page source of every page the tag is on. Anyone who has it can post beacons to the collector that name your site. Beacons are client telemetry: the click ID, dwell time, interaction counts, automation markers and the like are whatever the sending browser (or script) says they are.

What the collector does about it:

- **It records the connecting IP itself.** The address on every event row is taken from the TCP connection (or, with `SMB_TRUST_PROXY=1`, from the hop your own proxy appended to `X-Forwarded-For` — the rightmost one; the parts a client could have written are ignored). It is the one field a sender cannot choose, and the rate limit is keyed on it.
- **Browser-side forgery is refused.** Browsers always send an `Origin` header on a cross-origin `POST`, including `sendBeacon`, so a page on another site cannot post beacons that claim to be yours: the collector drops any beacon whose `Origin` (or, failing that, `Referer`) host is not the site's host, its www/apex twin or a subdomain of it, and counts it under `collect_bad_origin` on the Settings page. A beacon with no `Origin` at all is accepted — same-origin `sendBeacon`, some older browsers and non-browser clients send none.
- **Scripted forgery is not prevented.** A script can set any header, so a determined party can still inject events with a fabricated click ID and behaviour, at up to the rate limit per address. The evidence file should be read with that in mind: the server-recorded IP, timestamp and the fact that a request arrived are the collector's own observations; everything the beacon carries is the sender's claim. `summary.md` is written as observations for that reason, and Google's own click records are the reference the request is judged against.

If you need stronger guarantees, cross-check beacons against your web server log (the "request seen, no beacon" and "beacon, no request" rules exist for exactly this) and keep the collector on its own subdomain so the `Origin` check has a clean host to compare against.

## What we consider in scope

- Anything that lets a beacon or an upload execute code, read files, or reach other routes
- Anything that lets a public request read or alter stored data, including through `/mcp` without the token
- Denial of service through the public routes beyond what rate limiting covers
- The SDK sending anything to a host other than the configured collector
- The telemetry module including data it shouldn't

## Out of scope

- Issues that require the UI to be exposed without authentication, contrary to the documentation
- Vulnerabilities in Docker, Caddy, Node or the host OS themselves
- Missing security headers on the loopback-only UI
