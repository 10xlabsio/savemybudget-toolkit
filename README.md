# SaveMyBudget Toolkit

Self-hosted evidence collection for Google Ads invalid-click claims.

The toolkit records every ad click that lands on your site, checks it against ten published detection rules, and builds the evidence package Google's invalid-clicks form asks for. It runs as one Docker container on your own server. Nothing leaves your infrastructure except anonymous usage counts, which you can switch off.

SaveMyBudget extends Google's own invalid-traffic protection; it does not replace it. Google filters and credits what its systems catch. This toolkit gives you the one thing Google can't see from its side: what happened on your site *after* the click.

> **Looking for the managed version?** [savemybudget.io](https://savemybudget.io/?utm_source=toolkit) installs and monitors the tag for you, adds the behavioural rules and cross-account signals that don't ship here, and prepares and files claims on a no-win-no-fee basis. When Google confirms a credit, they keep 25%. If Google confirms nothing, there is no charge.

## What you get

- **The tag** — the open-source [SaveMyBudget SDK](https://github.com/10xlabsio/savemybudget-sdk) (MIT, under 3 KB, no dependencies), pointed at your own collector. It never contacts SaveMyBudget.
- **The collector** — receives beacons, enriches them offline (network type, country, browser), stores them in SQLite for the claim window.
- **Log and CSV import** — bring your own web server logs or a click export instead of, or as well as, the tag. [Template included](templates/click-log-template.csv).
- **Ten detection rules** with documented defaults. [Read them](docs/rules.md).
- **The claim package** — `evidence.csv`, a plain-language summary, and a field-by-field guide to Google's form.
- **A small web UI** — add sites, install the tag with a live "first data arrived" check, upload logs, run an analysis, download the package.
- **An MCP server for AI assistants** — ask Claude (claude.ai, desktop or mobile, as a custom connector), Claude Code or Cursor about your flagged clicks, check CRM leads against them, and prepare a claim package. Off until you create a token. [How to connect](docs/ai-assistants.md).

## Quick start

```bash
git clone https://github.com/10xlabsio/savemybudget-toolkit
cd savemybudget-toolkit
cp .env.example .env        # set SMB_PUBLIC_URL to the subdomain the tag will use, e.g. https://t.example.com
docker compose up -d
```

Open `http://127.0.0.1:8080`, add your site, and follow the install page. Full walkthrough: [Getting started](docs/getting-started.md).

Requirements: a Linux host with Docker, a subdomain you control (one DNS record), ports 80/443 reachable for TLS.

## How it fits together

```
visitor clicks ad → lands on your site → tag posts a beacon → https://t.example.com/collect
                                                                     │
                                          server logs / CSV ─────────┤
                                                                     ▼
                                                    SQLite (90 days) → rules → claim package → you file with Google
```

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | Deploy with Docker Compose and Caddy in about ten minutes |
| [Install the tag](docs/install-the-tag.md) | GTM, Shopify, WordPress, Webflow, Wix, Squarespace, custom code |
| [Inputs](docs/inputs.md) | Beacons, server logs, CSV — formats and validation |
| [Rules](docs/rules.md) | The ten rules, their defaults, and known false positives |
| [Filing a claim](docs/filing-a-claim.md) | What Google asks for, where it is in the package, what weakens a request |
| [AI assistants](docs/ai-assistants.md) | Connect Claude, Cursor or another MCP client; the tools and what they return |
| [Privacy](docs/privacy.md) | IP addresses are personal data; retention; consent modes |
| [Configuration](docs/configuration.md) | Environment variables and settings |
| [Telemetry](TELEMETRY.md) | What is sent, what never is, how to turn it off |
| [FAQ](docs/faq.md) | |
| [Roadmap](docs/roadmap.md) | |

## What this toolkit is not

- It does not connect to your Google Ads account. There is no OAuth and no Ads API in the toolkit.
- It does not file claims. You do, with the package it builds. Google reviews and decides what is invalid.
- It does not put a price on flagged clicks. Multiply by your own CPC if you want an estimate, and call it an estimate.
- It does not block anything. It can export an IP list you may choose to add to your campaign exclusions.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first — in particular, changes to rule defaults are product decisions and go through a discussion before a PR. Security reports go to the address in [SECURITY.md](SECURITY.md), not to the issue tracker.

## Licence

Apache-2.0. See [LICENSE](LICENSE). The SaveMyBudget name and logo are trademarks and are not covered by the licence — see [TRADEMARK.md](TRADEMARK.md).

---

Built by Ivo Kostadinov, founder of [SaveMyBudget.io](https://savemybudget.io/?utm_source=toolkit), part of [10xlabs](https://10xlabs.io).
