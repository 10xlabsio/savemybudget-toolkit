# Roadmap

What's planned, what's being considered, and what's out of scope. Open a discussion to argue for moving something between lists.

## Next

- **Feedback from assistants** — mark a flagged IP as your own traffic or a lead as junk; dismissed IPs drop out of the offender list and `exclusions.txt`.
- **Claim outcomes** — record when a package was filed and what Google credited, so assistants can report on it.
- **Google Ads campaign export as an input** — campaign and keyword CSV from the Ads UI for the window, so the evidence file can carry campaign names and a per-click CPC you supply. Enables two economic rules (budget-attack timing, CTR/conversion divergence).
- **Proxy / VPN / Tor lists** — as an optional, curated rule with a documented source and refresh cadence.
- **CLI mode** — `smb-toolkit analyze ./access.log` for people who don't want the UI.
- **Weekly summary in the UI** — the notification bar already carries tag health; a short weekly digest of clicks, flagged share and open windows would sit alongside it.

## Considering

- Cloudflare Worker deployment target for the collector, for people without a VPS.
- IIS and JSON log formats.
- A "was the page ever visible" refinement to the zero-dwell rule, from the SDK.
- Import of the SDK's consent signal into the evidence file.

## Out of scope

- Google Ads OAuth or API access. It requires a verified Cloud project with API access on the operator's side, which is most of the setup burden the toolkit exists to avoid.
- Filing claims automatically. The form belongs to the account owner.
- Blocking or pushing exclusions to Google Ads.
- Cross-site or cross-account signals. They only exist where many sites report to one place.
- Tuned or per-vertical thresholds.
- Email sending of any kind.
