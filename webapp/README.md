# WebApp

Статический landing page и оболочка Telegram Mini App, обслуживаемые Caddy.
Build step и Node runtime не требуются.

```text
/      → публичная страница
/app/  → Telegram Mini App
```

Mini App содержит разделы «Сегодня», «Цели», «Прогресс» и «Профиль».
Он работает с задачами, целями, рабочими блоками и подтверждением профиля,
но не управляет LLM и не получает административные secrets.

Каждый запрос к `/api/public/*` несёт Telegram `initData`; Caddy передаёт его
в `eva-agent-service`, где проверяются HMAC и срок подписи. Статические файлы
не содержат bot token или пользовательский ID.

Для локальной проверки:

```bash
python3 -m http.server 8000 -d public
```
