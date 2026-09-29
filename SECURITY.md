# Security

## Reporting a vulnerability

Email **security@savemybudget.io**. Don't open a public issue. Include the toolkit version, steps to reproduce, and what you believe the impact is. You'll get an acknowledgement within three working days and updates as we work on a fix. We'll credit you in the release notes unless you'd rather we didn't.

## Supported versions

The latest minor release. Security fixes are released as patch versions and announced in the changelog and the in-app update notice.

## What the toolkit exposes

The only routes meant to be public are `POST /collect`, `GET /collect/healthz` and `GET /sdk/*`. The shipped Compose file and Caddyfile expose nothing else. Findings about the UI being reachable are still welcome — someone will expose it — but the intended threat model is: an attacker on the internet can send beacons and fetch the SDK, nothing more.

## What we consider in scope

- Anything that lets a beacon or an upload execute code, read files, or reach other routes
- Anything that lets a public request read or alter stored data
- Denial of service through the public routes beyond what rate limiting covers
- The SDK sending anything to a host other than the configured collector
- The telemetry module including data it shouldn't

## Out of scope

- Issues that require the UI to be exposed without authentication, contrary to the documentation
- Vulnerabilities in Docker, Caddy, Node or the host OS themselves
- Missing security headers on the loopback-only UI
