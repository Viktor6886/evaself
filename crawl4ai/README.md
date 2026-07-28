# Crawl4AI (необязательно)

Crawl4AI преобразует веб-страницу в очищенный Markdown. Профиль выключен по
умолчанию и включается мастером установки или значением:

```dotenv
COMPOSE_PROFILES=crawl4ai
```

После изменения:

```bash
make start
```

Сервис доступен только внутри `evaself-network` и защищён
`CRAWL4AI_API_TOKEN`.
