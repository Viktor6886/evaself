-- =====================================================================
-- Граница арендатора в схеме OSINT — на настоящем PostgreSQL.
--
-- Каждая ссылка между таблицами OSINT идёт по паре (id, user_id), и это
-- главное, что проверяется здесь: утверждение одного пользователя не
-- может сослаться на сущность, источник или доказательство другого, даже
-- если вызывающий знает чужой UUID. Поддельная база в тестах TypeScript
-- внешних ключей не проверяет — только живая.
--
-- Заодно проверяется каскад: удаление исследования уносит его источники,
-- доказательства и утверждения, но не сущности — они принадлежат
-- пользователю и могут использоваться другими его исследованиями.
--
-- Скрипт ничего не оставляет после себя.
-- =====================================================================

BEGIN;

DO $$
DECLARE
    alice      bigint;
    bob        bigint;
    inv_alice  uuid := gen_random_uuid();
    inv_bob    uuid := gen_random_uuid();
    ent_alice  uuid := gen_random_uuid();
    ent_bob    uuid := gen_random_uuid();
    src_alice  uuid := gen_random_uuid();
    ev_alice   uuid := gen_random_uuid();
    ev_bob     uuid := gen_random_uuid();
    src_bob    uuid := gen_random_uuid();
    rejected   boolean;
BEGIN
    INSERT INTO users (telegram_id, first_name) VALUES (-910001, 'osint-ci-a') RETURNING id INTO alice;
    INSERT INTO users (telegram_id, first_name) VALUES (-910002, 'osint-ci-b') RETURNING id INTO bob;

    INSERT INTO osint_investigations (id, user_id, query, purpose, budget, idempotency_key)
    VALUES (inv_alice, alice, 'q', 'проверка контрагента', '{}'::jsonb, 'a-1'),
           (inv_bob, bob, 'q', 'проверка контрагента', '{}'::jsonb, 'b-1');
    INSERT INTO osint_entities (id, user_id, schema, caption)
    VALUES (ent_alice, alice, 'Person', 'A'), (ent_bob, bob, 'Person', 'B');
    INSERT INTO osint_investigation_entities (investigation_id, entity_id, user_id)
    VALUES (inv_alice, ent_alice, alice);
    INSERT INTO osint_sources (id, user_id, investigation_id, locator, domain, collector, tier, quality, retrieved_at)
    VALUES (src_alice, alice, inv_alice, 'https://example.com/a', 'example.com', 'web', 'unknown', 0.2, now()),
           (src_bob, bob, inv_bob, 'https://example.com/b', 'example.com', 'web', 'unknown', 0.2, now());
    INSERT INTO osint_evidence (id, user_id, investigation_id, source_id, kind, quote, evidence_hash)
    VALUES (ev_alice, alice, inv_alice, src_alice, 'quote', 'цитата', 'h1'),
           (ev_bob, bob, inv_bob, src_bob, 'quote', 'цитата', 'h2');

    -- Своё утверждение принимается.
    INSERT INTO osint_claims (id, user_id, investigation_id, entity_id, property, value, evidence_id,
                              collector, confidence, status, retrieved_at)
    VALUES (gen_random_uuid(), alice, inv_alice, ent_alice, 'birthDate', '1990', ev_alice,
            'web', 0.2, 'unverified', now());

    -- Чужая сущность под своим user_id — отказ внешнего ключа.
    rejected := false;
    BEGIN
        INSERT INTO osint_claims (id, user_id, investigation_id, entity_id, property, value, evidence_id,
                                  collector, confidence, status, retrieved_at)
        VALUES (gen_random_uuid(), alice, inv_alice, ent_bob, 'birthDate', '1990', ev_alice,
                'web', 0.2, 'unverified', now());
    EXCEPTION WHEN foreign_key_violation THEN rejected := true;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'утверждение сослалось на чужую сущность'; END IF;

    -- Чужое доказательство — тоже отказ.
    rejected := false;
    BEGIN
        INSERT INTO osint_claims (id, user_id, investigation_id, entity_id, property, value, evidence_id,
                                  collector, confidence, status, retrieved_at)
        VALUES (gen_random_uuid(), alice, inv_alice, ent_alice, 'gender', 'male', ev_bob,
                'web', 0.2, 'unverified', now());
    EXCEPTION WHEN foreign_key_violation THEN rejected := true;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'утверждение сослалось на чужое доказательство'; END IF;

    -- Привязать чужую сущность к своему исследованию нельзя.
    rejected := false;
    BEGIN
        INSERT INTO osint_investigation_entities (investigation_id, entity_id, user_id)
        VALUES (inv_alice, ent_bob, alice);
    EXCEPTION WHEN foreign_key_violation THEN rejected := true;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'исследование получило чужую сущность'; END IF;

    -- Повтор создания с тем же ключом идемпотентности не заводит второе исследование.
    rejected := false;
    BEGIN
        INSERT INTO osint_investigations (id, user_id, query, purpose, budget, idempotency_key)
        VALUES (gen_random_uuid(), alice, 'q', 'проверка контрагента', '{}'::jsonb, 'a-1');
    EXCEPTION WHEN unique_violation THEN rejected := true;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'повтор создал второе исследование'; END IF;

    -- Без заявленной цели исследование не создаётся.
    rejected := false;
    BEGIN
        INSERT INTO osint_investigations (id, user_id, query, purpose, budget, idempotency_key)
        VALUES (gen_random_uuid(), alice, 'q', '', '{}'::jsonb, 'a-2');
    EXCEPTION WHEN check_violation THEN rejected := true;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'исследование создано без цели'; END IF;

    -- Удаление исследования уносит его доказательства и утверждения,
    -- но не сущность пользователя и не чужие данные.
    DELETE FROM osint_investigations WHERE id = inv_alice;
    IF EXISTS (SELECT 1 FROM osint_claims WHERE investigation_id = inv_alice)
       OR EXISTS (SELECT 1 FROM osint_evidence WHERE investigation_id = inv_alice)
       OR EXISTS (SELECT 1 FROM osint_sources WHERE investigation_id = inv_alice) THEN
        RAISE EXCEPTION 'удалённое исследование оставило доказательства';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM osint_entities WHERE id = ent_alice) THEN
        RAISE EXCEPTION 'сущность пользователя удалилась вместе с исследованием';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM osint_evidence WHERE id = ev_bob) THEN
        RAISE EXCEPTION 'удаление задело данные другого пользователя';
    END IF;

    -- Удаление пользователя уносит всё его OSINT.
    DELETE FROM users WHERE id = bob;
    IF EXISTS (SELECT 1 FROM osint_evidence WHERE user_id = bob)
       OR EXISTS (SELECT 1 FROM osint_entities WHERE user_id = bob) THEN
        RAISE EXCEPTION 'удалённый пользователь оставил OSINT-данные';
    END IF;
END $$;

-- Ничего не оставляем: проба существует только внутри этой транзакции.
ROLLBACK;
