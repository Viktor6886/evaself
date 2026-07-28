# Letta

Letta is Eva's agent runtime: memory, tools, skills and the message loop.
Pinned to **0.16.8** in `versions.env`.

There is no Dockerfile here — the official `letta/letta` image is used
unchanged. This directory documents how it is wired.

## Deployment

```yaml
letta:
  image: letta/letta:0.16.8
  environment:
    LETTA_PG_URI: postgresql://letta:…@postgres:5432/letta
    SECURE: "true"
    LETTA_SERVER_PASSWORD: …
```

* **External PostgreSQL.** Letta uses the same server as everything else,
  in its own database with its own role. The image contains an embedded
  PostgreSQL for quick starts; `LETTA_PG_URI` overrides it, which is what
  makes `pg_dump` and a clean migration possible.
* **pgvector is required.** That is why the stack runs
  `pgvector/pgvector:0.8.5-pg17` rather than plain `postgres`. The
  extension is installed into the `letta` database by
  `postgres/init/00-init-databases.sh`.
* **Not published.** Port 8283 exists only on `evaself-network`. The only
  clients are `eva-core` and `letta-ui`.
* **Password protected.** With `SECURE=true` the server wraps everything
  except the health probes in a middleware that accepts
  `Authorization: Bearer $LETTA_SERVER_PASSWORD` or
  `X-BARE-PASSWORD: password $LETTA_SERVER_PASSWORD`.

## One agent per user

Created by Eva Core on a user's first message, with:

* two core memory blocks — `persona` (from `library/persona/eva.md`) and
  `human` (what Eva learns about the person);
* tags `evaself`, `eva-companion`, `tg:<telegram_id>`, so the agent is
  findable from Letta alone if the `eva` database is ever rebuilt;
* the base tool set;
* `model` and `embedding` as `provider/model` handles, where the provider
  is the OpenAI-compatible endpoint Eva Core registers at start-up.

## Memory

| | |
|---|---|
| core memory | `persona` and `human` blocks, always in context, edited by Eva herself |
| archival memory | pgvector-backed long-term store, searched on demand |
| message history | the full conversation, in PostgreSQL |

Memory survives restarts because all three live in the `letta` database
and the `letta_data` volume — both in every backup.

## Skills

`skills/` is mounted read-only at `/skills`. Letta 0.16 supports skills
attached to an agent (and exported with it) and client-side skills passed
per request. Because they live in the repository, they are versioned in
git, shipped by `make update` and captured by `make backup`. See
`skills/README.md`.

## Export and import

```
GET  /v1/agents/{id}/export
POST /v1/agents/import
```

`make backup` writes one export per agent into `letta/agent-<tg_id>.json`
inside the archive — a portable copy that does not depend on the Letta
version or the PostgreSQL dump. The console offers the same export as a
download button.

## Graphical interface

Letta 0.16.x ships **no** self-hosted UI: the server mounts a single route
redirecting `/` to `/docs`, and the official ADE is hosted at
`app.letta.com`. Evaself therefore ships its own console —
see [`letta-ui/README.md`](../letta-ui/README.md), which also explains how
to point the cloud ADE at this server if you would rather use that.

## Model configuration

From `.env`:

```
EVA_LLM_BASE_URL=https://api.example.com/v1
EVA_LLM_API_KEY=…
EVA_LLM_MODEL=mimo-v2.5-pro
EVA_LLM_CONTEXT_WINDOW=131072
EVA_EMBEDDING_MODEL=text-embedding-3-small
EVA_EMBEDDING_DIM=1536
```

Eva Core registers this as a provider named `eva-llm` on start-up, so a
bare model name becomes the handle `eva-llm/mimo-v2.5-pro`. Writing
`provider/model` yourself in `EVA_LLM_MODEL` overrides that.

Changing the model affects **new** agents. Existing agents keep the model
they were created with; change one from the console's overview tab, or via
`PATCH /v1/agents/{id}`.

## Upgrading

`make update-preview` reports new Letta versions; `make update` backs up
first and rolls back automatically if the health checks fail. Letta runs
its own schema migrations at start-up, so after a version bump watch
`make logs s=letta` until it reports ready.
