# Letta console (self-hosted)

## Why this exists

**Letta 0.16.x does not ship a self-hosted web interface.**

That is not a guess. In the released `letta` 0.16.8 package,
`letta/server/rest_api/static_files.py` contains exactly one route:

```python
def mount_static_files(app: FastAPI):
    @app.get("/", include_in_schema=False)
    async def redirect_to_docs():
        return RedirectResponse(url="/docs")
```

and the server prints, on start-up:

```
▶ View using ADE at: https://app.letta.com/development-servers/local/dashboard
```

So the only official graphical client for a self-hosted Letta server is the
**hosted** ADE at `app.letta.com`, which connects *from your browser* to
your server. Earlier releases bundled a local ADE; that was removed.

Evaself will not present a cloud application as a locally installed one.
This container is therefore Evaself's own console: a static client served
from your server, talking to your Letta instance over the internal Docker
network, with no third-party dependency at runtime.

## How it works

```
browser ──HTTPS──> Caddy (basic auth) ──> letta-ui:8081
                                              │  static client
                                              └─ /api/*  ──> letta:8283
                                                 + Authorization: Bearer $LETTA_SERVER_PASSWORD
```

The Letta server password is injected by the `letta-ui` container's Caddy
and never reaches the browser. `letta:8283` itself is not routed by the
edge, so the Letta REST API is not reachable from the internet at all.

Access is protected twice: HTTP basic auth at the edge
(`LETTA_UI_USER` / `LETTA_UI_PASSWORD`, stored as a bcrypt hash in
`.env`), and the fact that the whole host is only reachable over HTTPS.

## What the console does

| Tab | Letta endpoint |
|---|---|
| overview | `GET /v1/agents/{id}` + `GET /v1/agents/{id}/export` |
| memory | `GET`/`PATCH /v1/agents/{id}/core-memory/blocks[/{label}]` |
| messages | `GET /v1/agents/{id}/messages` |
| chat | `POST /v1/agents/{id}/messages` |
| archival | `GET /v1/agents/{id}/archival-memory` |
| tools | `GET /v1/agents/{id}/tools` |

The sidebar lists and filters every agent (`GET /v1/agents/`), which for
Evaself means one agent per Telegram user, tagged `evaself` and
`tg:<telegram_id>`.

## Using the official cloud ADE instead

If you prefer the official ADE, it can talk to this same server — but it
runs in Letta's cloud, and it needs your server to be reachable and its
password. Publish the Letta API deliberately if you want that:

1. Add a host block to the root `Caddyfile` that proxies to `letta:8283`.
2. In `app.letta.com`, add a self-hosted server with that URL and your
   `LETTA_SERVER_PASSWORD`.

Evaself does not do this by default: it would put the agent API on the
public internet for the convenience of a third-party front-end.
