-- =====================================================================
-- Несколько ключей на одного провайдера.
--
-- До этой миграции у конфигурации был ровно один ключ. Кончился лимит —
-- распознавание встало, и починить это мог только человек, вручную
-- заменив ключ в панели. У бесплатных тарифов Deepgram и Google AI
-- Studio лимиты суточные, то есть встать оно может ежедневно.
--
-- Теперь ключей может быть сколько угодно, и перебор между ними —
-- внутреннее дело одного запроса: пользователь ничего не замечает.
--
-- Это НЕ то же самое, что резервный провайдер из 024, и путать их
-- нельзя ни в коде, ни в статистике:
--
--   смена ключа   — тот же провайдер, та же модель, та же цена.
--                   Происходит внутри одной попытки и не считается
--                   fallback'ом.
--   резерв (024)  — другой провайдер, другая модель, другая цена.
--                   Не более одного раза на аудио.
--
-- Ключ конфигурации (stt_provider_configs.secret_ref) сохраняется как
-- первый в списке: он остаётся рабочим для установок, где новую
-- таблицу ещё не заполнили, и позволяет откатить миграцию без потери
-- доступа.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS stt_provider_keys (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    config_id      uuid        NOT NULL REFERENCES stt_provider_configs (id) ON DELETE CASCADE,

    -- Как ключ называется в панели. Не секрет — его видно в списке.
    label          text        NOT NULL,

    -- Само значение живёт только в Secret Store, здесь ссылка.
    secret_ref     text        NOT NULL REFERENCES secret_records (secret_ref) ON DELETE RESTRICT,

    -- Порядок перебора. Меньше — раньше.
    position       integer     NOT NULL DEFAULT 100,

    -- Выключенный ключ пропускается, но остаётся в списке: временно
    -- убрать ключ и удалить его насовсем — разные намерения.
    enabled        boolean     NOT NULL DEFAULT true,

    -- active     — можно пробовать;
    -- exhausted  — упёрся в лимит, вернётся сам после cooldown_until;
    -- invalid    — отвергнут провайдером, нужен человек.
    status         text        NOT NULL DEFAULT 'active',

    -- До какого момента ключ считается исчерпанным. Суточные лимиты
    -- сбрасываются сами, и держать ключ выключенным навсегда из-за
    -- одного 429 было бы неверно.
    cooldown_until timestamptz NULL,

    last_used_at   timestamptz NULL,
    last_error_at  timestamptz NULL,
    last_error_code text       NULL,

    -- Счётчики для панели: по ним видно, какой ключ несёт нагрузку, а
    -- какой лежит мёртвым грузом.
    success_count  bigint      NOT NULL DEFAULT 0,
    failure_count  bigint      NOT NULL DEFAULT 0,

    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     uuid        NULL REFERENCES admin_users (id) ON DELETE SET NULL,

    CONSTRAINT stt_keys_status_check
        CHECK (status IN ('active', 'exhausted', 'invalid')),
    CONSTRAINT stt_keys_label_check
        CHECK (length(btrim(label)) BETWEEN 1 AND 80),
    CONSTRAINT stt_keys_position_check
        CHECK (position BETWEEN 0 AND 10000)
);

-- Один и тот же секрет не должен оказаться в списке дважды: перебор
-- сделал бы два одинаковых запроса и получил бы два одинаковых отказа.
CREATE UNIQUE INDEX IF NOT EXISTS stt_keys_secret_uidx
    ON stt_provider_keys (config_id, secret_ref);

CREATE UNIQUE INDEX IF NOT EXISTS stt_keys_label_uidx
    ON stt_provider_keys (config_id, lower(btrim(label)));

CREATE INDEX IF NOT EXISTS stt_keys_order_idx
    ON stt_provider_keys (config_id, position, created_at);

-- ---------------------------------------------------------------------
-- Перенос уже настроенных ключей
-- ---------------------------------------------------------------------
-- Ключ, заданный до этой миграции, становится первым в списке. Иначе
-- обновление работающей установки выключило бы распознавание до тех
-- пор, пока администратор не зайдёт в панель.
INSERT INTO stt_provider_keys (config_id, label, secret_ref, position)
SELECT id, 'Основной', secret_ref, 0
  FROM stt_provider_configs
 WHERE secret_ref IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('026_stt_provider_keys')
ON CONFLICT (version) DO NOTHING;

COMMIT;
