# Filing a claim

The toolkit builds the package. You submit it. Google reviews the request and decides what, if anything, was invalid; credits appear on your account as adjustments. Reviews usually take days.

## Before you build the package

- Google accepts requests for clicks in roughly the **last 60 days**. The analysis page refuses windows that end earlier than that and warns when a window straddles the limit.
- Google already credits invalid clicks its own systems catch. Check the **Invalid clicks** column in Google Ads for the window (add it via Columns → Performance) and don't claim what's already been credited.
- One pattern per request reads better than everything at once. If you have a clear cluster (one network, one campaign, one week), build the package for that window.

## What's in the package

`claim-<site>-<from>-<to>.zip`:

| File | Purpose |
|---|---|
| `evidence.csv` | One row per flagged click: click ID, UTC timestamp, IP, network, country, browser, campaign if known, rules triggered, score, verdict. This is what Google can match against its own records. |
| `summary.md` | A short factual description of the pattern with the numbers filled in. Edit it; it's a draft in your voice, not ours. |
| `form-answers.md` | Field by field, what to enter in Google's form and where each item is in the package. |
| `report.json` | Everything above, machine-readable. |
| `exclusions.txt` | Optional. The flagged IPs ranked, capped at 500, for pasting into campaign IP exclusions if you choose to. |

## What Google's form asks for

| Item | Where it is |
|---|---|
| Customer ID | Top of Google Ads, ten digits. Not in the package — enter it yourself. |
| Date range | `summary.md`, first line. |
| Campaigns, ad groups, keywords | Your Google Ads account. Narrow it to where the pattern showed. |
| IP addresses | `evidence.csv`; the top networks and /24 ranges are listed in `summary.md`. |
| Devices and browsers | `evidence.csv`, `user_agent` column. |
| GCLIDs | `evidence.csv`, `gclid` column. |
| Summary of the issue | `summary.md`. Keep it short; the attachment carries the detail. |
| Attachment | `evidence.csv`. |

The form also asks four yes/no questions: whether you changed targeting, had ads approved, raised budgets or bids, or already checked invalid clicks recently. They exist so Google can rule out benign causes for a spike. Answer them accurately from your own account history; the toolkit doesn't know.

Google's form: [support.google.com/google-ads/contact/click_quality](https://support.google.com/google-ads/contact/click_quality). You must be signed in with an account that has access to the Google Ads account.

## Writing the summary

Factual, short, courteous. Say what you observed, not who you think did it.

> Between 3 and 9 September, campaign "Brand – Exact" received 214 clicks from IP addresses in a single hosting provider's network (AS64500). Our records show a median visible time under one second, no page interaction, and 37 click IDs used more than once. Records with timestamps (UTC), IP addresses, user agents and click IDs are attached. Other campaigns in the same period show no similar pattern.

## What weakens a request

- A feeling that traffic is off, with no records behind it.
- Low conversions or poor return on their own — those aren't invalid activity.
- Clicks outside the 60-day window.
- Clicks Google has already credited.
- Many unrelated patterns mixed into one request.
- Accusatory wording. It doesn't add evidence.

## After you submit

Google replies by email. Keep the package with the reply so you can compare Google's answer against what you sent; the Invalid clicks column for the window is where an adjustment shows up. The toolkit doesn't track outcomes — note them yourself.

---

Want this reviewed and filed for you? The managed version at [savemybudget.io](https://savemybudget.io/?utm_source=toolkit) prepares and files claims on a no-win-no-fee basis. When Google confirms a credit, they keep 25 %. If Google confirms nothing, there is no charge.
