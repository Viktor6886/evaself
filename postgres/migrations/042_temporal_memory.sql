-- =====================================================================
-- Шаг 15. Temporal-память: версии, evidence и разрешение сущностей.
--
-- Расширяет существующие memory_nodes и memory_edges, а не заменяет их.
-- Почему история живёт в отдельных таблицах версий, а не строками в
-- memory_nodes: на memory_nodes стоит уникальный индекс
-- (user_id, node_type, canonical_key), через который работает upsert
-- всего существующего кода. Хранить версии строками означало бы снять
-- этот индекс и переписать каждый писатель графа — то есть смешать
-- рефакторинг с функциональным изменением. Поэтому memory_nodes
-- остаётся АКТУАЛЬНЫМ СНИМКОМ (ровно одна строка на факт), а
-- memory_node_versions хранит все версии, включая текущую. Снимок и
-- новая версия пишутся одной транзакцией.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Актуальный снимок: временные координаты и ссылка на текущую версию.
-- ---------------------------------------------------------------------

ALTER TABLE memory_nodes
    -- Устойчивая личность факта между версиями. Заполняется переносом;
    -- NULL означает «узел ещё не переведён на temporal-путь».
    ADD COLUMN IF NOT EXISTS fact_key           text,
    ADD COLUMN IF NOT EXISTS version            integer NOT NULL DEFAULT 1,
    -- Когда Ева узнала о факте. Отличается от valid_from: человек может
    -- сегодня рассказать о том, что случилось три года назад.
    ADD COLUMN IF NOT EXISTS observed_at        timestamptz,
    -- Когда событие произошло в жизни пользователя.
    ADD COLUMN IF NOT EXISTS event_at           timestamptz,
    -- Сущность, к которой узел отнесён разрешением сущностей.
    ADD COLUMN IF NOT EXISTS entity_id          bigint,
    ADD COLUMN IF NOT EXISTS current_version_id bigint;

-- Прежний набор статусов сохраняется целиком: forward-миграция обязана
-- работать со старым кодом, который пишет 'unconfirmed' и 'archived'.
-- Новые статусы шага 15 добавляются к нему, а не вместо него.
ALTER TABLE memory_nodes DROP CONSTRAINT IF EXISTS memory_nodes_status_check;
ALTER TABLE memory_nodes ADD CONSTRAINT memory_nodes_status_check CHECK (status IN (
    'active', 'unconfirmed', 'disputed', 'superseded', 'archived',
    'candidate', 'refuted', 'rejected', 'forgotten', 'deleted', 'quarantined'
));

