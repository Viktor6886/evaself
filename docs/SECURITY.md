# Модель безопасности

## Сеть

Наружу опубликованы только Caddy 80/443. PostgreSQL, Valkey, Letta App
Server, `eva-agent-service`, Media Service, SearXNG и backup
helper находятся во внутренней `evaself-network`.

Административная Letta UI защищена Caddy Basic Auth. Браузер вызывает
только `/api/*`; Caddy добавляет внутренний `X-API-Key`, поэтому ключ
`eva-agent-service` не попадает в JavaScript.

Capability token Letta App Server также не возвращается: раздел настроек SDK
показывает только факт его наличия. WebUI не принимает исполняемые callback
или JavaScript custom tools — такие расширения добавляются только в
исходный код сервиса, чтобы административная форма не превращалась в
удалённое выполнение кода.

Удаление agent требует точного повторного ввода `agent_id`. Операция
необратима; перед массовыми изменениями выполните backup.

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

## Backup

Backup содержит `.env`, Telegram tokens, ключи шифрования, agents, memory,
настройки runtime и Letta provider store. Архив mode 600 — минимальная защита,
а не шифрование. Для внешнего хранения зашифруйте его отдельно.

## Проверка перед commit

```bash
git status --short
git grep -nE 'BEGIN (RSA|OPENSSH) PRIVATE KEY'
git ls-files .env
```

CI дополнительно проверяет отсутствие `.env`, приватных ключей и Telegram
bot token в tracked files.

Публичный Telegram webhook проверяет заголовок
`X-Telegram-Bot-Api-Secret-Token`. Lava webhook использует отдельные HTTP
Basic Auth credentials и до изменения подписки сверяет event type, product,
сумму, валюту и уникальный payment ID.

Telegram Mini App использует другой механизм: каждый запрос к `/public/*`
передаёт исходный `initData` в `X-Telegram-Init-Data`. Backend проверяет HMAC
по bot token, ограничивает возраст `auth_date` и извлекает Telegram ID только
из подписанного payload. ID из body или query не считается доверенным.

Деструктивные Agent SDK tools проверяют `confirm=DELETE` в backend.
Служебные conversation purposes дополнительно ограничивают доступные tools:
например, `research` может искать, но не изменять профиль и не удалять данные.
