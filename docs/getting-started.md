# Getting started

About ten minutes. You need a Linux host with Docker, a domain you control, and the ability to add one DNS record.

## 1. Pick a subdomain for the tag

The tag on your site posts to a URL on your own domain, for example `https://t.example.com`. Using your own domain matters: third-party hostnames lose a share of sessions to ad blockers and browser tracking protection, which skews your baseline.

Add an `A` record for that subdomain pointing at your host. If your root domain is managed by Shopify, Wix or another platform, you can still add a subdomain record in that platform's DNS settings — only the one record is needed.

## 2. Deploy

```bash
git clone https://github.com/10xlabsio/savemybudget-toolkit
cd savemybudget-toolkit
cp .env.example .env
```

Edit `.env`:

```
SMB_PUBLIC_URL=https://t.example.com
SMB_TZ=Europe/London
```

Then:

```bash
docker compose up -d
```

Compose starts two containers: the toolkit and [Caddy](https://caddyserver.com/), which obtains a TLS certificate for your subdomain automatically and proxies only the `/collect` and `/sdk` paths to the toolkit. The web UI is bound to `127.0.0.1:8080` on the host and is not reachable from the internet.

Check it's up:

```bash
curl -s https://t.example.com/collect/healthz
# {"ok":true,"version":"1.0.0"}
```

## 3. Open the UI

The UI is on the host at `http://127.0.0.1:8080`. From your laptop, tunnel to it:

```bash
ssh -L 8080:127.0.0.1:8080 user@your-host
```

then open `http://127.0.0.1:8080` in your browser. The first-run page checks your public URL, asks for your timezone, and shows the telemetry notice. If you'd rather expose the UI directly, put a password in front of it — see [Configuration → Exposing the UI](configuration.md#exposing-the-ui).

## 4. Add a site and install the tag

Add your site (name, hostname, optionally the countries your campaigns target). The install page gives you the snippet with your site's key and step-by-step instructions for Google Tag Manager, Shopify, WordPress, Webflow, Wix, Squarespace or custom code. Leave the page open: it shows a green tick the moment the first visit arrives.

Details and troubleshooting: [Install the tag](install-the-tag.md).

## 5. Wait, then analyse

Evidence can't be collected retroactively, so the useful data starts on the day the tag goes in. After a week or two, open **Analyse**, pick a window, run the rules, and build the claim package. Then read [Filing a claim](filing-a-claim.md).

If you already have web server logs from before the tag was installed, you can [import them](inputs.md) for the same window.

## Updating

```bash
docker compose pull && docker compose up -d
```

Your data is in the `smb-data` volume and survives updates. The UI shows a notice when a new version is available (switch off with `SMB_UPDATE_CHECK=off`).

## Backing up

Everything is in the volume: `docker run --rm -v smb-data:/data -v $(pwd):/backup alpine tar czf /backup/smb-data.tgz /data`. Settings → **Export all data** produces CSVs per site if you want something readable.

## Uninstalling

Remove the tag from your site first, then `docker compose down -v`. Remember the retention rule in [Privacy](privacy.md): delete what you no longer need.
