# WebApp

Static front-end, served by Caddy inside `evaself-network`. No build step,
no Node runtime.

| Path | Served on | What it is |
|---|---|---|
| `/` | `https://{DOMAIN}` | Public landing page |
| `/app/` | `https://{DOMAIN_APP}` | Eva's Telegram Mini App |

The edge Caddy rewrites requests for `{DOMAIN_APP}` to `/app{uri}`, so both
surfaces come out of one container and one image.

## API access

The Mini App calls `/api/*` on its own origin. Caddy strips the prefix and
forwards to `eva-core`, which verifies the `X-Telegram-Init-Data` header —
the launch payload Telegram signs with the bot token. The client never
sends a user id the server would have to trust.

Nothing in `public/` contains a domain name or a bot handle: the landing
page asks `/api/public/bot` for the bot username at runtime, so the same
image works for any installation.

## Editing

The files are plain HTML/CSS/JS. After changing them:

```bash
make build && make restart
```
