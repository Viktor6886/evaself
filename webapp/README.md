# WebApp

Статический landing page и оболочка Telegram Mini App, обслуживаемые Caddy.
Build step и Node runtime не требуются.

```text
/      → публичная страница
/app/  → Telegram Mini App
```

Полные пользовательские функции WebApp относятся к следующему этапу. Сейчас
она не управляет LLM и не получает административные secrets.

Для локальной проверки:

```bash
python3 -m http.server 8000 -d public
```