CREATE INDEX IF NOT EXISTS memory_nodes_fact_key_idx
    ON memory_nodes (user_id, fact_key) WHERE fact_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_nodes_entity_idx
    ON memory_nodes (user_id, entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_nodes_valid_idx
    ON memory_nodes (user_id, valid_from, valid_to);

ALTER TABLE memory_edges
    ADD COLUMN IF NOT EXISTS version            integer NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS valid_from         timestamptz,
    ADD COLUMN IF NOT EXISTS valid_to           timestamptz,
    ADD COLUMN IF NOT EXISTS observed_at        timestamptz,
    ADD COLUMN IF NOT EXISTS event_at           timestamptz,
    ADD COLUMN IF NOT EXISTS current_version_id bigint;

ALTER TABLE memory_edges DROP CONSTRAINT IF EXISTS memory_edges_status_check;
ALTER TABLE memory_edges ADD CONSTRAINT memory_edges_status_check CHECK (status IN (
    'active', 'disputed', 'archived',
    'candidate', 'superseded', 'refuted', 'rejected', 'forgotten', 'deleted', 'quarantined'
));

CREATE INDEX IF NOT EXISTS memory_edges_valid_idx
    ON memory_edges (user_id, valid_from, valid_to);

-- ---------------------------------------------------------------------
-- Версии узлов. Прежняя версия не изменяется и не удаляется: у неё
-- проставляется valid_to, новая ссылается на неё через supersedes.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memory_node_versions (
    id                    bigserial PRIMARY KEY,
    user_id               bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    node_id               bigint NOT NULL,
    fact_key              text NOT NULL,
    version               integer NOT NULL,
    supersedes_version_id bigint REFERENCES memory_node_versions (id) ON DELETE SET NULL,
    title                 text NOT NULL,
    text_content          text,
    content_json          jsonb NOT NULL DEFAULT '{}'::jsonb,
    status                text NOT NULL,
    confidence            numeric(4,3) NOT NULL,
    sensitivity           text NOT NULL DEFAULT 'normal',
    -- Время действительности факта в жизни пользователя.
    valid_from            timestamptz NOT NULL,
    valid_to              timestamptz,
    -- Дата события и дата сообщения — разные величины, обе фиксируются.
    event_at              timestamptz,
    observed_at           timestamptz NOT NULL DEFAULT now(),
    recorded_at           timestamptz NOT NULL DEFAULT now(),
    change_reason         text NOT NULL,
    actor_type            text NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memory_node_versions_node_fk
        FOREIGN KEY (user_id, node_id)
        REFERENCES memory_nodes (user_id, id) ON DELETE CASCADE,
    CONSTRAINT memory_node_versions_status_check CHECK (status IN (
        'candidate', 'active', 'superseded', 'refuted',
        'rejected', 'forgotten', 'deleted', 'quarantined'
    )),
    CONSTRAINT memory_node_versions_actor_check
        CHECK (actor_type IN ('user', 'curator', 'system', 'admin')),
    CONSTRAINT memory_node_versions_confidence_check
        CHECK (confidence >= 0 AND confidence <= 1),
    CONSTRAINT memory_node_versions_interval_check
        CHECK (valid_to IS NULL OR valid_to >= valid_from),
    CONSTRAINT memory_node_versions_version_check CHECK (version >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_node_versions_node_version_uidx
    ON memory_node_versions (user_id, node_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS memory_node_versions_user_id_uidx
    ON memory_node_versions (user_id, id);
CREATE INDEX IF NOT EXISTS memory_node_versions_asof_idx
    ON memory_node_versions (user_id, node_id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS memory_node_versions_fact_idx
    ON memory_node_versions (user_id, fact_key, version);
CREATE INDEX IF NOT EXISTS memory_node_versions_changes_idx
    ON memory_node_versions (user_id, recorded_at);

CREATE TABLE IF NOT EXISTS memory_edge_versions (
    id                    bigserial PRIMARY KEY,
    user_id               bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    edge_id               bigint NOT NULL REFERENCES memory_edges (id) ON DELETE CASCADE,
    version               integer NOT NULL,
    supersedes_version_id bigint REFERENCES memory_edge_versions (id) ON DELETE SET NULL,
    from_node_id          bigint NOT NULL,
    relation_type         text NOT NULL,
    to_node_id            bigint NOT NULL,
    weight                numeric(8,4) NOT NULL DEFAULT 1,
    confidence            numeric(4,3) NOT NULL,
    status                text NOT NULL,
    valid_from            timestamptz NOT NULL,
    valid_to              timestamptz,
    event_at              timestamptz,
    observed_at           timestamptz NOT NULL DEFAULT now(),
    recorded_at           timestamptz NOT NULL DEFAULT now(),
    change_reason         text NOT NULL,
    actor_type            text NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memory_edge_versions_status_check CHECK (status IN (
        'candidate', 'active', 'superseded', 'refuted',
        'rejected', 'forgotten', 'deleted', 'quarantined'
    )),
    CONSTRAINT memory_edge_versions_actor_check
        CHECK (actor_type IN ('user', 'curator', 'system', 'admin')),
    CONSTRAINT memory_edge_versions_confidence_check
        CHECK (confidence >= 0 AND confidence <= 1),
    CONSTRAINT memory_edge_versions_interval_check
        CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_edge_versions_edge_version_uidx
    ON memory_edge_versions (user_id, edge_id, version);
CREATE INDEX IF NOT EXISTS memory_edge_versions_asof_idx
    ON memory_edge_versions (user_id, edge_id, valid_from, valid_to);

-- ---------------------------------------------------------------------
-- Доказательства.
--
-- Уникальный ключ включает хэш содержания: повторное извлечение того же
-- сообщения даёт ту же строку и не добавляет независимого доказательства.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memory_evidence (
    id             bigserial PRIMARY KEY,
    user_id        bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    subject_kind   text NOT NULL,
    node_id        bigint,
    edge_id        bigint REFERENCES memory_edges (id) ON DELETE CASCADE,
    version_id     bigint,
    source_type    text NOT NULL,
    source_id      text,
    message_id     text,
    episode_id     bigint,
    -- Дата сообщения: когда это было сказано.
    source_at      timestamptz,
    -- Дата события: когда это произошло.
    event_at       timestamptz,
    support        text NOT NULL,
    confidence     numeric(4,3) NOT NULL,
    content_hash   text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memory_evidence_subject_check
        CHECK (subject_kind IN ('node', 'edge')),
    CONSTRAINT memory_evidence_target_check CHECK (
        (subject_kind = 'node' AND node_id IS NOT NULL AND edge_id IS NULL)
        OR (subject_kind = 'edge' AND edge_id IS NOT NULL AND node_id IS NULL)
    ),
    CONSTRAINT memory_evidence_support_check
        CHECK (support IN ('supports', 'refutes', 'mentions')),
    CONSTRAINT memory_evidence_confidence_check
        CHECK (confidence >= 0 AND confidence <= 1),
    CONSTRAINT memory_evidence_hash_check
        CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT memory_evidence_node_fk
        FOREIGN KEY (user_id, node_id)
        REFERENCES memory_nodes (user_id, id) ON DELETE CASCADE
);

-- Один и тот же источник по одному и тому же предмету — одна строка.
CREATE UNIQUE INDEX IF NOT EXISTS memory_evidence_node_dedup_uidx
    ON memory_evidence (user_id, node_id, content_hash)
    WHERE subject_kind = 'node';
CREATE UNIQUE INDEX IF NOT EXISTS memory_evidence_edge_dedup_uidx
    ON memory_evidence (user_id, edge_id, content_hash)
    WHERE subject_kind = 'edge';
CREATE INDEX IF NOT EXISTS memory_evidence_version_idx
    ON memory_evidence (user_id, version_id);
CREATE INDEX IF NOT EXISTS memory_evidence_episode_idx
    ON memory_evidence (user_id, episode_id) WHERE episode_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- Разрешение сущностей: синонимы и аудит объединений.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memory_entity_aliases (
    id               bigserial PRIMARY KEY,
    user_id          bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    node_id          bigint NOT NULL,
    node_type        text NOT NULL,
    alias            text NOT NULL,
    normalized_alias text NOT NULL,
    alias_kind       text NOT NULL DEFAULT 'synonym',
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memory_entity_aliases_node_fk
        FOREIGN KEY (user_id, node_id)
        REFERENCES memory_nodes (user_id, id) ON DELETE CASCADE,
    CONSTRAINT memory_entity_aliases_kind_check
        CHECK (alias_kind IN ('primary', 'synonym', 'nickname', 'former'))
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_entity_aliases_uidx
    ON memory_entity_aliases (user_id, node_id, normalized_alias);
CREATE INDEX IF NOT EXISTS memory_entity_aliases_lookup_idx
    ON memory_entity_aliases (user_id, node_type, normalized_alias);

CREATE TABLE IF NOT EXISTS memory_entity_merges (
    id             bigserial PRIMARY KEY,
    user_id        bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    source_node_id bigint NOT NULL,
    target_node_id bigint NOT NULL,
    decision       text NOT NULL,
    score          numeric(4,3) NOT NULL,
    reason         text NOT NULL,
    actor_type     text NOT NULL,
    -- Снимок того, что понадобится откату: прежние entity_id и статус.
    snapshot       jsonb NOT NULL DEFAULT '{}'::jsonb,
    rolled_back_at timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memory_entity_merges_decision_check
        CHECK (decision IN ('merged', 'candidate', 'separate')),
    CONSTRAINT memory_entity_merges_actor_check
        CHECK (actor_type IN ('user', 'curator', 'system', 'admin')),
    CONSTRAINT memory_entity_merges_score_check
        CHECK (score >= 0 AND score <= 1),
    CONSTRAINT memory_entity_merges_not_self_check
        CHECK (source_node_id <> target_node_id)
);

CREATE INDEX IF NOT EXISTS memory_entity_merges_live_idx
    ON memory_entity_merges (user_id, source_node_id)
    WHERE rolled_back_at IS NULL;

-- ---------------------------------------------------------------------
-- Конфликты: противоречие не разрешается автоматически, оно попадает в
-- отчёт и при значимости — на подтверждение пользователю.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memory_conflicts (
    id                bigserial PRIMARY KEY,
    user_id           bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    fact_key          text NOT NULL,
    node_id           bigint NOT NULL,
    refuted_version_id bigint,
    winning_version_id bigint,
    kind              text NOT NULL,
    significance      text NOT NULL DEFAULT 'low',
    status            text NOT NULL DEFAULT 'open',
    detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at        timestamptz NOT NULL DEFAULT now(),
    resolved_at       timestamptz,
    CONSTRAINT memory_conflicts_node_fk
        FOREIGN KEY (user_id, node_id)
        REFERENCES memory_nodes (user_id, id) ON DELETE CASCADE,
    CONSTRAINT memory_conflicts_kind_check
        CHECK (kind IN ('value_changed', 'contradiction', 'overlap', 'duplicate')),
    CONSTRAINT memory_conflicts_significance_check
        CHECK (significance IN ('low', 'medium', 'high')),
    CONSTRAINT memory_conflicts_status_check
        CHECK (status IN ('open', 'awaiting_user', 'resolved', 'dismissed'))
);

CREATE INDEX IF NOT EXISTS memory_conflicts_open_idx
    ON memory_conflicts (user_id, created_at) WHERE status IN ('open', 'awaiting_user');

-- ---------------------------------------------------------------------
-- Перенос накопленных данных. Курсор общий, без user_id: это системная
-- таблица прогресса, а не пользовательская.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memory_backfill_state (
    backfill_key    text PRIMARY KEY,
    last_node_id    bigint NOT NULL DEFAULT 0,
    last_edge_id    bigint NOT NULL DEFAULT 0,
    processed_nodes bigint NOT NULL DEFAULT 0,
    processed_edges bigint NOT NULL DEFAULT 0,
    status          text NOT NULL DEFAULT 'pending',
    started_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz,
    CONSTRAINT memory_backfill_state_status_check
        CHECK (status IN ('pending', 'running', 'completed', 'failed'))
);

INSERT INTO schema_migrations (version) VALUES ('042_temporal_memory')
ON CONFLICT (version) DO NOTHING;

COMMIT;
