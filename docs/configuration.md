# Configuration

All settings are environment variables, read at start. Values you change in the UI's Settings page are stored in the database and override the environment where both exist; the page says which is in effect.

| Variable | Default | Meaning |
|---|---|---|
| `SMB_PUBLIC_URL` | — (required) | The URL the tag posts to, e.g. `https://t.example.com`. Used in the snippet and in the setup check. |
| `SMB_TZ` | `UTC` | Timezone for windows and the summary. IANA name. |
| `SMB_PORT` | `8080` | Port the process listens on. |
| `SMB_BIND` | `127.0.0.1` | Interface to bind. Compose sets `0.0.0.0` inside the container network; Caddy exposes only `/collect`, `/sdk` and `/mcp`. |
| `SMB_DATA_DIR` | `/data` | SQLite file, uploads, packages. Mount a volume here. |
| `SMB_TRUST_PROXY` | `0` | Set `1` when behind Caddy or another proxy so the visitor IP is taken from `X-Forwarded-For` — the **last** hop, the one your proxy appended; anything a client wrote before it is ignored. Rate limits are per visitor: 120 a minute keyed on this client address (IPv6 by /64), plus a 6,000-a-minute cap per connecting address in case something reaches the port directly and makes up the header. Only set it when a proxy you control is the only thing that can reach the port. Compose sets it. |
| `SMB_RETENTION_DAYS` | `90` | Days to keep click records. Minimum 60. |
| `SMB_MAX_UPLOAD_MB` | `100` | Upload size cap, uncompressed. |
| `SMB_STORE_WARN_MB` | `2048` | Show a notice when the data directory exceeds this. |
| `SMB_TELEMETRY` | `on` | `off` disables anonymous usage counts. See [TELEMETRY.md](../TELEMETRY.md). |
| `SMB_UPDATE_CHECK` | `on` | `off` disables the daily version check. |
| `SMB_LOG_LEVEL` | `info` | `debug` includes request details; never visitor IPs at `info`. |
| `SMB_MCP_TOKEN` | — | Bearer token for AI assistants at `/mcp`. Overrides the one created in Settings → AI assistants. With neither, `/mcp` answers 404. See [AI assistants](ai-assistants.md). |

`.env.example` in the repository lists all of them with comments.

## The Compose file

```yaml
services:
  toolkit:
    image: ghcr.io/10xlabsio/savemybudget-toolkit:1
    restart: unless-stopped
    env_file: .env
    environment:
      SMB_BIND: 0.0.0.0
      SMB_TRUST_PROXY: "1"
      # SMB_TELEMETRY: "off"
    volumes:
      - smb-data:/data
    ports:
      - "127.0.0.1:8080:8080"   # UI, loopback only

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config

volumes:
  smb-data:
  caddy-data:
  caddy-config:
```

And the `Caddyfile`:

```
t.example.com {
    handle /collect* {
        reverse_proxy toolkit:8080
    }
    handle /sdk/* {
        reverse_proxy toolkit:8080
    }
    @mcp path /mcp /mcp/*
    handle @mcp {
        reverse_proxy toolkit:8080
    }
    handle {
        respond 404
    }
}
```

Replace `t.example.com` with your subdomain. Caddy obtains and renews the certificate on its own. `/mcp` is the endpoint for AI assistants; it answers 404 until you turn it on and then requires a token — see [AI assistants](ai-assistants.md). Installs from before 1.1.0 need the `@mcp` block added to reach it from another machine.

## Exposing the UI

Don't, if you can avoid it — an SSH tunnel is the simplest safe option. If you must, add a second site block to the Caddyfile with basic auth:

```
ui.example.com {
    basic_auth {
        admin <hash from `caddy hash-password`>
    }
    reverse_proxy toolkit:8080
}
```

## Behind your own reverse proxy

Point `/collect`, `/sdk/` and (for AI assistants) `/mcp` at the toolkit's port, forward `X-Forwarded-For`, set `SMB_TRUST_PROXY=1`, and keep everything else off the internet. TLS is required on the public URL: browsers won't post beacons from an HTTPS page to an HTTP endpoint.

## Running without Docker

```bash
npm install -g @savemybudget/toolkit
SMB_PUBLIC_URL=https://t.example.com SMB_DATA_DIR=./data smb-toolkit
```

Node 20 or newer. You provide TLS and the proxy yourself.
