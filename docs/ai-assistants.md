# AI assistants

The toolkit has an [MCP](https://modelcontextprotocol.io) server built in, so Claude (on claude.ai, desktop or mobile), Claude Code, Cursor or any other MCP client can work with your click data in plain English: "which IPs hit us most this week?", "were last week's leads real?", "prepare the September claim".

It reads what the toolkit's own UI shows and can save an analysis or build a claim package. It does not connect to Google Ads, change anything there, or file anything: a person still downloads the package and submits Google's form.

## Turn it on

1. Open **Settings → AI assistants** and choose **Turn on and create a token**.
2. Copy the token. It's shown once; only a hash of it is stored. **New token** replaces it, **Turn off** removes it.
3. Use the server URL shown there: `https://<your tag subdomain>/mcp`. The shipped Caddyfile already forwards `/mcp`. On the toolkit's own machine `http://127.0.0.1:8080/mcp` works too.

Until a token exists, `/mcp` answers 404 as if it didn't exist.

To manage the token as configuration instead, set `SMB_MCP_TOKEN` in `.env` and restart; it takes precedence and the Settings buttons are hidden. It must be at least 24 characters (shorter values are ignored, and Settings says so) — use a long random value, for example `openssl rand -base64 32`.

## Connect

There are two ways in. Clients that can send a header use the token directly as `Authorization: Bearer <token>`. Claude's custom connectors (claude.ai, Claude Desktop, Claude mobile) sign in instead: they open a page on your toolkit, you paste the token once, and the assistant gets its own short-lived credentials.

**claude.ai, Claude Desktop and Claude mobile**

Needs the public URL set (Settings → Instance) and the Caddyfile's `@mcp` block, because Claude connects from the internet.

1. In Claude: Settings → Connectors → **Add custom connector** (where your plan offers custom connectors).
2. Give it a name and paste `https://t.example.com/mcp`. Leave the advanced OAuth fields empty.
3. Choose **Connect**. A page on your toolkit opens and names the app asking; paste the token and choose **Connect**.

The assistant stays signed in (access for an hour at a time, renewed for up to 30 days of use). Settings → AI assistants lists signed-in assistants and has **Sign out all**. A new token, or Turn off, signs every assistant out.

**Claude Code**

```bash
claude mcp add --transport http savemybudget https://t.example.com/mcp --header "Authorization: Bearer <token>"
```

**Cursor** — in `~/.cursor/mcp.json` (the global file, so the token isn't committed with a project):

```json
{
  "mcpServers": {
    "savemybudget": {
      "url": "https://t.example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

**A client that reads an `mcpServers` file but can't sign in or send headers** — through the [`mcp-remote`](https://github.com/geelen/mcp-remote) bridge (needs Node.js):

```json
{
  "mcpServers": {
    "savemybudget": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://t.example.com/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer <token>" }
    }
  }
}
```

**Anything else** — any client that speaks MCP over Streamable HTTP and can send a header: n8n, your own scripts, other assistants.

## What you can ask

- "Is the tag still firing on all my sites?"
- "How many clicks were flagged last week, and is that up or down?"
- "Which networks and countries send the flagged clicks?"
- "Give me the IPs to exclude in Google Ads."
- "Check the last 7 days of leads in HubSpot against SaveMyBudget." (with your CRM's own MCP server connected too)
- "Prepare a claim for 1–30 September."

## Tools

| Tool | What it returns |
|---|---|
| `list_sites` | Each site with tag health, last beacon, beacons in 24 h, clicks and flagged clicks over 7 days |
| `get_site_summary` | Totals, flag rate, change against the previous window, per-day counts, rules fired, top networks and /24s |
| `get_flagged_clicks` | Click rows (flag, watch or both): click id, full IP, network, country, browser family, landing path, score and every rule that fired. Up to 200 per page |
| `get_flag_breakdown` | Flagged / watch / total by country, network, subnet, browser, source, campaign, landing path, hour, weekday or rule |
| `get_top_offenders` | IPs, networks or /24s with the most flagged clicks — the IP exclusion list |
| `get_ip_profile` | One IP's last 90 days on a site |
| `match_leads` | CRM leads matched to clicks by click id, then IP within 30 minutes of the submission (clicks before it first; a matching `utm_*`, then the latest), with each lead's verdict |
| `get_analyses` | Saved analyses and their claim packages |
| `get_claim_window` | Whether a window can still be claimed (Google's ~60-day limit) |
| `get_notifications` | Open notices: silent tag, first beacon, clicks about to leave the claim window, proxy misconfigured |
| `get_rules` | The rules, weights and thresholds, and how scores become verdicts |
| `run_analysis` | Saves an analysis for a window (reuses one from the last 24 hours unless `force`) |
| `build_claim_package` | Builds the claim zip for a saved analysis and returns where to download it |

Prompts: `audit_crm_leads` (check CRM leads and tag the junk ones, with a person present or on a schedule), `weekly_summary` (a short note for the site's owner) and `prepare_claim` (window check → analysis → package, stopping before anything is filed).

Verdicts are `flag` (the rules say invalid), `watch` (suspicious, worth a look) and `allow`. Windows are whole UTC days, at most 90.

## Leads and privacy

`match_leads` needs only a lead id plus any one of: the gclid (or gbraid / wbraid), the IP and submission time, or the landing URL. It refuses any other field, so names, emails and phone numbers can't be sent by mistake. The CRM join happens in your assistant; the toolkit never connects to a CRM.

The assistant sees what the UI shows, including full visitor IPs, so treat the token like the UI itself. Assistants send tool results to their model provider: check that's covered by your privacy notice before pointing one at visitor data. Fingerprint hashes, raw user-agent strings and file paths are never returned.

## How sign-in works

Standard OAuth 2.1 with the pieces MCP clients expect: protected-resource and authorization-server metadata under `/.well-known/` on your tag subdomain (built from the public URL, never from the request), dynamic client registration, the authorization-code flow with PKCE (S256 only), single-use rotating refresh tokens (replaying an old one ends that sign-in), and revocation. Only hashes of codes, tokens and client secrets are stored. Every sign-in is tied to the current token, which is why a new token signs everyone out. Wrong tokens on the sign-in page are rate limited and counted with the others.

## Limits

120 messages a minute per client (each message in a batch counts; IPv6 clients by /64), with failed sign-ins limited separately so someone guessing can't lock you out; 1 MiB per request, 50 messages per batch, 200 leads per `match_leads` call. Analyses are computed on request and reused for up to 60 seconds; imports, deletions and site edits take effect immediately. `run_analysis` returns an analysis saved in the last 24 hours only if the data still gives the same counts.

## Troubleshooting

| You see | Meaning |
|---|---|
| `404` | Not turned on: create a token in Settings, or set `SMB_MCP_TOKEN` |
| `401` | Missing or wrong token. The Settings counter `mcp_unauthorized` counts these. A signed-in assistant gets this after a new token or Sign out all — connect it again |
| Claude says it couldn't reach the server, or sign-in never starts | Check the public URL is set and is the address you gave Claude, and that `https://<your subdomain>/.well-known/oauth-protected-resource` loads (the Caddyfile's `@mcp` block forwards it) |
| `429` | Over 120 messages a minute from one client; wait a minute |
| The client can't reach the URL | Check the Caddyfile has the `@mcp` block (added in 1.1.0) and reload Caddy |
