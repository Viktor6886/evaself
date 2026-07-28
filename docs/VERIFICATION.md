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
10. создание двух LLM-конфигураций на изолированном mock endpoint;
11. проверку `/models`, последовательную активацию двух моделей и отсутствие
    API Key в ответах;
12. сравнение `agent_id`/`conversation_id` до и после переключения;
13. перезапуск App Server и `eva-agent-service`, затем повторную проверку
    настроек и идентификаторов.

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

1. отправьте сообщение через Telegram E2E workflow;
2. запомните agent/conversation и добавьте в память проверочный факт;
3. добавьте второй реальный LLM и активируйте его;
4. убедитесь, что ответ использует новую модель, а факт из памяти доступен;
5. перезапустите App Server и `eva-agent-service`;
6. убедитесь, что ID, память и активная LLM-конфигурация сохранились;
7. выполните backup и restore на тестовом VPS;
8. проверьте, что WebUI нигде не показывает API Key.

Docker, сетевые сертификаты, реальный LLM turn, Telegram и восстановление на
другом сервере зависят от VPS и не должны объявляться проверенными без
фактического выполнения.
