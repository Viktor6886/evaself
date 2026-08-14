BEGIN;

-- Шаг 25. Дневник Mini App и связывание каналов.
--
-- Запись дня НЕ кладётся в eva_notes: заметка — рабочая информация, у неё
-- нет ни настроения, ни даты события, ни голосовой версии, ни разделения
-- «сохранено без ИИ» и «отдано Еве». Смешение этих двух лент уже один раз
-- заставило фронтенд фильтровать заметки по entry_type='journal', и любая
-- новая колонка дневника ломала бы рабочие заметки.

CREATE TABLE IF NOT EXISTS journal_entries (
  id             bigserial PRIMARY KEY,
  user_id        bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date     date NOT NULL,
  title          text,
  content        text NOT NULL,
  -- Настроение — та же шкала, что в user_checkins: две разные шкалы
  -- настроения в одном продукте нельзя ни сравнить, ни свести в обзор.
  mood           text CHECK (mood IN ('very_low','low','neutral','good','great')),
  energy         smallint CHECK (energy BETWEEN 1 AND 10),
  -- Куда запись отправилась. 'saved' — сохранена без участия ИИ и
  -- останется такой навсегда, пока человек сам не нажмёт «обсудить».
  share_state    text NOT NULL DEFAULT 'saved'
                 CHECK (share_state IN ('saved','shared_with_eva')),
  shared_at      timestamptz,
  source_channel text NOT NULL DEFAULT 'miniapp'
                 CHECK (source_channel IN ('miniapp','telegram')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((share_state = 'shared_with_eva') = (shared_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS journal_entries_user_date_idx
  ON journal_entries(user_id, local_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS journal_entries_fts_idx
  ON journal_entries USING gin(to_tsvector('simple', coalesce(title,'') || ' ' || content));

-- Связь записи с уже существующей сущностью. Отдельной таблицы событий
-- нет намеренно: событием служит задача, цель или отметка состояния —
-- заводить четвёртый список того же было бы дублированием (инвариант 20).
CREATE TABLE IF NOT EXISTS journal_entry_links (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id    bigint NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('goal','task','checkin')),
  target_id   bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS journal_entry_links_user_idx
  ON journal_entry_links(user_id, target_type, target_id);

-- Карточка человека, которого упомянул пользователь.
--
-- Здесь сознательно нет ни оценок, ни выводов, ни признаков: инвариант 30
-- запрещает скрытый анализ третьего лица, а пункт 10 шага — минимизацию
-- чужих данных. Хранится только то, что нужно, чтобы человек сам узнал
-- своё упоминание: как он его называет и необязательная роль.
CREATE TABLE IF NOT EXISTS journal_people (
  id           bigserial PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  -- Нормализованное имя нужно только для склейки повторных упоминаний
  -- одного и того же человека внутри дневника ОДНОГО пользователя.
  -- Совпадение имён у разных пользователей ничего не объединяет.
  normalized   text NOT NULL,
  relation     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, normalized)
);

CREATE TABLE IF NOT EXISTS journal_entry_people (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id   bigint NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  person_id  bigint NOT NULL REFERENCES journal_people(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id, person_id)
);
CREATE INDEX IF NOT EXISTS journal_entry_people_person_idx
  ON journal_entry_people(user_id, person_id);

-- Голосовая заметка живёт не вечно: файл лежит в media-service, а здесь
-- только состояние и срок. Расшифровка хранится отдельно от файла именно
-- потому, что файл удаляется раньше — по сроку хранения, — а текст
-- остаётся частью записи дневника.
CREATE TABLE IF NOT EXISTS journal_voice_notes (
  id           bigserial PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id     bigint REFERENCES journal_entries(id) ON DELETE CASCADE,
  media_key    text NOT NULL,
  duration_ms  integer CHECK (duration_ms >= 0),
  status       text NOT NULL DEFAULT 'stored'
               CHECK (status IN ('stored','transcribed','expired','failed')),
  transcript   text,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, media_key)
);
CREATE INDEX IF NOT EXISTS journal_voice_notes_expiry_idx
  ON journal_voice_notes(expires_at) WHERE status IN ('stored','transcribed');

-- Одно сообщение канала — один ход и одна conversation.
--
-- Это и есть «общий аккаунт» из пункта 2: Telegram и Mini App пишут сюда
-- под одним user_id, поэтому действие, сделанное в одном канале, видно в
-- другом. Ключ объединения — только внутренний user_id; имя, username,
-- город и телефон ключом не являются (инвариант 6), и в таблице их нет.
CREATE TABLE IF NOT EXISTS channel_message_links (
  id                 bigserial PRIMARY KEY,
  user_id            bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel            text NOT NULL CHECK (channel IN ('telegram','miniapp')),
  channel_message_id text NOT NULL,
  turn_id            text,
  conversation_id    text,
  entry_id           bigint REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, channel_message_id)
);
CREATE INDEX IF NOT EXISTS channel_message_links_user_idx
  ON channel_message_links(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS channel_message_links_turn_idx
  ON channel_message_links(turn_id) WHERE turn_id IS NOT NULL;

INSERT INTO schema_migrations(version) VALUES('052_miniapp_journal')
  ON CONFLICT DO NOTHING;
COMMIT;
