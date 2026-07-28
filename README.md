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
| **Letta App Server** | stateful agents, conversations, memory, skills, tools | internal only |
| **eva-agent-service** | TypeScript; owns `@letta-ai/letta-agent-sdk` | internal only |
| **Letta console** | self-hosted admin GUI | `letta.<domain>` |
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

Only seven host names are exposed. PostgreSQL, Valkey, the Letta App
Server and eva-agent-service's internal API are never published.

## How a message flows

```
Telegram
  └─> n8n                    secret-token check, normalise
        └─> eva-agent-service    per-user lock, agent + conversation lookup
              └─> @letta-ai/letta-agent-sdk
                    └─> Letta App Server (ws://…)   memory, skills, tools
                          └─> MiMo / any OpenAI-compatible model
              <─┘
        <─┘  normalised reply, or a typed retryable error
  <─┘  Telegram sendMessage
```

Business logic lives in n8n. `eva-agent-service` stays small on purpose:
it owns the official Agent SDK, creates one agent (and one conversation)
per user, serialises concurrent messages from the same person, and turns
every failure into one error shape. **n8n never reaches the App Server
directly**, and neither does the browser.

## Commands

```bash
sudo make install        # clean Ubuntu -> running system
make configure           # change domains / tokens / model
make configure-letta     # register Eva's model with the App Server
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
make test                # unit tests of eva-agent-service and media-service
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

Per-component notes live next to the code: `eva-agent-service/`,
`letta-app-server/`, `letta-ui/`, `media-service/`, `n8n/`, `webapp/`,
`crawl4ai/`, `skills/`, `library/`.

## A note on the Letta GUI

The App Server speaks a **WebSocket protocol** driven by
`@letta-ai/letta-agent-sdk`, a Node SDK — a browser cannot be its client,
and `letta-oss-ui` is not a published package (npm returns 404). So the
console is Evaself's own: a static client that reads through
`eva-agent-service`, which owns the SDK.
See [letta-ui/README.md](letta-ui/README.md).

For an interactive client, the Letta Code CLI inside the App Server
container is the supported one:
`docker compose … exec letta-app-server letta agents list`.

## Positioning, honestly

Eva is a companion and a self-reflection tool. She is not a therapist and
she does not diagnose.

**Status:** the architecture is in place and the agent path is proven, but
this is not a finished product. `n8n/workflows/` currently holds a single
minimal workflow that exercises
Telegram → n8n → eva-agent-service → Agent SDK → App Server → model.
Eva's full conversational logic, onboarding, payments, subscriptions and
the WebApp are the next milestone. See
[docs/VERIFICATION.md](docs/VERIFICATION.md) for exactly what has been run
and what has not.

## Licence

MIT — see [LICENSE](LICENSE).
