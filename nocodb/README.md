# NocoDB

Графический административный просмотр данных Евы. PostgreSQL остаётся
источником истины.

NocoDB использует отдельную базу `nocodb` для своих metadata, а `eva`
подключается как внешний data source с отдельной ролью. Параметры подключения:

```bash
scripts/nocodb-connect.sh
```

Основные представления: `v_user_overview`, `v_agent_runtime`,
`v_quota_status`, `v_revenue_monthly`, `v_crisis_open`. LLM-конфигурации
редактируйте только через Letta UI/API, а не напрямую в NocoDB: активация
требует проверки, App Server restart и SDK update.
