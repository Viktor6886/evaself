# Перенос на другой сервер

Перенос — это restore полного backup и смена DNS.

## Подготовка

За сутки уменьшите TTL шести DNS-записей до 300 секунд. На старом сервере:

```bash
make doctor
make backup
ls -lh /var/backups/evaself/
```

Архив содержит все секреты, provider credentials и память. Передавайте его
только по SSH/SCP или в зашифрованном виде.

## Новый сервер

```bash
git clone https://github.com/Viktor6886/evaself.git
cd evaself
sudo make install
make restore BACKUP=/root/evaself-backup-….tar.gz.enc
make doctor
make test-llm
```

Значения первоначального мастера будут заменены restore. Старый
`LLM_CONFIG_ENCRYPTION_KEY` и `letta_provider_config` обязательно должны
переноситься вместе с дампом `llm_providers`.

## Проверка до DNS

Временно добавьте домены в hosts на своём компьютере и проверьте HTTPS,
Letta UI, активную LLM и тестовый agent turn.

```bash
make shell-db
SELECT telegram_id, agent_id, conversation_id FROM v_agent_runtime;
SELECT name, model, is_active FROM llm_providers;
```

Сравните идентификаторы со старым сервером и убедитесь, что известный факт
из памяти доступен.

## Переключение

Остановите Telegram webhook на старом сервере, измените DNS, установите
webhook на новом и наблюдайте логи. Старый сервер не удаляйте минимум
несколько дней.

Rollback миграции: вернуть DNS и webhook на старый сервер. Не запускайте
два активных webhook одновременно.
