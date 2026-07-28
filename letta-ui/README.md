# Letta console (self-hosted)

Administrative interface for the agents running on this installation's
Letta App Server.

## Why it is not `letta-oss-ui`

The brief asked to check `letta-oss-ui` and use it only if it is genuinely
compatible. It was checked, and it is not usable here:

```
$ curl -s https://registry.npmjs.org/letta-oss-ui            -> 404 Not found
$ curl -s https://registry.npmjs.org/@letta-ai/letta-oss-ui  -> 404 Not found
```

No such package is published. Beyond the missing package, there is a
structural reason a browser front-end cannot talk to the App Server at all:

* the App Server's only interface is a **WebSocket protocol** — it is
  started as `letta server --listen ws://0.0.0.0:4500` and serves no HTML
  and no REST;
* that protocol is driven by `@letta-ai/letta-agent-sdk`, a **Node** SDK
  (`engines: node >= 22.19`), which cannot run in a page.

So the console is Evaself's own, and it reads through the one component
that does own the SDK.

## How it works

```
browser ──HTTPS──> Caddy (basic auth) ──> letta-ui:8081
                                              │  static client
                                              └─ /api/*  ──> eva-agent-service:8070
                                                 + X-API-Key (added by Caddy)
                                                       │
                                                       └── @letta-ai/letta-agent-sdk
                                                              └── ws://letta-app-server:4500/ws
```

The internal API key is injected by this container's Caddy and never
reaches the browser. Neither `eva-agent-service` nor the App Server is
routed from the internet.

Access is protected twice: HTTP basic auth at the edge
(`LETTA_UI_USER` / `LETTA_UI_PASSWORD`, stored as a bcrypt hash in `.env`)
and the fact that the host is HTTPS-only.

## What the console shows

| Tab | Reads / writes |
|---|---|
| overview | the `user → agent → conversation` mapping from PostgreSQL, plus "new conversation" and "release turn lock" |
| conversations | `GET /v1/conversations/{telegramId}` — every conversation of that agent, with the active one marked |
| messages | `GET /v1/conversations/{telegramId}/messages` |
| chat | `POST /v1/messages` — a real turn through the SDK, without Telegram |

The header shows the agent service version and the live App Server state
(reachable, and how many models it offers).

## Using Letta's own clients instead

`letta` (the Letta Code CLI) is itself a client of the App Server. To use
it against this installation, run it with the same URL and token:

```bash
docker compose --env-file versions.env --env-file .env \
  exec letta-app-server letta agents list
```

That is the officially supported interactive client for a self-hosted App
Server; Letta Cloud's web ADE is for cloud-hosted agents and is not what
this installation runs.
