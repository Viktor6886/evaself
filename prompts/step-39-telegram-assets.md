# Шаг 39. Контакты, файлы и расширение TelegramClient

- **Приоритет:** P6
- **Зависит от:** шаг 38
- **Feature flag:** EVA_TELEGRAM_ASSETS
- **Размер:** M

> Протокол — `CLAUDE.md`. Шаг выполняется внутри batch: pull request, CI и ревью — на batch, не на шаг.

---

**ЦЕЛЬ.** Позволить Еве безопасно принимать и отправлять контакты и файлы.

**СДЕЛАЙ.**
1. Создай `user_assets`: владелец, путь или `file_id`, имя файла, MIME, размер, SHA-256, источник, статус, срок жизни, timestamps.
2. Добавь tools `request_user_contact`, `send_saved_contact`, `send_telegram_file(asset_id, caption)`. Запрос контакта объясняет цель, работает только в личном чате, проверяет `contact.user_id`, удаляет reply keyboard и не пишет телефон в логи. Отправка сохранённого контакта принимает только внутренний идентификатор.
3. В outbox хранится `asset_id`, а не сырой файл. Модели запрещены произвольные серверные пути, внешние URL, base64 и чужие файлы.
4. Расширь `TelegramClient` методами `answerCallbackQuery`, `editMessageReplyMarkup`, `sendPoll`, `stopPoll`, `sendContact`, `requestContact`, `removeReplyKeyboard`, `sendDocumentByFileId`, `sendDocumentFromAsset`. Не сломай HTML-разметку, разбиение длинных сообщений, progressive draft, голосовые ответы и существующий `reply_markup`.
5. Размести Telegram-инструменты в `eva-agent-service/src/tools/telegram-interaction-tools.ts` и зарегистрируй их в Tool Gateway из шага 14.

**НЕ ДЕЛАЙ В ЭТОМ ШАГЕ.** Не обрабатывай содержимое файлов — это шаг 42. Не добавляй генерацию документов — шаг 43.

**ТЕСТЫ.** Отправка по `file_id` и по `asset_id`; запрет чужого файла и произвольного пути; multipart; повтор доставки из outbox; телефон отсутствует в логах; существующее форматирование не сломано.

**ГОТОВО, КОГДА.** Файлы и контакты передаются в обе стороны, и модель не может обратиться к чужому объекту.

---
