# Owner sign-in

The toolkit has one user: you. It can run in two ways.

| | Without sign-in (loopback mode) | With Google sign-in |
|---|---|---|
| Turned on by | Nothing set (the default) | `SMB_GOOGLE_CLIENT_ID`, `SMB_GOOGLE_CLIENT_SECRET` and `SMB_OWNER_EMAIL` |
| Who can open the UI | Anyone who can reach the port. The UI answers only on `127.0.0.1`, `localhost` and `[::1]` (plus `SMB_UI_URL`), so in practice: you, over an SSH tunnel | Only the Google account in `SMB_OWNER_EMAIL`, on every request, loopback included |
| Banner in the UI | "Anyone who can reach this port can use the toolkit." | "Signed in as …" with **Sign out** and **Sign out everywhere** |

The tag, the collector, the SDK, health checks and AI assistants (`/mcp`) are not affected: they work the same in both, with their own keys and tokens.

Sign-in is what lets you open the UI from somewhere other than an SSH tunnel, and later versions need it before they connect Google Ads.

## Turn it on

You need a Google account (any Gmail or Google Workspace address) and about ten minutes. You create your own OAuth client in your own Google Cloud project; nothing goes through SaveMyBudget.

1. **Pick the address you'll open the UI at.**
   - Over an SSH tunnel: `http://localhost:8080` (or the local port you tunnel to). Use `localhost`, not `127.0.0.1`.
   - Behind your own HTTPS proxy: for example `https://ui.example.com`. Set `SMB_UI_URL` to it (see [Exposing the UI](configuration.md#exposing-the-ui)).

   The redirect URI is that address plus `/auth/google/callback`, for example `http://localhost:8080/auth/google/callback` or `https://ui.example.com/auth/google/callback`. The toolkit builds it from `SMB_UI_URL` (or `http://localhost:<port>`), never from the request, and prints it at start-up.
2. **Create or pick a Google Cloud project** in the [Google Cloud console](https://console.cloud.google.com/projectcreate). If you'll connect Google Ads later, use the same project for both.
3. **Set up the OAuth consent screen** ([Google Auth Platform](https://console.cloud.google.com/auth/overview)): an app name, your email as the support address, and the audience.
   - A Google Workspace account can choose **Internal**. Otherwise choose **External**.
   - Sign-in only asks for `openid` and `email`, which need no verification by Google. While the app is in **Testing**, add your own address under test users; or publish it to **Production**.
4. **Create the OAuth client** ([Clients](https://console.cloud.google.com/auth/clients) → Create client):
   - Application type: **Web application**.
   - Authorized redirect URIs: the redirect URI from step 1, exactly. The toolkit uses that one address for every sign-in: open from another address, it sends you to this one first.
   - Google's guide: [Using OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server).
5. **Add the settings** to `.env` and restart (`docker compose up -d`):

   ```bash
   SMB_GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
   SMB_GOOGLE_CLIENT_SECRET=<the client secret>
   SMB_OWNER_EMAIL=you@example.com
   # optional now, needed later for Google Ads; generate it once and keep it out of backups of /data
   SMB_SECRET_KEY=<output of: openssl rand -base64 32>
   ```

6. **Open the UI.** You land on the sign-in page. Choose **Sign in with Google** and pick the account in `SMB_OWNER_EMAIL`.

If the client ID is set but `SMB_OWNER_EMAIL` or the client secret is missing, the UI shows only a page that says which one to set. It never falls back to loopback mode. The tag, collection and scheduled jobs keep running meanwhile.

The session cookie is `Secure`, so the browser only keeps it over HTTPS or on `localhost`. Chrome, Edge and Firefox treat `http://localhost` as secure. If your browser doesn't, open the UI over HTTPS.

## How it works

- **Who may sign in.** Google must confirm the address (`email_verified`), and it must equal `SMB_OWNER_EMAIL` (case doesn't matter). The first successful sign-in pins that Google account (its permanent account ID). After that, a different Google account with the same address is refused, so a Workspace admin re-pointing the address can't get in. The toolkit is never "owned" by whoever signs in first.
- **What Google is asked for.** `openid email`, with the account chooser every time. No offline access and no other scopes, so the toolkit holds no Google token for you after sign-in.
- **How the answer is checked.** The sign-in carries PKCE (S256), a `state` signed by the toolkit that can be used once within 10 minutes and is tied to a short-lived cookie in your browser, and a nonce. The ID token from Google's token endpoint is verified on your server: its RS256 signature against Google's published keys (fetched from Google and cached as long as Google allows), the issuer, the audience (your client ID), the expiry, the nonce and `email_verified`. A Google error is shown on the page, never followed as a redirect.
- **Sessions.** The cookie is `__Host-smb_session` (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`), holding 32 random bytes. The database stores only its SHA-256, never your email address. A session ends after 7 days without use or 30 days in all, whichever comes first. Every sign-in gets a new session.
- **Forms.** Every change (a POST) needs a form token derived from your session, the matching cookie, and an `Origin` or `Referer` from the UI's own address.
- **The UI never accepts a bearer token,** and `/mcp` never accepts the session cookie.

## Sign out

The header shows "Signed in as …". Open it for:

- **Sign out**: ends the session in this browser.
- **Sign out everywhere**: ends every session, in every browser.

Every session also ends when:

- `SMB_OWNER_EMAIL` changes (this also clears the pinned account, so the next sign-in pins the new one);
- `SMB_SECRET_KEY` changes.

Signing out doesn't disconnect AI assistants. To disconnect them, use **Sign out all** or create a new token in Settings → AI assistants.

## AI assistants

Assistants keep connecting with the toolkit token, as before (see [AI assistants](ai-assistants.md)). With sign-in on, the connect page can also accept your owner session instead of the token: when your public URL and UI are on the same address, it offers **Sign in with Google**, then you choose **Connect**. You always confirm the connection on that page.

## Changing the owner

Set `SMB_OWNER_EMAIL` to the new address and restart. Every session ends and the pinned account is cleared; the new owner signs in and is pinned.

If the owner's Google account was deleted and created again under the same address, the pinned account no longer matches. To clear the pin, set `SMB_OWNER_EMAIL` to any other address, restart, set it back and restart again.

## Turning it off

Remove `SMB_GOOGLE_CLIENT_ID` and restart. The UI goes back to loopback mode: keep it off the internet, behind an SSH tunnel.
