# Letta App Server (self-hosted)

Eva's agent runtime. Started as:

```
letta --backend local server --listen ws://0.0.0.0:4500 \
      --ws-auth capability-token --ws-token-file /data/letta/ws-token
```

## What it actually is

The App Server is **a mode of the Letta Code CLI**, not a separate
product. `@letta-ai/letta-code` provides `letta server --listen`, and
`@letta-ai/letta-agent-sdk` is its client. So this image is the pinned CLI
package plus an entrypoint, rather than an upstream image — there is no
`letta/app-server` on Docker Hub, and `letta/letta` is the older Python
REST server, which the Agent SDK does not speak to.

`letta app-server` still works but prints a deprecation notice; the current
spelling is `letta server --listen`.

## How it is wired

```
eva-agent-service ──@letta-ai/letta-agent-sdk──> ws://letta-app-server:4500/ws
                                                      │
                                                      ├── agents          /data/letta/lc-local-backend/agents
                                                      ├── conversations   /data/letta/lc-local-backend/conversations
                                                      └── memory (memfs)  /data/letta/lc-local-backend/memfs
```

* **WebSocket only.** No REST, no HTML. A browser cannot be its client;
  the console goes through `eva-agent-service` (see `letta-ui/README.md`).
* **Never published.** Port 4500 exists on `evaself-network` only.
* **Capability token.** Non-loopback listeners are authenticated. The
  entrypoint writes `LETTA_APP_SERVER_TOKEN` to a file, because the CLI
  takes the token by path — never on a command line, where `ps` would show
  it.
* **State on disk.** Agents, conversations and the memory filesystem live
  in the `evaself_letta_app_server_data` volume. That volume *is* the agent
  state, and `make backup` captures it whole.

`LETTA_APP_SERVER_BACKEND=local` keeps every agent on this server. The
alternative, `api`, delegates to Letta Cloud — which is not what a
self-hosted installation wants, and Evaself does not default to it.

## The model

Letta Code resolves models through its own provider registry, so Eva's
endpoint is registered once, inside this container:

```bash
make configure-letta
```

which runs

```bash
letta connect openai-compatible \
  --base-url "$EVA_LLM_BASE_URL" --api-key "$EVA_LLM_API_KEY" --name eva-llm
```

The credential lands in the state volume and survives restarts and
restores. Then set `EVA_LLM_MODEL` in `.env` to one of the handles that
`make configure-letta` prints, and `make restart`.

**Note:** `letta connect` validates a new provider against
`api.letta.com`. If your server's egress policy blocks that host, the
registration fails and turns will fail with `turn_failed` until it is
allowed — agents, conversations and memory are unaffected.

## Poking at it directly

The CLI is itself a client of the App Server, so it is the supported way to
inspect the runtime by hand:

```bash
COMPOSE="docker compose --env-file versions.env --env-file .env"
$COMPOSE exec letta-app-server letta agents list
$COMPOSE exec letta-app-server letta messages --help
$COMPOSE exec letta-app-server letta skills
```

## Upgrading

`LETTA_CODE_VERSION` and `LETTA_AGENT_SDK_VERSION` in `versions.env` must
stay in step: the SDK pins an exact Letta Code version and the two speak a
versioned protocol. `make update` keeps them together, exactly as it does
for n8n and its task runner.
