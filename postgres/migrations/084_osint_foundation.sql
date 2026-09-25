BEGIN;

-- OSINT: исследование открытых источников.
--
-- Отдельные таблицы, а не research_*: разбор темы хранит отчёт, источники и
-- цитаты одного прогона, а OSINT — граф сущностей, идентификаторов и связей,
-- который растёт между итерациями и переиспользуется в следующих исследованиях
-- того же пользователя. Сложить граф в research_reports.report_json значило бы
-- потерять и дедупликацию, и происхождение каждого свойства.
--
-- Все строки принадлежат пользователю: user_id NOT NULL в каждой таблице, и
-- каждая ссылка между таблицами идёт по паре (id, user_id). Строка одного
-- пользователя физически не может сослаться на сущность или источник другого.
-- Доказательство, утверждение и связь, кроме того, привязаны к исследованию
-- своего источника тройкой (id, investigation_id, user_id): доказательство
-- исследования B не может стоять на источнике исследования A, иначе удаление A
-- унесло бы чужие для него строки и спутало происхождение.
--
-- Эти данные — о третьих лицах, а не память Евы. В memory blocks Letta они не
-- попадают, и Evaself их туда не пишет.

CREATE TABLE IF NOT EXISTS osint_investigations (
    id              uuid        PRIMARY KEY,
    user_id         bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    conversation_id text,
    query           text        NOT NULL CHECK (length(query) BETWEEN 1 AND 4000),
    -- Заявленная цель: без неё исследование не создаётся, и она остаётся
    -- в записи — ответ на вопрос «зачем это искали».
    purpose         text        NOT NULL CHECK (length(purpose) BETWEEN 3 AND 1000),
    mode            text        NOT NULL DEFAULT 'standard' CHECK (mode IN ('standard', 'deep')),
    status          text        NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
    budget          jsonb       NOT NULL,
    idempotency_key text        NOT NULL,
    error_code      text,
    started_at      timestamptz,
    completed_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, user_id),
    UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS osint_investigations_user_idx ON osint_investigations (user_id, created_at DESC);

-- Сущность живёт на уровне пользователя, а не исследования: один и тот же
-- человек, найденный в двух исследованиях, — одна строка. Какие исследования
-- её используют — в osint_investigation_entities.
CREATE TABLE IF NOT EXISTS osint_entities (
    id          uuid        PRIMARY KEY,
    user_id     bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Схема FollowTheMoney либо расширение eva: для инфраструктуры.
    schema      text        NOT NULL CHECK (schema IN (
                    'Person', 'Organization', 'Company', 'LegalEntity', 'PublicBody',
                    'UserAccount', 'Address', 'Document',
                    'eva:Website', 'eva:Domain', 'eva:IPAddress', 'eva:Network')),
    caption     text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, user_id)
);
CREATE INDEX IF NOT EXISTS osint_entities_user_idx ON osint_entities (user_id, schema);

