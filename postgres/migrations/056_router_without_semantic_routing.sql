BEGIN;

-- LLM Router перестаёт быть вторым когнитивным контуром.
--
-- Роутер разбирал текст сообщения регулярными выражениями («увольн»,
-- «развод», «отношени», «снова»), складывал баллы и по ним выбирал
-- модель fast/chat/deep, а неоднозначные случаи отправлял на отдельный
-- LLM-вызов. То есть он решал за Letta, насколько глубоко думать над
-- сообщением. Настройки этого механизма больше не нужны: маршрут
-- выбирается детерминированно — режим одной модели, явно запрошенная
-- операция, изображение, строгий JSON, назначение conversation и явный
-- выбор человека между экономией и качеством.
--
-- Forward-миграция работает со старым кодом: старый код читает эти
-- колонки, поэтому они не удаляются, а фиксируются в значении
-- «классификация выключена». Так откат не остаётся без данных, а
-- прежняя сборка, если её вернут, ведёт себя предсказуемо.
UPDATE llm_routing_settings
   SET auto_routing_enabled = false,
       llm_classifier_enabled = false
 WHERE auto_routing_enabled OR llm_classifier_enabled;

ALTER TABLE llm_routing_settings
  ALTER COLUMN auto_routing_enabled SET DEFAULT false,
  ALTER COLUMN llm_classifier_enabled SET DEFAULT false;

-- Маршрут «классификатор» существовал ради этого самого LLM-вызова.
-- Продуктовые операции со строгим JSON — планирование исследования и
-- разбор фактов — переходят на маршрут `json`. Цепочка провайдеров
-- переносится, чтобы установка, где её настраивали руками, не осталась
-- без модели.
INSERT INTO llm_route_providers (route_code, provider_id, position)
SELECT 'json', source.provider_id, source.position
  FROM llm_route_providers source
 WHERE source.route_code = 'classifier'
   AND NOT EXISTS (SELECT 1 FROM llm_route_providers WHERE route_code = 'json')
ON CONFLICT (route_code, provider_id) DO NOTHING;

DELETE FROM llm_route_providers WHERE route_code = 'classifier';
DELETE FROM llm_routes WHERE code = 'classifier';

-- Маршрут «безопасность» выбирался тем же разбором: роутер смотрел на
-- уровень кризиса в сообщении и переключал модель. Кризисный монитор
-- остаётся детерминированным и приоритетным — он по-прежнему добавляет
-- директиву безопасности в ход, — но выбор модели по смыслу сообщения
-- за роутером не остаётся. Без кода маршрут стал бы конфигурацией,
-- которая ничего не делает, и админ настраивал бы её вслепую.
-- Цепочка провайдеров уходит каскадом по внешнему ключу.
DELETE FROM llm_routes WHERE code = 'safety';

-- Описание маршрута инструментов называло NocoDB и Todoist. Первый стал
-- необязательным ручным интерфейсом, второго в проекте нет вовсе, а
-- текст этот админ читает в панели, выбирая провайдера.
UPDATE llm_routes
   SET description = 'Вызов продуктовых инструментов: задачи, заметки, поиск, память. Без tool calling запрещён.'
 WHERE code = 'tools'
   AND description LIKE '%NocoDB%';

INSERT INTO schema_migrations (version) VALUES ('056_router_without_semantic_routing')
ON CONFLICT (version) DO NOTHING;

COMMIT;
