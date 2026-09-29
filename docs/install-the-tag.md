# Install the tag

The tag is the open-source [SaveMyBudget SDK](https://github.com/10xlabsio/savemybudget-sdk): a tiny loader (under 1 KB) that fetches the SDK (about 2.6 KB) from **your own toolkit** and posts one beacon when a page with a Google click ID loads, and one when it unloads. It records the click ID, the network the visit came from, the browser, whether the page was ever visible, how long it stayed open and whether there was any interaction. It never reads page content or form fields, and it never contacts SaveMyBudget.

Before you start:

- **Auto-tagging must be on in Google Ads.** It's what adds the `gclid` to your landing URLs. No gclid, no evidence. (Google Ads → Settings → Account settings → Auto-tagging.)
- **The tag must be on every page an ad can land on.** A page without the tag looks exactly like a bot that never ran JavaScript.
- **Consent banners can block the tag.** Choose the consent mode that matches your privacy policy when you add the site — see [Privacy](privacy.md).

## The snippet

Copy it from the install page in the UI; it carries your site's key and your collector's URL. It looks like this:

```html
<script>
"use strict";(function(){(function(n,t){try{if(n.smb)return;var r=function(){try{r.q.push(Array.prototype.slice.call(arguments))}catch(u){}};r.q=[],n.smb=r;var e=t.createElement("script");e.async=!0,e.src=n.__smbSdkUrl,e.crossOrigin="anonymous";var s=t.head||t.documentElement;s&&s.appendChild(e)}catch(u){}})(window,document);})();
window.__smbSdkUrl='https://t.example.com/sdk/v1/smb.js';
smb('init',{c:'sk_example_1a2b3c4d',e:'https://t.example.com'});
</script>
```

It goes **inside `<head>` on every page**. It loads asynchronously and fails silently: if your toolkit is down, the page renders exactly as it would without the tag.

The key (`sk_…`) is public by design. It identifies the site; it doesn't grant access to anything.

## Google Tag Manager

1. Tags → New → **Custom HTML**.
2. Paste the snippet.
3. Trigger: **All Pages**.
4. Save, then **Publish** the container. Preview mode alone doesn't count.

The two things that fix a silent tag nine times out of ten: the trigger isn't All Pages, or the container was never published. The snippet is plain ES5 so GTM's validator accepts it.

## Directly on your site

| Platform | Where |
|---|---|
| **Shopify** | Online Store → Themes → Edit code → `theme.liquid` → paste just after the opening `<head>` tag. Applies per theme: if you publish a new theme, add it again. |
| **WordPress / WooCommerce** | A header-code plugin (WPCode, "Insert Headers and Footers") → Header section. Or `header.php` in a child theme, before `</head>`. |
| **Webflow** | Project settings → Custom code → Head code. Publish the site afterwards. |
| **Wix** | Settings → Custom code → Add code → Head, all pages. |
| **Squarespace** | Settings → Advanced → Code injection → Header. |
| **Custom code** | In your layout template, inside `<head>`, before any render-blocking scripts. |

If GTM is also on the site, that's fine — the tag guards itself, and a double install is safe.

## Verify

Leave the install page open. It polls every five seconds and shows a green tick with the time the first visit arrived.

Nothing after ten minutes? Send yourself a test visit: open your site as `https://www.example.com/?gclid=SMBTEST123` and come back to the install page. Test click IDs are recorded and excluded from analysis.

Still nothing:

- GTM: check the trigger is All Pages and the container is published (Versions tab shows a version newer than your change).
- Shopify: check you edited the *published* theme.
- Consent-gated mode: the tag waits for consent; give consent on your test visit.
- Content Security Policy: your site's CSP must allow `script-src` and `connect-src` for your collector's origin. The SDK is CSP- and Trusted-Types-compatible; it needs only those two allowances.
- Ad blocker on your own browser: disable it for the test visit.

## Handing the instructions to a developer

The install page has a **Copy instructions** button that produces a self-contained Markdown block — snippet plus the steps for the platform you chose — ready to paste into an email or ticket. It contains everything needed; no login to the toolkit is required.

## Pinning the SDK

The install page shows the SDK build and its SRI hash. For a locked install, use the versioned path `/sdk/<build>/smb.js` and add `integrity="sha384-…"` to a `<script>` tag of your own instead of the loader. The toolkit serves the exact bytes of the SDK version it was built with.

---

If you'd rather not run any of this yourself, the managed version at [savemybudget.io](https://savemybudget.io/?utm_source=toolkit) installs the tag with you on a short call, monitors it, and prepares and files claims on a no-win-no-fee basis.
