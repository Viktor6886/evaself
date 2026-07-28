# Hermes Agent

Hermes — операторский агент сервера. Он устанавливается непосредственно в
Ubuntu, потому что должен управлять Docker, systemd, файлами и backup.
Evaself работает и без Hermes.

## Безопасность

Hermes имеет широкие права, поэтому используется отдельный Telegram bot и
allowlist единственного `OWNER_TELEGRAM_ID`. Не добавляйте bot в группы и
не передавайте token.

```bash
make hermes-status
journalctl -u evaself-hermes --since today --no-pager
```

Каждую выполненную команду можно проверить в journal.

## Настройка

```bash
make configure-hermes
make start-hermes
```

Hermes может использовать отдельный OpenAI/Anthropic endpoint или endpoint
Евы. Его LLM-настройки не являются частью реестра Евы и не переключают
models существующих Letta agents.

## Команды

```bash
make configure-hermes
make start-hermes
make stop-hermes
make restart-hermes
make update-hermes
make hermes-status
```

Backup сохраняет конфигурацию Hermes и systemd unit, но restore намеренно
не запускает агента автоматически: сначала проверьте allowlist.