CREATE TABLE IF NOT EXISTS osint_investigation_entities (
    investigation_id uuid   NOT NULL,
    entity_id        uuid   NOT NULL,
    user_id          bigint NOT NULL,
    PRIMARY KEY (investigation_id, entity_id),
    FOREIGN KEY (investigation_id, user_id) REFERENCES osint_investigations (id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (entity_id, user_id) REFERENCES osint_entities (id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS osint_investigation_entities_entity_idx ON osint_investigation_entities (entity_id);

CREATE TABLE IF NOT EXISTS osint_identifiers (
    id               uuid        PRIMARY KEY,
    user_id          bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    type             text        NOT NULL CHECK (type IN (
                         'name', 'username', 'email', 'phone', 'url', 'domain', 'ip', 'cidr',
                         'asn', 'organization', 'tax_id', 'registration_number',
                         'social_account', 'document')),
    raw_value        text        NOT NULL,
    normalized_value text        NOT NULL,
    first_seen       timestamptz NOT NULL DEFAULT now(),
    last_seen        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, user_id),
    UNIQUE (user_id, type, normalized_value)
);

CREATE TABLE IF NOT EXISTS osint_sources (
    id               uuid        PRIMARY KEY,
    user_id          bigint      NOT NULL,
    investigation_id uuid        NOT NULL,
    -- Адрес страницы или локатор API-ответа (`rdap:ripe.net/ip/…`).
    locator          text        NOT NULL,
    canonical_url    text,
    domain           text        NOT NULL,
    collector        text        NOT NULL,
    tier             text        NOT NULL CHECK (tier IN (
                         'official_registry', 'official_government', 'official_organization',
                         'official_profile', 'primary_document', 'authoritative_media',
                         'public_repository', 'professional_directory', 'archive', 'forum',
                         'aggregator', 'unknown')),
    quality          real        NOT NULL CHECK (quality BETWEEN 0 AND 1),
    retrieved_at     timestamptz NOT NULL,
    content_hash     text,
    -- Сырой ответ хранится отдельно и удаляется по сроку; отпечаток и
    -- доказательства остаются.
    raw_snapshot_ref text,
    raw_expires_at   timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, user_id),
    UNIQUE (id, investigation_id, user_id),
    UNIQUE (investigation_id, collector, locator),
    FOREIGN KEY (investigation_id, user_id) REFERENCES osint_investigations (id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS osint_sources_raw_expiry_idx ON osint_sources (raw_expires_at)
    WHERE raw_snapshot_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS osint_evidence (
    id               uuid        PRIMARY KEY,
    user_id          bigint      NOT NULL,
    investigation_id uuid        NOT NULL,
    source_id        uuid        NOT NULL,
    kind             text        NOT NULL CHECK (kind IN ('quote', 'structured')),
    quote            text,
    structured       jsonb,
    evidence_hash    text        NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CHECK ((kind = 'quote' AND quote IS NOT NULL) OR (kind = 'structured' AND structured IS NOT NULL)),
    UNIQUE (id, user_id),
    UNIQUE (id, investigation_id, user_id),
    UNIQUE (source_id, evidence_hash),
    FOREIGN KEY (investigation_id, user_id) REFERENCES osint_investigations (id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (source_id, investigation_id, user_id)
        REFERENCES osint_sources (id, investigation_id, user_id) ON DELETE CASCADE
);

-- Идентификатор, найденный у сущности, — со своим источником и уверенностью:
-- принадлежность адреса человеку сама требует доказательства.
CREATE TABLE IF NOT EXISTS osint_entity_identifiers (
    entity_id     uuid        NOT NULL,
    identifier_id uuid        NOT NULL,
    user_id       bigint      NOT NULL,
    evidence_id   uuid        NOT NULL,
    collector     text        NOT NULL,
    confidence    real        NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    first_seen    timestamptz NOT NULL DEFAULT now(),
    last_seen     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (entity_id, identifier_id, evidence_id),
    FOREIGN KEY (entity_id, user_id) REFERENCES osint_entities (id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (identifier_id, user_id) REFERENCES osint_identifiers (id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (evidence_id, user_id) REFERENCES osint_evidence (id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS osint_entity_identifiers_identifier_idx ON osint_entity_identifiers (identifier_id);

CREATE TABLE IF NOT EXISTS osint_claims (
    id                  uuid        PRIMARY KEY,
    user_id             bigint      NOT NULL,
    investigation_id    uuid        NOT NULL,
    entity_id           uuid        NOT NULL,
    -- Имя свойства FollowTheMoney: birthDate, innCode, email.
    property            text        NOT NULL,
    value               text        NOT NULL,
    evidence_id         uuid        NOT NULL,
    collector           text        NOT NULL,
    confidence          real        NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    status              text        NOT NULL CHECK (status IN (
                            'confirmed', 'probable', 'unverified', 'contradicted', 'rejected')),
    contradiction_group uuid,
    retrieved_at        timestamptz NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, user_id),
    UNIQUE (entity_id, property, value, evidence_id),
    FOREIGN KEY (investigation_id, user_id) REFERENCES osint_investigations (id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (entity_id, user_id) REFERENCES osint_entities (id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (evidence_id, investigation_id, user_id)
        REFERENCES osint_evidence (id, investigation_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS osint_claims_entity_idx ON osint_claims (entity_id, property);
CREATE INDEX IF NOT EXISTS osint_claims_investigation_idx ON osint_claims (investigation_id);

CREATE TABLE IF NOT EXISTS osint_relationships (
    id               uuid        PRIMARY KEY,
    user_id          bigint      NOT NULL,
    investigation_id uuid        NOT NULL,
    -- Интервальная схема FollowTheMoney.
    schema           text        NOT NULL CHECK (schema IN (
                         'Ownership', 'Directorship', 'Membership', 'Employment', 'Family',
                         'Associate', 'Representation', 'UnknownLink')),
    source_entity_id uuid        NOT NULL,
    target_entity_id uuid        NOT NULL,
    evidence_id      uuid        NOT NULL,
    confidence       real        NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    status           text        NOT NULL CHECK (status IN (
                         'confirmed', 'probable', 'unverified', 'contradicted', 'rejected')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    CHECK (source_entity_id <> target_entity_id),
    UNIQUE (id, user_id),
    UNIQUE (schema, source_entity_id, target_entity_id, evidence_id),
    FOREIGN KEY (investigation_id, user_id) REFERENCES osint_investigations (id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (source_entity_id, user_id) REFERENCES osint_entities (id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (target_entity_id, user_id) REFERENCES osint_entities (id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (evidence_id, investigation_id, user_id)
        REFERENCES osint_evidence (id, investigation_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS osint_relationships_source_idx ON osint_relationships (source_entity_id);
CREATE INDEX IF NOT EXISTS osint_relationships_target_idx ON osint_relationships (target_entity_id);

-- Решение «две записи — одна сущность»: статус, счёт и признаки, по которым
-- оно вынесено. Признаки — имена и ссылки на доказательства, без значений.
CREATE TABLE IF NOT EXISTS osint_entity_matches (
    id               uuid        PRIMARY KEY,
    user_id          bigint      NOT NULL,
    investigation_id uuid        NOT NULL,
    left_entity_id   uuid        NOT NULL,
    right_entity_id  uuid        NOT NULL,
    status           text        NOT NULL CHECK (status IN (
                         'confirmed', 'probable', 'possible', 'conflicting', 'rejected')),
    score            real        NOT NULL CHECK (score BETWEEN 0 AND 1),
    features         jsonb       NOT NULL,
    decided_by       text        NOT NULL CHECK (decided_by IN ('rule', 'user')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    CHECK (left_entity_id < right_entity_id),
    UNIQUE (left_entity_id, right_entity_id),
    FOREIGN KEY (investigation_id, user_id) REFERENCES osint_investigations (id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (left_entity_id, user_id) REFERENCES osint_entities (id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (right_entity_id, user_id) REFERENCES osint_entities (id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS osint_collector_runs (
    id                   uuid        PRIMARY KEY,
    user_id              bigint      NOT NULL,
    investigation_id     uuid        NOT NULL,
    collector            text        NOT NULL,
    target_identifier_id uuid,
    status               text        NOT NULL CHECK (status IN (
                             'queued', 'running', 'succeeded', 'degraded', 'failed', 'skipped', 'cancelled')),
    degraded_reason      text        CHECK (degraded_reason IN (
                             'rate_limited', 'captcha', 'timeout', 'unavailable', 'disabled')),
    external_requests    integer     NOT NULL DEFAULT 0 CHECK (external_requests >= 0),
    error_code           text,
    started_at           timestamptz,
    finished_at          timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, user_id),
    UNIQUE (id, investigation_id, user_id),
    FOREIGN KEY (investigation_id, user_id) REFERENCES osint_investigations (id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (target_identifier_id, user_id) REFERENCES osint_identifiers (id, user_id) ON DELETE CASCADE
);
-- Повтор воркера после сбоя не запускает тот же сборщик по той же цели второй раз.
CREATE UNIQUE INDEX IF NOT EXISTS osint_collector_runs_target_uidx
    ON osint_collector_runs (investigation_id, collector, target_identifier_id)
    WHERE target_identifier_id IS NOT NULL;

-- Очередь итеративного расширения: каждый идентификатор попадает в неё
-- один раз за исследование, с глубиной, на которой найден.
CREATE TABLE IF NOT EXISTS osint_frontier (
    investigation_id  uuid        NOT NULL,
    identifier_id     uuid        NOT NULL,
    user_id           bigint      NOT NULL,
    depth             integer     NOT NULL CHECK (depth >= 0),
    status            text        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'done', 'skipped')),
    discovered_by_run uuid,
    created_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (investigation_id, identifier_id),
    FOREIGN KEY (investigation_id, user_id) REFERENCES osint_investigations (id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (identifier_id, user_id) REFERENCES osint_identifiers (id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (discovered_by_run, investigation_id, user_id)
        REFERENCES osint_collector_runs (id, investigation_id, user_id) ON DELETE SET NULL (discovered_by_run)
);
CREATE INDEX IF NOT EXISTS osint_frontier_pending_idx ON osint_frontier (investigation_id, depth)
    WHERE status = 'pending';

COMMENT ON TABLE osint_investigations IS
    'OSINT-исследование открытых источников; данные третьих лиц, не память агента.';
COMMENT ON TABLE osint_claims IS
    'Утверждение о свойстве сущности: всегда с доказательством, источником и сборщиком.';

INSERT INTO schema_migrations (version)
VALUES ('084_osint_foundation')
ON CONFLICT DO NOTHING;

COMMIT;
