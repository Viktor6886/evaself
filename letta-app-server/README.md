# Letta App Server

Self-hosted runtime агентов Евы. Это режим зафиксированного пакета
`@letta-ai/letta-code`, а не старый Python REST server:

```bash
letta --backend local server --listen ws://0.0.0.0:4500
```

App Server доступен только внутри сегмента `evaself-agent`, где кроме него
живёт лишь его единственный клиент. Использует capability
token и принимает подключения только от официального Agent SDK в
`eva-agent-service`.

Agents, conversations и memory filesystem находятся в
`letta_app_server_data`. Локальная конфигурация OpenAI provider находится
в отдельном shared volume `letta_provider_config`.

После безопасного изменения LLM `eva-agent-service` записывает marker в
`letta_llm_control`. Entrypoint перезапускает только процесс App Server,
чтобы сбросить model cache; volumes и идентификаторы не меняются.

Образ основан на Debian Bookworm Slim: `node-pty` требует нативной glibc
сборки и не имеет подходящего Alpine/musl prebuild.
