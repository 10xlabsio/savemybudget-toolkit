# Inputs

The toolkit works from three kinds of click records. Use one or combine them; the rules that can run depend on what you have.

| Source | How it gets in | What it adds |
|---|---|---|
| **Beacons** (the tag) | Automatically, once the tag is installed | Everything: click ID, network, browser, visibility, dwell, interaction, automation markers |
| **Web server access log** | Upload in the UI | Every request that carried a click ID, including visitors whose browser never ran JavaScript |
| **Click log CSV** | Upload in the UI | Whatever your export has — at minimum timestamp, IP and click ID |

With beacons **and** a server log for the same window, the toolkit can positively identify visits where the request arrived but the tag never ran — the strongest single signal that a click came from a bot.

## Click log CSV

Download the template from the upload page or from [`templates/click-log-template.csv`](../templates/click-log-template.csv). Header row required, column order free, UTF-8, comma-separated. Semicolon-separated files from Excel are accepted with a warning.

| Column | Required | Format |
|---|---|---|
| `timestamp` | yes | ISO 8601 with offset or `Z` — `2026-09-21T09:14:07Z`, `2026-09-21T11:02:51+01:00`. `YYYY-MM-DD HH:MM:SS` and Unix seconds are accepted and treated as UTC, with a warning. |
| `ip` | yes | IPv4 or IPv6. The **visitor's** address — if your site sits behind a CDN or proxy, this must be the forwarded client IP, not the proxy's (see below). |
| `gclid` | yes | The Google click ID as it appeared in the landing URL. Letters, digits, `_`, `-`; 20–120 characters. |
| `user_agent` | no | Free text. Needed for the browser rules and included in the evidence file. |
| `url` | no | Full landing URL. If `gclid` is empty but `url` contains one, it's extracted. |
| `referer` | no | URL or empty. |
| `campaign` | no | Free text, passed through to the evidence file. |

Common header names are mapped automatically (`time`, `datetime`, `ts` → `timestamp`; `client_ip`, `remote_addr` → `ip`; `ua` → `user_agent`; `page`, `landing_page` → `url`; `referrer` → `referer`). Anything else can be mapped by hand on the upload page.

## Web server access log

Apache or Nginx **combined** or **common** log format, as written by the server. `.gz` files are accepted. Only lines whose request path contains `gclid=` are kept; the rest are discarded and counted. A sample is in [`templates/access-log-sample.log`](../templates/access-log-sample.log).

Getting the visitor's IP right:

- Behind **Cloudflare**: log `$http_cf_connecting_ip` (Nginx) or use `mod_remoteip` (Apache) so the log carries the visitor, not Cloudflare.
- Behind any other **proxy or load balancer**: log the first address in `X-Forwarded-For`.
- The upload preview shows the share of private addresses (`10.x`, `172.16–31.x`, `192.168.x`). If it's most of the file, your log is recording the proxy.

## What is not accepted

Google Ads exports, Google Analytics exports, Search Console exports, IIS logs, JSON logs, CDN log exports and Excel workbooks. Google Ads and Analytics exports carry no IP addresses or click IDs, so they can't serve as evidence; each rejected type gets a message saying why.

## Validation

Every upload is checked before anything is written, and you see a preview first.

**Rejected outright:** wrong file type; over 100 MB (`SMB_MAX_UPLOAD_MB`); binaries, HTML, zips, JSON; not valid UTF-8 (Latin-1 is transcoded with a warning); the unedited template; a CSV missing the three required columns after mapping; a log where fewer than 80 % of the first 200 lines parse; fewer than 20 usable rows; more than 20 % of rows failing row checks.

**Dropped and counted, not rejected:** rows older than the retention window; private, loopback or link-local IPs; rows with an empty click ID; exact duplicates (same timestamp, IP and click ID).

**Warned:** every timestamp identical; one IP on more than 90 % of rows; every click ID identical; click IDs that look truncated by a spreadsheet.

The preview shows rows parsed, rows dropped by reason, the date range found, distinct IPs and click IDs, and the first ten parsed rows. Nothing is imported until you confirm.

## After import

Imported rows are stored with their source (`log` or `csv`) and take part in analysis alongside beacons. Each upload appears in the site's upload history and can be deleted, which removes its rows.
