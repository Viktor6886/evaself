-- =====================================================================
-- Неизменяемость версии артефакта — на настоящем PostgreSQL.
--
-- Шаг 13 требует, чтобы запрет изменения опубликованной версии был
-- реализован «на уровне схемы, а не соглашением». Соглашение проверяется
-- чтением кода, схема — только запросом: поддельная база в тестах
-- TypeScript выполнит любой UPDATE, который ей напишут, и потому не
-- отличит настоящий запрет от намерения.
--
-- Здесь проверяется сам триггер: что он пропускает правку черновика,
-- отвергает правку содержимого после черновика, не даёт вернуть версию в
-- черновик и не даёт удалить версию, на которую могли сослаться прогоны.
-- Заодно проверяется указатель публикации: один действующий на окружение,
-- откат меняет указатель и не переписывает историю.
--
-- Скрипт ничего не оставляет после себя.
-- =====================================================================

BEGIN;

DO $$
DECLARE
    art_id      bigint;
    v1_id       bigint;
    v2_id       bigint;
    pub_id      bigint;
    history_len int;
    active_ver  bigint;
BEGIN
    INSERT INTO artifacts (kind, slug, title)
    VALUES ('prompt', 'ci.immutability.probe', 'Проба неизменяемости')
    RETURNING id INTO art_id;

    INSERT INTO artifact_versions (artifact_id, version, body, checksum, status)
    VALUES (art_id, 1, '{"text":"v1"}'::jsonb, repeat('a', 32), 'draft')
    RETURNING id INTO v1_id;

    -- Черновик правится: пока версия не вышла из черновика, на неё никто
    -- не мог сослаться.
    UPDATE artifact_versions SET body = '{"text":"v1-edited"}'::jsonb WHERE id = v1_id;

    UPDATE artifact_versions SET status = 'candidate' WHERE id = v1_id;

    -- С этого момента содержимое неизменяемо.
    BEGIN
        UPDATE artifact_versions SET body = '{"text":"tampered"}'::jsonb WHERE id = v1_id;
        RAISE EXCEPTION 'содержимое версии изменилось после черновика';
    EXCEPTION WHEN restrict_violation THEN NULL;
    END;

    BEGIN
        UPDATE artifact_versions SET checksum = repeat('b', 32) WHERE id = v1_id;
        RAISE EXCEPTION 'отпечаток версии изменился после черновика';
    EXCEPTION WHEN restrict_violation THEN NULL;
    END;

    -- Возврат в черновик — это тихая правка задним числом.
    BEGIN
        UPDATE artifact_versions SET status = 'draft' WHERE id = v1_id;
        RAISE EXCEPTION 'версия вернулась в черновик';
    EXCEPTION WHEN restrict_violation THEN NULL;
    END;

    BEGIN
        DELETE FROM artifact_versions WHERE id = v1_id;
        RAISE EXCEPTION 'нечерновая версия удалена';
    EXCEPTION WHEN restrict_violation THEN NULL;
    END;

    -- Жизненный цикл двигаться обязан, иначе версию нельзя утвердить.
    UPDATE artifact_versions
       SET status = 'approved', approved_at = now()
     WHERE id = v1_id;

    INSERT INTO artifact_versions (artifact_id, version, body, checksum, parent_id, status)
    VALUES (art_id, 2, '{"text":"v2"}'::jsonb, repeat('c', 32), v1_id, 'approved')
    RETURNING id INTO v2_id;

    -- Один действующий указатель на артефакт в окружении.
    INSERT INTO artifact_publications (artifact_id, environment, version_id, reason)
    VALUES (art_id, 'production', v1_id, 'первая публикация');

    BEGIN
        INSERT INTO artifact_publications (artifact_id, environment, version_id)
        VALUES (art_id, 'production', v2_id);
        RAISE EXCEPTION 'две действующие публикации в одном окружении';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;

    -- Окружения независимы: canary не мешает production.
    INSERT INTO artifact_publications (artifact_id, environment, version_id, rollout_percent)
    VALUES (art_id, 'canary', v2_id, 10);

    -- Раскатка v2: прежняя публикация снимается и запоминается точкой отката.
    UPDATE artifact_publications SET retired_at = now()
     WHERE artifact_id = art_id AND environment = 'production' AND retired_at IS NULL;
    INSERT INTO artifact_publications
        (artifact_id, environment, version_id, previous_version_id, reason)
    VALUES (art_id, 'production', v2_id, v1_id, 'раскатка v2')
    RETURNING id INTO pub_id;

    -- Откат одним действием: ещё одна публикация, а не удаление предыдущей.
    UPDATE artifact_publications SET retired_at = now() WHERE id = pub_id;
    INSERT INTO artifact_publications
        (artifact_id, environment, version_id, previous_version_id, reason)
    SELECT art_id, 'production', previous_version_id, version_id, 'откат'
      FROM artifact_publications WHERE id = pub_id;

    SELECT version_id INTO active_ver
      FROM artifact_publications
     WHERE artifact_id = art_id AND environment = 'production' AND retired_at IS NULL;
    IF active_ver <> v1_id THEN
        RAISE EXCEPTION 'откат не вернул прежнюю версию: указатель на %', active_ver;
    END IF;

    SELECT count(*) INTO history_len
      FROM artifact_publications
     WHERE artifact_id = art_id AND environment = 'production';
    IF history_len <> 3 THEN
        RAISE EXCEPTION 'история публикаций переписана: % записей вместо 3', history_len;
    END IF;

    -- Версия, на которую ссылается публикация или прогон, не исчезает.
    INSERT INTO artifact_usages (run_kind, run_id, version_id)
    VALUES ('turn', 'ci-immutability-run', v2_id);

    BEGIN
        DELETE FROM artifact_versions WHERE id = v2_id;
        RAISE EXCEPTION 'версия под публикацией и прогоном удалена';
    EXCEPTION WHEN restrict_violation THEN NULL;
    END;

    -- Один прогон фиксирует одну версию один раз: повтор при восстановлении
    -- хода не должен ни падать, ни плодить строки.
    INSERT INTO artifact_usages (run_kind, run_id, version_id)
    VALUES ('turn', 'ci-immutability-run', v2_id)
    ON CONFLICT (run_kind, run_id, version_id) DO NOTHING;

    IF (SELECT count(*) FROM artifact_usages WHERE run_id = 'ci-immutability-run') <> 1 THEN
        RAISE EXCEPTION 'повторная фиксация версии создала вторую строку';
    END IF;
END $$;

-- Ничего не оставляем: проба существует только внутри этой транзакции.
ROLLBACK;
