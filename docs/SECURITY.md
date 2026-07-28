# Модель безопасности

## Сеть

Наружу опубликованы только Caddy 80/443. PostgreSQL, Valkey, Letta App
Server, `eva-agent-service`, Media Service, SearXNG, n8n workers и backup
helper находятся во внутренней `evaself-network`.

Административная Letta UI защищена Caddy Basic Auth. Браузер вызывает
только `/api/*`; Caddy добавляет внутренний `X-API-Key`, поэтому ключ
`eva-agent-service` не попадает в JavaScript.

## Секреты LLM

- API Key принимается мастером, CLI или WebUI только при создании/замене;
- в PostgreSQL хранится AES-256-GCM ciphertext;
- административный API возвращает только `api_key_configured: true`;
- официальный Letta CLI получает ключ через скрытый PTY prompt, не через argv;
- ключ шифрования `LLM_CONFIG_ENCRYPTION_KEY` генерируется один раз;
- provider volume и backup являются секретными, даже если UI скрывает ключ.

Потеря ключа шифрования делает записи реестра нечитаемыми. Не меняйте его
при обновлении.

## Host

- UFW запрещает входящие соединения, кроме SSH и 80/443;
- Fail2Ban защищает SSH;
- Docker API не публикуется;
- `.env` mode 600 и исключён из Git;
- контейнерные логи ограничены ротацией.

## Hermes

Hermes работает на host с широкими правами. Главная граница — отдельный
Telegram bot и allowlist одного `OWNER_TELEGRAM_ID`. Не добавляйте Hermes
в групповой чат и регулярно проверяйте journal.

## Backup

Backup содержит `.env`, Telegram tokens, ключи шифрования, n8n credentials,
agents, memory и Letta provider store. Архив mode 600 — минимальная защита,
а не шифрование. Для внешнего хранения зашифруйте его отдельно.

## Проверка перед commit

```bash
git status --short
git grep -nE 'BEGIN (RSA|OPENSSH) PRIVATE KEY'
git ls-files .env
```

CI дополнительно проверяет отсутствие `.env`, приватных ключей и Telegram
bot token в tracked files.
