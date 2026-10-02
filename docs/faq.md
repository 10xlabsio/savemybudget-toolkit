# FAQ

**Does this connect to my Google Ads account?**
No. There is no OAuth and no Google Ads API in the toolkit. It works entirely from what lands on your site: the click ID in the URL (which auto-tagging adds) and your own records.

**Can I use it without installing the tag?**
Yes, with your web server logs or a CSV — see [Inputs](inputs.md). You lose the behaviour rules (visible time, interaction, fingerprint) and the strongest bot signal (request seen, no beacon), which needs both logs and the tag.

**Will it tell me how much money I've lost?**
No. It counts flagged clicks. If you want an estimate, multiply by your own CPC from Google Ads and call it an estimate. Flagged is not the same as invalid, and invalid is not the same as credited — only Google decides the last two.

**Does it block bad clicks?**
No. It can export a ranked list of flagged IPs you may choose to add to your campaign's IP exclusions (Google caps those at 500 per campaign). Whether to exclude is your call.

**How far back can I claim?**
Google accepts requests for roughly the last 60 days. Evidence can't be collected after the fact, so the tag has to be in place first.

**Will Google accept my request?**
Sometimes. Google reviews every request and decides. Well-scoped, factual requests with click IDs, timestamps and IP addresses do better than a general complaint — see [Filing a claim](filing-a-claim.md). Nothing here guarantees an outcome.

**Does the tag slow my site down?**
The loader is under 1 KB and loads the SDK (about 2.6 KB) asynchronously. It never blocks rendering, never reads page content, and if your toolkit is unreachable it silently does nothing.

**What does it send to SaveMyBudget?**
From your server: anonymous usage counts, unless you switch them off — every field is listed in [TELEMETRY.md](../TELEMETRY.md). From your visitors' browsers: nothing. The tag only talks to your own collector.

**Can someone fake clicks into my toolkit?**
Partly. The site key in the snippet is public, so anyone can post beacons that name your site. Two things limit what that achieves: the collector records the IP address of whoever connected (that field can't be chosen by the sender), and it drops beacons whose browser `Origin` isn't your site's host, so a page on another site can't inject them. A script that sets its own headers still can, up to the rate limit. So treat the beacon fields (click ID, dwell time, interactions) as what the sender reported and the IP, timestamp and the fact a request arrived as what your server saw. Cross-checking with your web server log closes most of the gap — see [SECURITY.md](../SECURITY.md).

**Can I run it for several sites?**
Yes. One container, any number of sites, each with its own key and its own analysis.

**Is it GDPR-compliant?**
It's built to be run compliantly: server-side IP collection under legitimate interests or consent-gated, hash-only fingerprints, configurable retention, no cookies. Compliance is yours to establish — [Privacy](privacy.md) explains what to put in your policy.

**Why are the rule thresholds what they are?**
They're conservative defaults documented in [Rules](rules.md). The managed version calibrates thresholds per account and runs additional rules; that tuning is not in the repository and won't be.

**What's the difference from the managed version?**
The managed version at [savemybudget.io](https://savemybudget.io/?utm_source=toolkit) installs and monitors the tag for you, connects to Google Ads for cost data and campaign attribution, runs more rules including cross-account signals, and prepares and files the claims. It's no-win-no-fee: when Google confirms a credit, they keep 25 %; if Google confirms nothing, there is no charge. The toolkit is for people who'd rather run the collection themselves and file their own claims.

**Can I use it from Claude, Cursor or another AI assistant?**
Yes. Turn on Settings → AI assistants, copy the token, and connect the assistant to `https://<your tag subdomain>/mcp`. It can answer questions about your sites and flagged clicks, match CRM leads against clicks, and prepare a claim package — it never files anything or touches Google Ads. Steps for Claude Code, Cursor and Claude Desktop: [AI assistants](ai-assistants.md).
