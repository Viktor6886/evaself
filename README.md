# Evaself

Self-hosted platform for **Eva** — an AI companion and self-discovery
assistant that lives in Telegram, keeps a private memory of every person
who talks to her, and runs entirely on a server you own.

Inspired by the shape of [kossakovsky/selfhost-ai](https://github.com/kossakovsky/selfhost-ai),
but built for one purpose rather than thirty.

```bash
git clone https://github.com/viktor6886/evaself.git
cd evaself
sudo make install
```

One command on a clean Ubuntu 24.04 box. The installer asks for your
domain, two Telegram bot tokens, your Telegram ID and an LLM endpoint,
generates every other secret, and brings the stack up behind automatic
HTTPS.

---

## What you get

| Service | What it is | Reachable at |
|---|---|---|
| **Caddy** | edge, automatic HTTPS (HTTP/1–3) | ports 80/443 |
| **n8n** | Eva's business logic — main + worker + task runner | `n8n.<domain>` |
| **Letta** | stateful agents, memory, tools, skills | internal only |
| **Letta console** | self-hosted GUI for the Letta server | `letta.<domain>` |
| **Eva Core** | thin service between n8n and Letta | internal only |
| **NocoDB** | GUI over Eva's data | `admin.<domain>` |
| **PostgreSQL** | the source of truth (4 separate databases) | internal only |
| **Valkey** | n8n queue + Eva's per-user locks | internal only |
| **WebApp** | landing page + Telegram Mini App | `<domain>`, `app.<domain>` |
| **SearXNG** | private web search for Eva | internal only |
| **Media service** | ffmpeg, ASR, TTS | internal only |
| **Backup service** | version-matched pg_dump/pg_restore | internal only |
| **Crawl4AI** | optional — turns pages into clean markdown | internal only |
| **Uptime Kuma** | optional — status page | `status.<domain>` |
| **Hermes Agent** | your server operator agent, in Ubuntu, not Docker | Telegram |

Only seven host names are exposed. PostgreSQL, Valkey, Letta's API and Eva
Core's internal API are never published.

## How a message flows

```
Telegram
  └─> n8n            secret-token check, normalise, user + quota
        └─> Eva Core     per-user lock, agent lookup
              └─> Letta      memory, tools, skills
                    └─> LLM API
              <─┘
        <─┘  normalised reply, or a typed retryable error
  <─┘  Telegram sendMessage
```

Business logic lives in n8n. Eva Core stays small on purpose: it speaks
the Letta API, creates one agent per user, serialises concurrent messages
from the same person, and turns every failure into one error shape.

## Commands

```bash
sudo make install        # clean Ubuntu -> running system
make configure           # change domains / tokens / model
make status              # what is running
make doctor              # full health report
make logs s=n8n          # follow one service

make backup                          # -> /var/backups/evaself
make restore BACKUP=/path/to.tar.gz  # works on a brand-new server

make update-preview      # what would change, changes nothing
make update              # backup, update, verify, auto-rollback on failure
make rollback            # return to the previous versions

make import-n8n          # repo workflows -> n8n
make export-n8n          # n8n -> repo, so edits are committable

make configure-hermes    # give Hermes an LLM, enable autostart
make hermes-status       # state, allowlist, capabilities

make validate            # static checks, no services touched
make test                # unit tests of eva-core and media-service
make disk-cleanup        # reclaim space, never touches data volumes
```

There is deliberately **no** target that removes data volumes.

## Requirements

* Ubuntu 24.04, root access
* 4 vCPU / 8 GB RAM / 100 GB NVMe (the reference target; 2 vCPU / 4 GB
  works for a small install without Crawl4AI)
* A domain whose records already point at the server
* An OpenAI-compatible LLM endpoint

## Documentation

| | |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | what the installer does, step by step |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | services, data flow, why each decision |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | day-to-day running and troubleshooting |
| [docs/BACKUP.md](docs/BACKUP.md) | what is backed up, and what a restore guarantees |
| [docs/MIGRATION.md](docs/MIGRATION.md) | moving to another VPS without losing data |
| [docs/UPDATING.md](docs/UPDATING.md) | update, rollback, PostgreSQL majors |
| [docs/HERMES.md](docs/HERMES.md) | the server agent, and why it is unsandboxed |
| [docs/SECURITY.md](docs/SECURITY.md) | the actual security model |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | what has been tested, and what has not |

Per-component notes live next to the code: `eva-core/`, `letta-ui/`,
`media-service/`, `n8n/`, `webapp/`, `crawl4ai/`, `skills/`, `library/`.

## A note on the Letta GUI

Letta 0.16.x ships **no** self-hosted web interface — its server only
redirects `/` to `/docs`, and the official ADE is the hosted application
at `app.letta.com`. Evaself does not pass a cloud app off as a local one,
so it ships its own console instead: static client, Caddy injecting the
server password, Letta's API never leaving the internal network.
See [letta-ui/README.md](letta-ui/README.md).

## Positioning, honestly

Eva is a companion and a self-reflection tool. She is not a therapist,
she does not diagnose, and the crisis screen in
`n8n/workflows/05-eva-crisis-check.json` exists because a system people
talk to at 3 a.m. needs one.

## Licence

MIT — see [LICENSE](LICENSE).
