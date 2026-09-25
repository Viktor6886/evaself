# osint-worker

Детерминированные сборщики OSINT для Евы. Сервис ничего не решает и
ничего не помнит: `eva-agent-service` присылает конкретный запрос, сервис
возвращает структурированный результат. Выбор сборщиков, бюджет,
тождество сущностей и отчёт — в `eva-agent-service`
(`src/osint/`), когнитивная работа — в Letta. Правила контура —
`docs/OSINT.md`.

## Что внутри

| Компонент | Версия | Лицензия | Роль |
|---|---|---|---|
| Maigret | 0.6.6 | MIT | поиск аккаунтов по username |
| WhatsMyName (данные) | `062bcfe` | CC BY-SA 4.0 | независимая проверка профиля |
| Sherlock (данные) | `3760187` | MIT | независимая проверка профиля |
| FollowTheMoney | 4.11.0 | MIT | модель сущностей |
| nomenklatura | 4.17.0 | MIT | признаки сходства (`LogicV2`) |

Из Sherlock и WhatsMyName берутся только наборы правил; проверка
выполняется своим кодом (`app/site_rules.py`) через `app/netguard.py`.

## API

Все маршруты, кроме `/health`, требуют заголовок `X-Osint-Key`
(`OSINT_WORKER_TOKEN`). Ошибка — `{"error": {code, message, retryable}}`.

- `GET /health` — число загруженных правил.
- `POST /v1/username/scan` `{username, top_sites?}` — Maigret.
- `POST /v1/username/verify` `{username, hosts[≤100], sources[]}` —
  проверка профилей правилами WhatsMyName/Sherlock.
- `POST /v1/match/compare` `{left, right}` — признаки nomenklatura для
  двух сущностей FtM (Person, Organization, Company, LegalEntity,
  PublicBody, UserAccount).

## Ограничения

- Обход Cloudflare, прокси и Tor выключены; сайты с `protection` в
  WhatsMyName пропускаются. Капча и 429 — деградация, а не «не найден».
- Исключены категории, раскрывающие особые данные: знакомства, здоровье,
  религия, политика, взрослый контент, геосоциальные сервисы.
- Каждый URL и каждый редирект проверяются: только http/https, порты
  80/443, все адреса публичные.
- На домен — не больше `OSINT_PER_DOMAIN_CONCURRENCY` запросов, после
  трёх отказов подряд домен пропускается пять минут.

## Переменные

| Переменная | Умолчание |
|---|---|
| `OSINT_WORKER_TOKEN` | обязателен при `EVA_ENV=production` |
| `OSINT_TOP_SITES` | 300 (10…1500) |
| `OSINT_SITE_TIMEOUT_SECONDS` | 6 |
| `OSINT_SCAN_DEADLINE_SECONDS` | 180 |
| `OSINT_MAX_CONNECTIONS` | 20 |
| `OSINT_PER_DOMAIN_CONCURRENCY` | 2 |

## Разработка

```
docker build --target test osint-worker    # ruff + pytest
docker build osint-worker                  # рантайм-образ
```

Сервис включается профилем compose `osint` (`COMPOSE_PROFILES=osint`);
по умолчанию он не запускается.

## Атрибуция

Правила проверки профилей взяты из проекта WhatsMyName
(https://github.com/WebBreacher/WhatsMyName), © WebBreacher и участники,
лицензия CC BY-SA 4.0; набор используется без изменений. Правила Sherlock
(https://github.com/sherlock-project/sherlock) — лицензия MIT.
