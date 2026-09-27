# browser-service

Изолированный браузер Евы: Playwright + Chromium. Модель получает не HTML,
а компактный снимок дерева доступности со ссылками на элементы
(`[ref=e12]`) и действует по ним: `browser_open`, `browser_snapshot`,
`browser_click`, `browser_type`, `browser_scroll`, `browser_back`,
`browser_close`. Инструменты регистрирует eva-agent-service
(`src/browser/`); этот сервис — только исполнитель.

## Границы

| Граница | Как держится |
|---|---|
| Нет доступа к данным | Сервис не знает ни PostgreSQL, ни Valkey, ни Letta, ни сокета Docker: их нет в коде и нет в его сети `browser` |
| SSRF | Каждый запрос страницы проверяется до отправки, а весь трафик Chromium идёт через локальный прокси, который сам разрешает имя и соединяется с проверенным IP. Частные, loopback, link-local, служебные адреса и имена без точки закрыты; DNS rebinding не проходит |
| Только чтение | Запросы с методом, отличным от GET/HEAD/OPTIONS, отменяются: отправить форму, оплатить, оставить комментарий браузер не может |
| Чувствительные поля | Значения полей пароля, кода и карты в снимке скрыты, ввод в них отклоняется; ключи и токены, показанные страницей, маскируются |
| Пределы | Сессий всего и на владельца, простой, возраст, время операции, размер снимка, длина ввода. Зависшая операция закрывает сессию |
| Изоляция сессий | Своя `BrowserContext` на сессию; сессия привязана к владельцу, чужой владелец её не видит |
| Прочее | Загрузки, всплывающие окна, диалоги, разрешения и service workers выключены; WebRTC без прямого UDP; QUIC выключен |

Содержимое сайта — данные, а не инструкции: eva-agent-service отдаёт
снимок модели в конверте недоверенного содержимого.

Журнал сервиса — только операция, код исхода и длительность: ни адресов
страниц, ни введённого текста, ни снимков.

## API

Все маршруты, кроме `/health`, требуют заголовок `X-Browser-Key` со
значением `BROWSER_SERVICE_TOKEN`. Тело — JSON с `owner` (непрозрачный
псевдоним владельца, 8–64 символа `[A-Za-z0-9_-]`).

| Маршрут | Тело |
|---|---|
| `POST /v1/sessions/:id/open` | `{ owner, url }` |
| `POST /v1/sessions/:id/snapshot` | `{ owner, offset? }` |
| `POST /v1/sessions/:id/click` | `{ owner, ref }` |
| `POST /v1/sessions/:id/type` | `{ owner, ref, text, submit? }` |
| `POST /v1/sessions/:id/scroll` | `{ owner, direction: "up"\|"down", pages? }` |
| `POST /v1/sessions/:id/back` | `{ owner }` |
| `DELETE /v1/sessions/:id` | `{ owner }` |
| `GET /v1/sessions` | — (метаданные: возраст, простой, число операций) |
| `GET /health` | — |

Ответ операции: `{ ok, session, url, title, snapshot, truncated,
totalLines, nextOffset, status, blockedRequests }`; отказ — `{ ok: false,
error, message }` с кодом `blocked_url`, `invalid_ref`, `sensitive_field`,
`session_limit`, `timeout`, `not_found`, `forbidden`, `navigation_failed`.

## Настройки

`BROWSER_SERVICE_TOKEN` (обязателен в production), `BROWSER_MAX_SESSIONS`
(8), `BROWSER_MAX_SESSIONS_PER_OWNER` (2), `BROWSER_SESSION_IDLE_MS`
(300000), `BROWSER_SESSION_MAX_AGE_MS` (1800000),
`BROWSER_OPERATION_TIMEOUT_MS` (15000), `BROWSER_NAVIGATION_TIMEOUT_MS`
(20000), `BROWSER_SNAPSHOT_MAX_CHARS` (12000), `BROWSER_MAX_TYPE_CHARS`
(2000). У каждого числа есть потолок.

## Проверки

```
npm ci && npm test          # нужен Chromium: BROWSER_EXECUTABLE_PATH или образ Playwright
docker build --target test . # то же в образе
```

Решения по снимкам, сессиям и маскированию секретов повторяют Hermes
Agent (`tools/browser_tool*.py`, MIT, Nous Research); код написан заново.
