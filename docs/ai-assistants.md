# AI assistants

The toolkit has an [MCP](https://modelcontextprotocol.io) server built in, so Claude Code, Claude Desktop, Cursor or any other MCP client can work with your click data in plain English: "which IPs hit us most this week?", "were last week's leads real?", "prepare the September claim".

It reads what the toolkit's own UI shows and can save an analysis or build a claim package. It does not connect to Google Ads, change anything there, or file anything: a person still downloads the package and submits Google's form.

## Turn it on

1. Open **Settings → AI assistants** and choose **Turn on and create a token**.
2. Copy the token. It's shown once; only a hash of it is stored. **New token** replaces it, **Turn off** removes it.
3. Use the server URL shown there: `https://<your tag subdomain>/mcp`. The shipped Caddyfile already forwards `/mcp`. On the toolkit's own machine `http://127.0.0.1:8080/mcp` works too.

Until a token exists, `/mcp` answers 404 as if it didn't exist.

To manage the token as configuration instead, set `SMB_MCP_TOKEN` in `.env` and restart; it takes precedence and the Settings buttons are hidden. Use a long random value, for example `openssl rand -base64 32`.

## Connect

Every request carries the token as `Authorization: Bearer <token>`.

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

**Claude Desktop** — through the [`mcp-remote`](https://github.com/geelen/mcp-remote) bridge (needs Node.js), in `claude_desktop_config.json`:

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

Custom connectors added on claude.ai sign in with OAuth, which the toolkit doesn't offer; a fixed token there is limited to some organisations. That's why Claude Desktop goes through the local bridge.

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
| `match_leads` | CRM leads matched to clicks by click id, then IP within 30 minutes, with each lead's verdict |
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

## Limits

120 requests a minute per client address (failed sign-ins count), 1 MiB per request, 50 messages per batch, 200 leads per `match_leads` call. Analyses are computed on request and reused for up to 60 seconds; imports, deletions and site edits take effect immediately.

## Troubleshooting

| You see | Meaning |
|---|---|
| `404` | Not turned on: create a token in Settings, or set `SMB_MCP_TOKEN` |
| `401` | Missing or wrong token. The Settings counter `mcp_unauthorized` counts these |
| `429` | Over 120 requests a minute from one address; wait a minute |
| The client can't reach the URL | Check the Caddyfile has the `/mcp*` block (added in 1.1.0) and reload Caddy |
