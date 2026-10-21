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
2. **Telemetry and click data never share code.** The telemetry module cannot read the events table. Its payload builder is a pure function with a fixed list of fields per event, and each field accepts only a set value, a bucket, a yes/no flag or a small count in a fixed range. Anything else is refused, not trimmed, so an identifier can't slip through by accident. Tests feed it customer IDs, IP addresses, click IDs, email addresses, domains and URLs and check that every one is rejected.

## What is sent

Each instance has a random identifier written to the data volume on first run. It is not tied to an email, an account, a hostname or a machine fingerprint.

| Event | When | Fields |
|---|---|---|
| `instance_started` | on boot | toolkit version, Node major version (a single number such as `22`), OS and architecture, deploy method (`compose` / `docker` / `npm`), whether this is the first boot |
| `snippet_generated` | when a snippet is generated in the UI | consent mode chosen |
| `first_beacon` | once, when the first beacon ever arrives | hours since first boot (bucket) |
| `heartbeat` | daily | beacons per day (bucket), distinct click IDs (bucket), number of sites, whether log/CSV import has been used, data directory size (bucket), uptime (bucket), the running count of tracking-tag errors (bucket), whether AI assistant access is on, and the running count of AI assistant tool calls (bucket) |
| `analysis_run` | when rules are run | for each of the ten built-in rules, a bucket for how many clicks it fired on, flagged share (bucket), window length in days (at most 366), which sources were present, and `via: mcp` when an AI assistant ran it |
| `claim_package` | when a package is built | flagged rows (bucket), whether the exclusions list was included, and `via: mcp` when an AI assistant built it |
| `error` | on an unexpected error | which stage (`collect`, `parse`, `enrich`, `score`, `write`) and the error class name |

Fields are fixed per event; a field not listed above is never sent. Every value is a set choice (for example `os`, `deploy_method`, `stage`), a bucket, a flag, or a whole number in a small fixed range (for example at most 1,000 sites). Version fields hold only a plain version number such as `1.1.0`, the instance identifier must be a UUID, rule counts are accepted only for the ten built-in rule names, and `error_class` only a class name ending in `Error`. If the toolkit ever built a payload with anything else, it would drop the event rather than send it.

Buckets are ranges such as `<1k`, `1k–10k`, `10k–100k`, `>100k`, or for durations `<1h`, `1–24h`, `1–7d`, `7–30d`, `>30d`. Counts are whole numbers in a small fixed range. Nothing else.

## What is never sent

IP addresses, click IDs, hostnames, domains, user agents, fingerprint hashes, Google Ads customer IDs, campaign or keyword names, cost figures, uploaded file names or paths, any row of any table, any error message text.

## Where it goes

A PostHog project in the EU (`eu.i.posthog.com`), separate from the one used by the managed product. Retained for 12 months.

Like any web request, the receiving service sees the IP address the request comes from. Each event asks it not to look up a location (`$geoip_disable`), and the project is configured to discard the connecting IP address rather than store it.

## Why it's on by default

Self-hosted software gets almost no feedback. The one number we're after is how many installs never receive a first beacon — that's the install-friction problem, and it's the same one we work on in the managed version. If you'd rather not contribute, switch it off; nothing in the toolkit depends on it.
