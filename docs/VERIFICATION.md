# Проверка

GitHub Actions выполняет:

1. TypeScript typecheck и build;
2. unit-тесты `eva-agent-service`;
3. проверку, что Letta вызывается только через официальный Agent SDK;
4. три последовательных применения всех PostgreSQL migrations;
5. сборку всех локальных Docker-образов;
6. тесты Media Service с реальным ffmpeg;
7. запуск PostgreSQL, Valkey, App Server и `eva-agent-service`;
8. создание agent и conversation через Agent SDK;
9. сохранение связи в PostgreSQL;
10. изменение и сохранение настроек SDK без раскрытия capability token;
11. создание, изменение и удаление административного agent, а также
    создание и архивирование его conversation через официальный SDK;
12. создание двух LLM-конфигураций на изолированном mock endpoint;
13. проверку `/models`, последовательную активацию двух моделей и отсутствие
    API Key в ответах;
14. переключение модели у Telegram- и самостоятельного WebUI-agent;
15. реальный SDK-turn через WebUI chat API и потоковый mock LLM;
16. сравнение `agent_id`/`conversation_id` до и после переключения;
17. перезапуск App Server и `eva-agent-service`, затем повторную проверку
    LLM, SDK-настроек и идентификаторов.
18. HMAC, срок `auth_date` и запрет подмены Telegram ID во всех public
    WebApp-маршрутах;
19. профиль, IANA timezone/DST, цели, граф, purpose conversations,
    шесть memory blocks и backend-подтверждение удаления;
20. durable inbox/outbox и разделение метрик PostgreSQL enqueue и Telegram
    delivery;
21. выборочное `conversation_highlights` без таблицы полного transcript.

## Локальные команды

```bash
cd eva-agent-service
npm ci
npm run typecheck
npm run build
npm test

cd ..
make validate
make test
```

## Проверка на VPS

```bash
sudo make install
make doctor
make test-llm
make list-models
```

Затем:

1. создайте agent и conversation в WebUI и выполните реальный ход в чате;
2. отправьте сообщение через прямой Telegram webhook;
3. запомните agent/conversation и добавьте в память проверочный факт;
4. добавьте второй реальный LLM и активируйте его;
5. убедитесь, что ответ использует новую модель, а факт из памяти доступен;
6. измените настройки SDK и перезапустите App Server и `eva-agent-service`;
7. убедитесь, что ID, память, SDK-настройки и активная LLM сохранились;
8. проверьте архивирование conversation и удаление отдельного test agent;
9. создайте заметку, запись бюджета и задачу через инструменты агента;
10. проверьте повтор задачи и heartbeat в часовом поясе пользователя;
11. выполните backup и restore на тестовом VPS;
12. проверьте, что WebUI нигде не показывает API Key или App Server token.
13. откройте Mini App из Telegram и проверьте «Сегодня», создание цели,
    «Начать»/«Готово», прогресс и автосохранение профиля;
14. перезапустите стек с queued inbox/outbox записью и убедитесь, что
    обработка продолжается без второго Letta turn;
15. проверьте структурированный лог `Telegram turn обработан` и измерьте
    служебную задержку до `letta_turn_ms` на тёплом cache.

Docker, сетевые сертификаты, реальный LLM turn, Telegram и восстановление на
другом сервере зависят от VPS и не должны объявляться проверенными без
фактического выполнения.
