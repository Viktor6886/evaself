# Установка

## До начала

Подготовьте Ubuntu 24.04 x86_64, DNS-записи семи доменов, Telegram bot
token, числовой Telegram ID владельца и данные OpenAI-compatible LLM:
название конфигурации, Base URL, API Key, модель и context window.

Порты 80/tcp, 443/tcp и 443/udp должны быть доступны из интернета. SSH-порт
не меняется установщиком.

## Запуск

```bash
git clone https://github.com/Viktor6886/evaself.git
cd evaself
sudo make install
```

Мастер спрашивает домены, Telegram, LLM и дополнительные профили. Все
остальные пароли и токены генерируются один раз. `.env` получает mode 600
и исключён из Git.

После запуска установщик:

1. устанавливает Docker, firewall и Fail2Ban;
2. создаёт конфигурацию и собирает образы;
3. запускает PostgreSQL/Valkey и остальные сервисы;
4. применяет миграции;
5. создаёт, проверяет и активирует первую LLM-конфигурацию;
6. импортирует минимальный n8n workflow;
7. устанавливает systemd timer ежедневного backup;
8. запускает `make doctor`.

Если провайдер не проходит проверку, установка останавливается с понятной
ошибкой: нерабочая конфигурация не помечается активной.

## После установки

```bash
make doctor
scripts/telegram-webhook.sh set
make configure-llm       # дополнительные провайдеры
make list-models
```

Откройте n8n, создайте owner account и активируйте минимальный E2E workflow.
В NocoDB подключите базу командой `scripts/nocodb-connect.sh`.

Административная консоль Letta защищена Basic Auth. В ней доступны agents,
conversations, чат, «Настройки SDK» и «Настройки LLM». Секреты LLM и
capability token App Server не показываются.

## Повторный запуск

`sudo make install` можно выполнить повторно: существующие секреты,
PostgreSQL, volumes, agents, conversations и LLM-конфигурации сохраняются.
Повторный импорт `.env` пропускается, если реестр LLM уже заполнен.

## Диагностика

```bash
make status
make doctor
make logs s=eva-agent-service
make logs s=letta-app-server
make test-llm
```

## Удаление

`make stop` останавливает сервисы и сохраняет данные. Удаление volumes
намеренно выполняется только вручную. Перед ним обязательно сделайте
`make backup`: отменить удаление volumes невозможно.
