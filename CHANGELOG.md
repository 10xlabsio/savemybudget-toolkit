# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

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
