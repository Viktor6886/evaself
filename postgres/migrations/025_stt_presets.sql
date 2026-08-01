-- =====================================================================
-- Преднастроенные STT-провайдеры.
--
-- Миграция 024 завела реестр, но пустой: чтобы начать пользоваться,
-- администратор должен был создать конфигурацию с нуля — выбрать
-- провайдера, вписать адрес, выбрать модель, разобраться в параметрах.
-- Для трёх провайдеров, которыми пользуются в девяти случаях из десяти,
-- всё это известно заранее и вводить руками нечего, кроме ключа.
--
-- Поэтому три конфигурации создаются здесь, в состоянии draft и без
-- ключа. В панели они видны сразу; работать начинают, когда в них
-- впишут ключ и активируют.
--
-- Google AI Studio, а не Google Cloud Speech-to-Text: ключ выдаётся за
-- минуту на ai.google.dev, без облачного проекта, биллинга и IAM.
-- Cloud STT остаётся доступным, но заводится вручную — там service
-- account JSON и региональные распознаватели.
--
-- Миграция идемпотентна и ничего не перезаписывает: ON CONFLICT DO
-- NOTHING по имени. Если администратор уже завёл свою конфигурацию с
-- таким названием или переименовал пресет, его правки останутся.
-- =====================================================================

BEGIN;

-- Провайдер google_ai_studio раньше не существовал.
ALTER TABLE stt_provider_configs DROP CONSTRAINT IF EXISTS stt_configs_provider_check;
ALTER TABLE stt_provider_configs ADD CONSTRAINT stt_configs_provider_check
    CHECK (provider IN ('deepgram', 'openai', 'google', 'google_ai_studio', 'openrouter'));

-- ---------------------------------------------------------------------
-- Пресеты
-- ---------------------------------------------------------------------
-- Адреса, модели и параметры сверены с документацией провайдеров
-- 01.08.2026 — те же значения, что в схемах media-service. Модель
-- каждого пресета — рекомендуемая на эту дату; администратор меняет её
-- в редакторе, ручной ввод разрешён.
INSERT INTO stt_provider_configs (name, provider, mode, base_url, model, public_config, status)
VALUES
    (
        'Deepgram',
        'deepgram',
        'batch',
        'https://api.deepgram.com/v1/listen',
        'nova-3',
        -- smart_format приводит даты, числа и телефоны к читаемому виду;
        -- для голосовых сообщений это заметно лучше сырого потока слов.
        '{"language": "ru", "punctuate": true, "smart_format": true}'::jsonb,
        'draft'
    ),
    (
        'Google AI Studio',
        'google_ai_studio',
        'batch',
        'https://generativelanguage.googleapis.com',
        'gemini-2.5-flash',
        '{"language": "ru"}'::jsonb,
        'draft'
    ),
    (
        'OpenAI',
        'openai',
        'batch',
        'https://api.openai.com/v1',
        'gpt-4o-transcribe',
        '{"language": "ru", "response_format": "json"}'::jsonb,
        'draft'
    )
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('025_stt_presets')
ON CONFLICT (version) DO NOTHING;

COMMIT;
