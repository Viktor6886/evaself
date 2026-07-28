# n8n

n8n содержит business workflows Евы. Сейчас в репозитории оставлен только
минимальный E2E workflow:

```text
Telegram → n8n → eva-agent-service → Agent SDK → App Server → LLM
```

Queue mode использует Valkey. Основной процесс обслуживает editor/webhooks,
worker выполняет workflows, внешний task runner исполняет Code nodes.
Версии n8n и runner должны совпадать.

n8n не знает URL или token Letta App Server. Он вызывает только защищённый
HTTP API `eva-agent-service`.

```bash
make import-n8n
make export-n8n
make logs s=n8n
```

Импортированные workflows не активируются автоматически.
