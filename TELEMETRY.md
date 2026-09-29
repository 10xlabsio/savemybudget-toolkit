# Telemetry

The toolkit sends anonymous usage counts so we can see which parts get used and where installs stall. This page lists everything it sends, everything it never sends, and how to turn it off.

## Turning it off

Any of these:

- `SMB_TELEMETRY=off` in `.env` (the shipped `docker-compose.yml` has the line ready to uncomment)
- Settings → Telemetry → off
- Block outbound traffic to `eu.i.posthog.com` on your host

The daily version check is separate and has its own switch, `SMB_UPDATE_CHECK=off`, so you can keep update notices without telemetry.

The first time the toolkit starts it prints one line saying telemetry is on and linking here.

## Two things that always hold

1. **The tag on your website never contacts SaveMyBudget.** Telemetry goes from your server to ours; nothing runs in your visitors' browsers except the SDK talking to your own collector. Read the snippet — there is no SaveMyBudget hostname in it.
2. **Telemetry and click data never share code.** The telemetry module cannot read the events table. Its payload builder is a pure function, and a test asserts that no field it produces can hold a string longer than 64 characters, so an identifier can't slip through by accident.

## What is sent

Each instance has a random identifier written to the data volume on first run. It is not tied to an email, an account, a hostname or a machine fingerprint.

| Event | When | Fields |
|---|---|---|
| `instance_started` | on boot | toolkit version, Node version, OS and architecture, deploy method (`compose` / `docker` / `npm`), whether this is the first boot |
| `snippet_generated` | when a snippet is generated in the UI | consent mode chosen |
| `first_beacon` | once, when the first beacon ever arrives | hours since first boot |
| `heartbeat` | daily | beacons per day (bucket), distinct click IDs (bucket), number of sites, whether log/CSV import has been used, data directory size (bucket), uptime |
| `analysis_run` | when rules are run | count of clicks each rule fired on, flagged share (bucket), window length in days, which sources were present |
| `claim_package` | when a package is built | flagged rows (bucket), whether the exclusions list was included |
| `error` | on an unexpected error | which stage (`collect`, `parse`, `enrich`, `score`, `write`) and the error class name |

Buckets are ranges such as `<1k`, `1k–10k`, `10k–100k`, `>100k`. Counts are integers. Nothing else.

## What is never sent

IP addresses, click IDs, hostnames, domains, user agents, fingerprint hashes, Google Ads customer IDs, campaign or keyword names, cost figures, uploaded file names or paths, any row of any table, any error message text.

## Where it goes

A PostHog project in the EU (`eu.i.posthog.com`), separate from the one used by the managed product. Retained for 12 months.

## Why it's on by default

Self-hosted software gets almost no feedback. The one number we're after is how many installs never receive a first beacon — that's the install-friction problem, and it's the same one we work on in the managed version. If you'd rather not contribute, switch it off; nothing in the toolkit depends on it.
