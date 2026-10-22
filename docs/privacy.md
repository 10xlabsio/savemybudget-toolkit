# Privacy

You run this toolkit, so you are the data controller for what it collects. This page is what you need to know to do that properly. It is not legal advice.

## What the tag collects

For each page load that carries a Google click ID: the click ID, the visitor's IP address (recorded server-side by your collector), user agent, a hash of browser characteristics, whether the page became visible, how long it was open, and counts of mouse, scroll and touch events. On unload: the same session identifier and the final dwell and interaction counts.

It does **not** collect page content, form field values, keystrokes, or anything typed. It sets no cookies and stores nothing on the visitor's device. Pages without a click ID are ignored.

## What is personal data

IP addresses are personal data under UK and EU GDPR, and browser fingerprints can be. Treat the toolkit's store accordingly: restrict who can reach the UI, keep records only as long as needed, and share them only through Google's official form.

The toolkit stores the fingerprint as a hash only, never the components.

## Lawful basis

Most advertisers process this data under **legitimate interests** (fraud prevention is a recognised one), which is how the toolkit's default consent mode works: it collects on every page load without a consent gate. Your privacy policy should say that you record ad-click data for the purpose of detecting invalid clicks and preparing claims to Google, and for how long.

If your policy or your jurisdiction requires consent for this kind of collection, set the site to **consent-gated** mode. The SDK then waits for a consent signal (it understands Shopify's customer-privacy API and Google Consent Mode's `analytics_storage`; a custom CMP can call `smb('consent', true)`). Until consent, nothing is sent.

## Retention

Default 90 days, purged nightly, configurable down to 60 (Google's claim window). Set it to the shortest period that still lets you file. Analyses and claim packages you build are kept until you delete them — they contain IP addresses too.

Upgrading from 1.x leaves a full copy of the database, `backup-v1-<timestamp>.sqlite`, in the data directory. It holds the same visitor data as the database, including the events the retention purge removes from the live one. The toolkit deletes it automatically once the retention period has passed since the upgrade, and Settings shows a notice while it exists. To delete it earlier, remove the file. A request from a visitor to erase their data must cover this copy as well: delete it, or wait for it to be removed, before you tell the visitor the data is gone.

## Access

The UI is bound to the host's loopback interface by default and is not reachable from the internet. If you expose it, put authentication in front of it (see [Configuration](configuration.md#exposing-the-ui)). Server logs at the default level don't include visitor IPs.

AI assistants (Settings → AI assistants, off by default) can read what the UI shows, including full visitor IPs, through `/mcp` with the token or after signing in with it. An assistant sends tool results to its model provider, so if you turn it on, make sure your privacy notice covers that processor. Fingerprint hashes and raw user-agent strings are never returned. See [AI assistants](ai-assistants.md).

## Deleting

Settings → per site → **Delete site data** removes every record for that site. `docker compose down -v` removes everything. If a visitor asks you to erase their data, delete the rows for their IP with the export/delete tools or directly in the SQLite file at `/data/toolkit.db`. Remember the upgrade copy described under Retention.

## What leaves your server

Only anonymous, bucketed usage counts — never visitor data — and only if telemetry is on. Full list in [TELEMETRY.md](../TELEMETRY.md). The tag on your site never contacts SaveMyBudget.
