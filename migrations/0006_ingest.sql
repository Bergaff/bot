-- Нумерация: 0005 в Bergaff/parcel занят под matches (src/match.ts), поэтому файл
-- сразу называется 0006 — при переносе его кладут в parcel/migrations/ как есть,
-- и `wrangler d1 migrations apply` не путается в порядке. В этом standalone-репозитории
-- 0005 просто нет: локальный раннер (local/sqlite-env.ts) применяет файлы по именам.
-- Авто-сбор объявлений без добавления бота в чаты (ТЗ docs/tz-auto-collection.md, п. 2.2).
--
-- 1) listings.origin — ОТКУДА пришла заявка:
--      bot       — бот добавлен в чат / сообщение переслали боту (как раньше);
--      collector — серверный cron-обход публичных чатов t.me/s/<username> (вариант A);
--      extension — браузерное расширение, POST /api/ingest (вариант B).
--    Без CHECK-ограничения: SQLite не умеет менять ограничения у существующей
--    колонки, допустимые значения контролирует код (тип ListingOrigin).
ALTER TABLE listings ADD COLUMN origin TEXT NOT NULL DEFAULT 'bot';

CREATE INDEX IF NOT EXISTS idx_listings_origin ON listings (origin);

-- 2) Чаты, которые обходит серверный сборщик (вариант A).
--    last_message_id — КУРСОР: id последнего обработанного сообщения.
--    Курсор экономит запросы, но от дублей защищает tg_seen (chat_id, message_id).
CREATE TABLE IF NOT EXISTS watch_chats (
  id              TEXT PRIMARY KEY,                 -- 'web:<username>'
  username        TEXT NOT NULL UNIQUE,             -- как в t.me/<username>
  kind            TEXT NOT NULL DEFAULT 'channel',  -- 'channel' | 'supergroup'
  title           TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_message_id INTEGER,                          -- курсор
  last_checked_at TEXT,
  last_error      TEXT,
  error_count     INTEGER NOT NULL DEFAULT 0,       -- 3 подряд → enabled = 0
  stats_found     INTEGER NOT NULL DEFAULT 0,       -- сколько сообщений увидели
  stats_created   INTEGER NOT NULL DEFAULT 0,       -- сколько заявок создали
  stats_skipped   INTEGER NOT NULL DEFAULT 0,       -- сколько отсеяли
  added_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_watch_enabled ON watch_chats (enabled);
CREATE INDEX IF NOT EXISTS idx_watch_checked ON watch_chats (last_checked_at);
