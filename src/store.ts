import type { Env, ListFilters, Listing, ListingInput, ListingOrigin, ListingStatus } from './types.ts';
import { listingSourceLink } from './links.ts';
import type { DedupeSubject, DuplicateHit, DuplicateKind } from './dedupe.ts';
import { pickDuplicate } from './dedupe.ts';
import { normalizeContacts } from './util.ts';

function mapRow(row: Record<string, unknown>): Listing {
  return {
    id: String(row.id),
    type: row.type as Listing['type'],
    fromCity: String(row.from_city),
    toCity: String(row.to_city),
    departureDate: row.departure_date ? String(row.departure_date) : null,
    weightKg: row.weight_kg === null || row.weight_kg === undefined ? null : Number(row.weight_kg),
    price: row.price ? String(row.price) : null,
    description: String(row.description),
    phone: row.phone ? String(row.phone) : null,
    telegram: row.telegram ? String(row.telegram) : null,
    status: row.status as ListingStatus,
    source: row.source as Listing['source'],
    sourceChat: row.source_chat ? String(row.source_chat) : null,
    sourceChatId: row.source_chat_id ? String(row.source_chat_id) : null,
    sourceMessageId: row.source_message_id ? Number(row.source_message_id) : null,
    sourceTopicId: row.source_topic_id ? Number(row.source_topic_id) : null,
    origin: (row.origin as ListingOrigin | undefined) ?? 'bot',
    createdAt: String(row.created_at),
    publishedAt: row.published_at ? String(row.published_at) : null,
    views: Number(row.views ?? 0),
  };
}

export async function createListing(env: Env, input: ListingInput): Promise<Listing> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const publishedAt = input.status === 'published' ? now : null;
  // Единая точка нормализации контактов: номер не должен лежать в поле telegram,
  // а один и тот же контакт — в обоих полях (иначе дубли в карточке и битая
  // ссылка t.me/+48… на сайте). Через createListing проходят все источники.
  const { telegram, phone } = normalizeContacts(input.telegram, input.phone);
  await env.DB.prepare(
    `INSERT INTO listings
      (id, type, from_city, to_city, departure_date, weight_kg, price, description,
       phone, telegram, status, source, source_chat, source_chat_id, source_message_id,
       source_topic_id, origin, created_at, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id, input.type, input.fromCity, input.toCity,
      input.departureDate ?? null, input.weightKg ?? null, input.price ?? null,
      input.description, phone, telegram,
      input.status, input.source, input.sourceChat ?? null, input.sourceChatId ?? null,
      input.sourceMessageId ?? null, input.sourceTopicId ?? null, input.origin ?? 'bot', now, publishedAt
    )
    .run();
  const row = (await env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(id).first()) as
    | Record<string, unknown>
    | null;
  if (!row) throw new Error('Failed to create listing');
  return mapRow(row);
}

export async function listListings(
  env: Env,
  f: ListFilters
): Promise<{ items: Listing[]; hasMore: boolean }> {
  const { sql, params } = buildWhere(f);
  let fullSql = `SELECT * FROM listings${sql}`;
  if (f.type) { fullSql += ' AND type = ?'; params.push(f.type); }

  const page = Math.max(1, f.page ?? 1);
  const perPage = Math.min(50, Math.max(1, f.perPage ?? 20));
  fullSql += ' ORDER BY COALESCE(published_at, created_at) DESC LIMIT ? OFFSET ?';
  params.push(perPage + 1, (page - 1) * perPage);

  const res = await env.DB.prepare(fullSql).bind(...params).all();
  const rows = (res.results ?? []) as unknown as Array<Record<string, unknown>>;
  const hasMore = rows.length > perPage;
  return { items: rows.slice(0, perPage).map(mapRow), hasMore };
}

export async function getListingById(env: Env, id: string, opts: { hitView?: boolean } = {}): Promise<Listing | null> {
  if (opts.hitView) {
    await env.DB.prepare('UPDATE listings SET views = views + 1 WHERE id = ?').bind(id).run();
  }
  const row = (await env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(id).first()) as
    | Record<string, unknown>
    | null;
  return row ? mapRow(row) : null;
}

export async function updateListingStatus(env: Env, id: string, status: ListingStatus): Promise<boolean> {
  const publishedAt = status === 'published' ? new Date().toISOString() : null;
  const res = await env.DB.prepare(
    'UPDATE listings SET status = ?, published_at = COALESCE(?, published_at) WHERE id = ?'
  ).bind(status, publishedAt, id).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function listPending(env: Env, limit = 50): Promise<Listing[]> {
  const res = await env.DB.prepare(
    'SELECT * FROM listings WHERE status = ? ORDER BY created_at DESC LIMIT ?'
  ).bind('pending', limit).all();
  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map(mapRow);
}

/**
 * Заявки по городу (куда ИЛИ откуда), без учёта регистра.
 * Кроме действующих показывает и архив — заявки с прошедшей датой,
 * которые ещё не удалились (30 дней после даты выезда). Активные — выше.
 */
export async function searchByCity(env: Env, city: string, limit = 30): Promise<Listing[]> {
  const pattern = globCi(city);
  const res = await env.DB.prepare(
    `SELECT * FROM listings
     WHERE status IN ('published', 'expired')
       AND (from_city GLOB ? OR to_city GLOB ?)
       AND (departure_date IS NULL OR departure_date >= date('now', '+3 hours', '-30 days'))
     ORDER BY (CASE WHEN status = 'expired' OR departure_date < date('now', '+3 hours') THEN 1 ELSE 0 END),
              COALESCE(published_at, created_at) DESC
     LIMIT ?`
  ).bind(pattern, pattern, limit).all();
  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map(mapRow);
}

/**
 * Архивация по расписанию (cron, раз в сутки):
 * 1) опубликованные заявки с прошедшей датой выезда → статус 'expired' (архив):
 *    они пропадают с доски, но месяц ещё доступны по ссылке и в /поиск;
 * 2) заявки старше 30 дней с даты выезда — удаляются насовсем (вместе с жалобами, ON DELETE CASCADE).
 */
export async function archiveExpired(env: Env): Promise<{ archived: number; deleted: number }> {
  const upd = await env.DB.prepare(
    `UPDATE listings SET status = 'expired'
     WHERE status = 'published'
       AND departure_date IS NOT NULL
       AND departure_date < date('now', '+3 hours')`
  ).run();
  const del = await env.DB.prepare(
    `DELETE FROM listings
     WHERE departure_date IS NOT NULL
       AND departure_date < date('now', '+3 hours', '-30 days')`
  ).run();
  return { archived: upd.meta.changes ?? 0, deleted: del.meta.changes ?? 0 };
}

/** Заявка по префиксу id (от 4 символов): «a1b2» из «№ A1B2» на сайте,
 *  короткий id из сообщения бота (#a1b2c3d4) или полный uuid из ссылки. */
export async function findByIdPrefix(env: Env, prefix: string): Promise<Listing[]> {
  const clean = prefix.toLowerCase().replace(/[^0-9a-f-]/g, '');
  if (clean.length < 4 || clean.length > 36) return [];
  const res = await env.DB.prepare('SELECT * FROM listings WHERE id LIKE ?').bind(`${clean}%`).all();
  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map(mapRow);
}

/** Заявки на доске (действующие + архив) — для админ-панели сайта. */
export async function listAdminBoard(env: Env, limit = 200): Promise<Listing[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM listings WHERE status IN ('published', 'expired')
     ORDER BY COALESCE(published_at, created_at) DESC LIMIT ?`
  ).bind(limit).all();
  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map(mapRow);
}

/** Редактирование заявки в админ-панели: обновляет поля и возвращает обновлённую заявку. */
export async function updateListing(
  env: Env,
  id: string,
  patch: Partial<Pick<ListingInput,
    'type' | 'fromCity' | 'toCity' | 'departureDate' | 'weightKg' | 'price' | 'description' | 'telegram' | 'phone'>>
): Promise<Listing | null> {
  // Те же правила, что при создании: контакты без дублей и каждый в своём поле
  const { telegram, phone } = normalizeContacts(patch.telegram, patch.phone);
  const res = await env.DB.prepare(
    `UPDATE listings SET
       type = ?, from_city = ?, to_city = ?, departure_date = ?, weight_kg = ?,
       price = ?, description = ?, telegram = ?, phone = ?
     WHERE id = ?`
  ).bind(
    patch.type ?? 'offer', patch.fromCity ?? '', patch.toCity ?? '',
    patch.departureDate ?? null, patch.weightKg ?? null, patch.price ?? null,
    patch.description ?? '', telegram, phone, id
  ).run();
  if ((res.meta.changes ?? 0) === 0) return null;
  const row = (await env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(id).first()) as
    | Record<string, unknown>
    | null;
  return row ? mapRow(row) : null;
}

/** Разово создать таблицу chat_links, если её нет (тот же DDL, что в миграции 0002).
 *  Идемпотентно: IF NOT EXISTS, существующие данные не затрагиваются. */
export async function ensureChatLinksTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS chat_links (
       chat_id TEXT PRIMARY KEY,
       url TEXT NOT NULL,
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  ).run();
}

/** Публичные ссылки на чаты-источники (админ задаёт вручную): id чата → ссылка t.me/… */
export async function getChatLinks(env: Env): Promise<Record<string, string>> {
  const res = await env.DB.prepare('SELECT chat_id, url FROM chat_links').all();
  const out: Record<string, string> = {};
  for (const row of (res.results ?? []) as Array<Record<string, unknown>>) {
    if (typeof row.chat_id === 'string' && typeof row.url === 'string' && row.url) out[row.chat_id] = row.url;
  }
  return out;
}

/** Сохранить публичную ссылку на чат (пустая строка — убрать ссылку). */
export async function upsertChatLink(env: Env, chatId: string, url: string): Promise<void> {
  if (!url) {
    await env.DB.prepare('DELETE FROM chat_links WHERE chat_id = ?').bind(chatId).run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO chat_links (chat_id, url, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at`
  ).bind(chatId, url, new Date().toISOString()).run();
}

/** Чаты-источники для админки: сколько из них заявок и какая ссылка задана. */
export async function listSourceChats(
  env: Env
): Promise<Array<{ chatId: string; title: string | null; count: number; url: string | null }>> {
  const res = await env.DB.prepare(
    `SELECT l.source_chat_id AS chatId, MAX(l.source_chat) AS title, COUNT(*) AS cnt, cl.url AS url
     FROM listings l LEFT JOIN chat_links cl ON cl.chat_id = l.source_chat_id
     WHERE l.source_chat_id IS NOT NULL
       AND (l.source_chat_id LIKE '-%' OR l.source_chat_id LIKE 'web:%' OR l.source_chat_id LIKE 'ext:%')
     GROUP BY l.source_chat_id ORDER BY cnt DESC LIMIT 100`
  ).all();
  return ((res.results ?? []) as Array<Record<string, unknown>>).map((r) => ({
    chatId: typeof r.chatId === 'string' ? r.chatId : '',
    title: typeof r.title === 'string' ? r.title : null,
    count: Number(r.cnt ?? 0),
    url: typeof r.url === 'string' ? r.url : null,
  }));
}

/** Связи заявки: встречные рейсы, тот же маршрут (±3 дня), другие заявки того же контакта. */
export async function findRelated(
  env: Env,
  l: Listing,
  opts: { includePending?: boolean } = {}
): Promise<{ reverse: Listing[]; same: Listing[]; sameContact: Listing[] }> {
  const statuses = opts.includePending
    ? "('published', 'expired', 'pending')"
    : "('published', 'expired')";
  const run = async (sql: string, ...params: (string | number | null)[]): Promise<Listing[]> => {
    const res = await env.DB.prepare(sql).bind(...params).all();
    return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map(mapRow);
  };
  const reverse = await run(
    `SELECT * FROM listings WHERE status IN ${statuses} AND id <> ? AND from_city = ? AND to_city = ?
     ORDER BY COALESCE(published_at, created_at) DESC LIMIT 5`,
    l.id, l.toCity, l.fromCity
  );
  const same = l.departureDate
    ? await run(
        `SELECT * FROM listings WHERE status IN ${statuses} AND id <> ? AND from_city = ? AND to_city = ?
         AND departure_date IS NOT NULL AND ABS(julianday(departure_date) - julianday(?)) <= 3
         ORDER BY departure_date LIMIT 5`,
        l.id, l.fromCity, l.toCity, l.departureDate)
    : await run(
        `SELECT * FROM listings WHERE status IN ${statuses} AND id <> ? AND from_city = ? AND to_city = ?
         ORDER BY COALESCE(published_at, created_at) DESC LIMIT 5`,
        l.id, l.fromCity, l.toCity);
  const sameContact = await run(
    `SELECT * FROM listings WHERE status IN ${statuses} AND id <> ?
     AND ((telegram IS NOT NULL AND telegram = ?) OR (phone IS NOT NULL AND phone = ?))
     ORDER BY COALESCE(published_at, created_at) DESC LIMIT 5`,
    l.id, l.telegram ?? '', l.phone ?? ''
  );
  return { reverse, same, sameContact };
}

/** Полное удаление заявки (админ-панель): вместе с жалобами и отметками обработанных сообщений. */
export async function deleteListing(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.batch([
    env.DB.prepare('DELETE FROM reports WHERE listing_id = ?').bind(id),
    env.DB.prepare('DELETE FROM tg_seen WHERE listing_id = ?').bind(id),
    env.DB.prepare('DELETE FROM listings WHERE id = ?').bind(id),
  ]);
  return Number(res[2]?.meta.changes ?? 0) > 0;
}

export async function addReport(env: Env, listingId: string, reason: string | null, ip: string | null): Promise<{ ok: boolean; autoRejected: boolean; count: number }> {
  const listing = await getListingById(env, listingId);
  if (!listing || listing.status !== 'published') return { ok: false, autoRejected: false, count: 0 };

  await env.DB.prepare(
    'INSERT INTO reports (id, listing_id, reason, reporter_ip, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), listingId, reason, ip, new Date().toISOString()).run();

  const countRes = await env.DB.prepare('SELECT COUNT(*) AS n FROM reports WHERE listing_id = ?').bind(listingId).first();
  const count = Number((countRes as { n?: number } | null)?.n ?? 0);
  let autoRejected = false;
  if (count >= 3) {
    await updateListingStatus(env, listingId, 'rejected');
    autoRejected = true;
  }
  return { ok: true, autoRejected, count };
}

export async function markSeen(env: Env, chatId: string, messageId: number): Promise<boolean> {
  const res = await env.DB.prepare(
    'INSERT OR IGNORE INTO tg_seen (chat_id, message_id, seen_at) VALUES (?, ?, ?)'
  ).bind(chatId, messageId, new Date().toISOString()).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function getSeenListing(env: Env, chatId: string, messageId: number): Promise<string | null> {
  const row = (await env.DB.prepare(
    'SELECT listing_id FROM tg_seen WHERE chat_id = ? AND message_id = ?'
  ).bind(chatId, messageId).first()) as { listing_id?: string } | null;
  return row?.listing_id ? row.listing_id : null;
}

export async function setSeenListing(env: Env, chatId: string, messageId: number, listingId: string): Promise<void> {
  await env.DB.prepare(
    'UPDATE tg_seen SET listing_id = ? WHERE chat_id = ? AND message_id = ?'
  ).bind(listingId, chatId, messageId).run();
}

function escapeLike(s: string): string {
  return s.replace(/([%_\\])/g, '\\$1');
}

/** Паттерн для GLOB без учёта регистра (SQLite LIKE не сворачивает регистр кириллицы):
 *  каждая буква превращается в класс [аА], спецсимволы GLOB (* ? [ ]) экранируются. */
function globCi(q: string): string {
  let out = '';
  for (const ch of q) {
    const lo = ch.toLowerCase();
    const up = ch.toUpperCase();
    if (ch === ']' ) out += '[]]';
    else if (ch === '*' || ch === '?' || ch === '[') out += `[${ch}]`;
    else if (lo !== up) out += `[${lo}${up}]`;
    else out += ch;
  }
  return `*${out}*`;
}

interface WhereClause { sql: string; params: (string | number)[] }

function buildWhere(f: ListFilters): WhereClause {
  let sql: string;
  const params: (string | number)[] = [];
  if (f.archive) {
    // Архив (вкладка на доске): помеченные cron'ом ('expired')
    // и ещё не помеченные просроченные ('published' с прошедшей датой).
    sql = " WHERE (status = 'expired' OR (status = 'published' AND departure_date IS NOT NULL AND departure_date < date('now', '+3 hours')))";
  } else {
    sql = ' WHERE status = ?';
    params.push(f.status ?? 'published');
    // Доска показывает только актуальные заявки: дата выезда не прошла
    // (или не указана). Просроченные живут в архиве — см. archiveExpired.
    if ((f.status ?? 'published') === 'published') {
      sql += " AND (departure_date IS NULL OR departure_date >= date('now', '+3 hours'))";
    }
  }
  if (f.from) { sql += ' AND from_city GLOB ?'; params.push(globCi(f.from)); }
  if (f.to) { sql += ' AND to_city GLOB ?'; params.push(globCi(f.to)); }
  if (f.date) { sql += ' AND departure_date = ?'; params.push(f.date); }
  if (f.q) {
    const pattern = globCi(f.q);
    sql += ' AND (description GLOB ? OR from_city GLOB ? OR to_city GLOB ?)';
    params.push(pattern, pattern, pattern);
  }
  return { sql, params };
}

/** Количество объявлений по типам с учётом фильтров поиска (без учёта вкладки-типа). */
export async function getCounts(env: Env, f: ListFilters): Promise<{ offer: number; request: number }> {
  const { sql, params } = buildWhere(f);
  const res = await env.DB.prepare(
    `SELECT type, COUNT(*) AS n FROM listings${sql} GROUP BY type`
  ).bind(...params).all();
  let offer = 0;
  let request = 0;
  for (const row of (res.results ?? []) as unknown as Array<{ type?: string; n?: number }>) {
    if (row.type === 'offer') offer = Number(row.n ?? 0);
    if (row.type === 'request') request = Number(row.n ?? 0);
  }
  return { offer, request };
}

/* ------------------------------------------------------------------ */
/* Авто-сбор: watch_chats (вариант A) и служебные счётчики              */
/* ------------------------------------------------------------------ */

/** Чат, который обходит серверный сборщик (таблица watch_chats, миграция 0006). */
export interface WatchChat {
  /** 'web:<username>' — он же source_chat_id заявок и ключ tg_seen. */
  id: string;
  username: string;
  /** 'channel' | 'supergroup' — у супергруппы веб-превью может не быть. */
  kind: string;
  title: string | null;
  enabled: boolean;
  /** КУРСОР: id последнего обработанного сообщения. Оптимизация, не защита от дублей. */
  lastMessageId: number | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  errorCount: number;
  statsFound: number;
  statsCreated: number;
  statsSkipped: number;
  addedAt: string;
}

function mapWatchRow(r: Record<string, unknown>): WatchChat {
  return {
    id: String(r.id ?? ''),
    username: String(r.username ?? ''),
    kind: String(r.kind ?? 'channel'),
    title: r.title ? String(r.title) : null,
    enabled: Number(r.enabled ?? 1) === 1,
    lastMessageId: r.last_message_id === null || r.last_message_id === undefined ? null : Number(r.last_message_id),
    lastCheckedAt: r.last_checked_at ? String(r.last_checked_at) : null,
    lastError: r.last_error ? String(r.last_error) : null,
    errorCount: Number(r.error_count ?? 0),
    statsFound: Number(r.stats_found ?? 0),
    statsCreated: Number(r.stats_created ?? 0),
    statsSkipped: Number(r.stats_skipped ?? 0),
    addedAt: String(r.added_at ?? ''),
  };
}

export async function listWatchChats(env: Env, opts: { enabledOnly?: boolean } = {}): Promise<WatchChat[]> {
  const sql = opts.enabledOnly
    ? 'SELECT * FROM watch_chats WHERE enabled = 1 ORDER BY added_at'
    : 'SELECT * FROM watch_chats ORDER BY added_at';
  const res = await env.DB.prepare(sql).all();
  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map(mapWatchRow);
}

export async function getWatchChat(env: Env, id: string): Promise<WatchChat | null> {
  const row = (await env.DB.prepare('SELECT * FROM watch_chats WHERE id = ?').bind(id).first()) as
    | Record<string, unknown>
    | null;
  return row ? mapWatchRow(row) : null;
}

/** Добавить чат в обход. Уже есть — вернём существующего (409 делает вызывающий код). */
export async function addWatchChat(
  env: Env,
  input: { username: string; kind?: string; title?: string | null }
): Promise<WatchChat> {
  const username = input.username.trim().replace(/^@/, '');
  const id = `web:${username}`;
  await env.DB.prepare(
    `INSERT INTO watch_chats (id, username, kind, title, enabled, added_at)
     VALUES (?, ?, ?, ?, 1, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind,
       title = COALESCE(excluded.title, watch_chats.title)`
  ).bind(id, username, input.kind === 'supergroup' ? 'supergroup' : 'channel', input.title ?? null).run();
  const chat = await getWatchChat(env, id);
  if (!chat) throw new Error('Failed to add watch chat');
  return chat;
}

export interface WatchChatPatch {
  enabled?: boolean;
  kind?: string;
  title?: string | null;
  /** null — сбросить курсор (осознанное действие админа). */
  lastMessageId?: number | null;
}

/** Правка чата: вкл/выкл, тип, название, курсор. */
export async function patchWatchChat(env: Env, id: string, patch: WatchChatPatch): Promise<WatchChat | null> {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); params.push(patch.enabled ? 1 : 0); }
  if (patch.kind !== undefined) { sets.push('kind = ?'); params.push(patch.kind === 'supergroup' ? 'supergroup' : 'channel'); }
  if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title); }
  if (patch.lastMessageId !== undefined) { sets.push('last_message_id = ?'); params.push(patch.lastMessageId); }
  if (sets.length === 0) return getWatchChat(env, id);
  params.push(id);
  const res = await env.DB.prepare(`UPDATE watch_chats SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();
  if ((res.meta.changes ?? 0) === 0) return getWatchChat(env, id);
  return getWatchChat(env, id);
}

export async function deleteWatchChat(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.prepare('DELETE FROM watch_chats WHERE id = ?').bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Чаты, которые пора обходить: включённые, давно не проверенные первыми.
 * Лимит обязателен — за один вызов cron воркер может сделать ~50 подзапросов
 * (бесплатный тариф), поэтому обходим порцией и ротируем список.
 */
export async function dueWatchChats(env: Env, limit: number): Promise<WatchChat[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM watch_chats WHERE enabled = 1
     ORDER BY (last_checked_at IS NULL) DESC, last_checked_at ASC, added_at ASC
     LIMIT ?`
  ).bind(Math.max(1, limit)).all();
  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map(mapWatchRow);
}

export interface WatchChatRunUpdate {
  /** Новый курсор (максимальный обработанный id). null — не двигать. */
  lastMessageId?: number | null;
  found?: number;
  created?: number;
  skipped?: number;
  duplicate?: number;
  title?: string | null;
}

/**
 * Успешный обход чата: курсор вперёд, счётчики плюс, ошибка сброшена.
 *
 * Курсор только РАСТЁТ. В SQLite скалярный MAX(a, b) возвращает NULL, если
 * любой из аргументов NULL, — поэтому «первый прогон» (last_message_id IS NULL)
 * и «не двигать курсор» (передан null) разбираем явным CASE.
 */
export async function markWatchChecked(env: Env, id: string, upd: WatchChatRunUpdate): Promise<void> {
  const cursor = upd.lastMessageId ?? null;
  await env.DB.prepare(
    `UPDATE watch_chats SET
       last_checked_at = datetime('now'),
       last_message_id = CASE
         WHEN ? IS NULL THEN last_message_id
         WHEN last_message_id IS NULL THEN ?
         WHEN ? > last_message_id THEN ?
         ELSE last_message_id
       END,
       title = COALESCE(?, title),
       stats_found = stats_found + ?,
       stats_created = stats_created + ?,
       stats_skipped = stats_skipped + ?,
       last_error = NULL,
       error_count = 0
     WHERE id = ?`
  ).bind(
    cursor, cursor, cursor, cursor,
    upd.title ?? null,
    upd.found ?? 0,
    upd.created ?? 0,
    (upd.skipped ?? 0) + (upd.duplicate ?? 0),
    id
  ).run();
}

/** Сколько ошибок подряд до авто-отключения чата (ТЗ п. 3.7). */
export const WATCH_MAX_ERRORS = 3;

/**
 * Ошибка обхода чата: курсор НЕ двигаем, счётчик ошибок растёт.
 * После WATCH_MAX_ERRORS подряд (или сразу при 404) чат выключается сам —
 * вызывающий код шлёт админам уведомление (disabled=true в ответе).
 */
export async function markWatchError(
  env: Env,
  id: string,
  error: string,
  opts: { disableNow?: boolean } = {}
): Promise<{ errorCount: number; disabled: boolean }> {
  const row = (await env.DB.prepare('SELECT error_count FROM watch_chats WHERE id = ?').bind(id).first()) as
    | { error_count?: number }
    | null;
  const errorCount = Number(row?.error_count ?? 0) + 1;
  const disabled = Boolean(opts.disableNow) || errorCount >= WATCH_MAX_ERRORS;
  await env.DB.prepare(
    `UPDATE watch_chats SET
       last_checked_at = datetime('now'),
       last_error = ?,
       error_count = ?,
       enabled = CASE WHEN ? = 1 THEN 0 ELSE enabled END
     WHERE id = ?`
  ).bind(error.slice(0, 300), errorCount, disabled ? 1 : 0, id).run();
  return { errorCount, disabled };
}

/** Сбросить счётчик ошибок, не трогая курсор (чат снова в строю). */
export async function resetWatchErrors(env: Env, id: string): Promise<void> {
  await env.DB.prepare('UPDATE watch_chats SET error_count = 0, last_error = NULL WHERE id = ?').bind(id).run();
}

/**
 * Откатить отметку «обработано» — если создать заявку не удалось,
 * сообщение должно остаться доступным для повторной обработки.
 * (Тот же DELETE, что в handleGroupText() бота.)
 */
export async function unmarkSeen(env: Env, chatId: string, messageId: number): Promise<void> {
  await env.DB.prepare('DELETE FROM tg_seen WHERE chat_id = ? AND message_id = ?')
    .bind(chatId, messageId).run();
}

/** Сколько заявок дал каждый источник (бот / сборщик / расширение) — для админки. */
export async function countByOrigin(env: Env): Promise<Record<ListingOrigin, number>> {
  const out: Record<ListingOrigin, number> = { bot: 0, collector: 0, extension: 0 };
  try {
    const res = await env.DB.prepare(
      `SELECT COALESCE(origin, 'bot') AS origin, COUNT(*) AS n FROM listings GROUP BY origin`
    ).all();
    for (const row of (res.results ?? []) as unknown as Array<Record<string, unknown>>) {
      const key = String(row.origin ?? 'bot') as ListingOrigin;
      if (key in out) out[key] = Number(row.n ?? 0);
    }
  } catch {
    // колонки origin ещё нет (миграция 0006 не применена) — считаем всё ботом
  }
  return out;
}

/** Принято сообщений расширением за последние N часов (KV-счётчик, пишет /api/ingest). */
export async function getIngestDailyStats(env: Env): Promise<{ messages: number; created: number }> {
  const day = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const raw = await env.KV.get(`ingest:stats:${day}`);
  if (!raw) return { messages: 0, created: 0 };
  try {
    const parsed = JSON.parse(String(raw)) as { messages?: number; created?: number };
    return { messages: Number(parsed.messages ?? 0), created: Number(parsed.created ?? 0) };
  } catch {
    return { messages: 0, created: 0 };
  }
}

/** Прибавить к суточным счётчикам расширения (вариант B). */
export async function bumpIngestDailyStats(env: Env, messages: number, created: number): Promise<void> {
  const day = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const key = `ingest:stats:${day}`;
  const cur = await getIngestDailyStats(env);
  await env.KV.put(
    key,
    JSON.stringify({ messages: cur.messages + messages, created: cur.created + created }),
    { expirationTtl: 2 * 86400 }
  );
}

/* ------------------------------------------------------------------ */
/* Дубликаты по смыслу — КОПИЯ блока из src/store.ts Bergaff/parcel     */
/* ------------------------------------------------------------------ */
/* При переносе в parcel НЕ копировать: эти функции там уже есть (коммит e037b3f).
   Здесь они нужны, чтобы standalone-скраппер вёл себя как прод: tg_seen ловит
   повторы одного сообщения, а createListingSafe — повторяющиеся по смыслу
   объявления («еду 20 сентября Варшава — Минск» каждый день новым сообщением). */

/* Дубликаты: одно и то же объявление, присланное несколько раз         */
/* ------------------------------------------------------------------ */

/**
 * Кандидаты в дубликаты: тот же тип и дата выезда рядом (±1 день), статус
 * живой (на модерации, на доске или в архиве). Маршрут, контакты и текст
 * сравнивает src/dedupe.ts — там города нормализуются, а телефоны сверяются
 * по последним цифрам, поэтому в SQL эти условия не унести.
 */
export async function findDuplicateCandidates(env: Env, input: DedupeSubject): Promise<Listing[]> {
  const date = input.departureDate ?? null;
  const res = await env.DB.prepare(
    `SELECT * FROM listings
      WHERE status IN ('pending', 'published', 'expired')
        AND type = ?
        AND (? IS NULL OR departure_date IS NULL
             OR ABS(julianday(departure_date) - julianday(?)) <= 1)
      ORDER BY (status = 'published') DESC, COALESCE(published_at, created_at) DESC
      LIMIT 200`
  ).bind(input.type, date, date).all();
  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map(mapRow);
}

/**
 * Есть ли уже такая заявка: 'duplicate' — уверенно та же (не создаём вторую),
 * 'similar' — похожая (создаём, но модератора предупредим).
 */
export async function findDuplicate(
  env: Env,
  input: DedupeSubject
): Promise<DuplicateHit<Listing> | null> {
  const candidates = await findDuplicateCandidates(env, input);
  return pickDuplicate(candidates, input);
}

/**
 * Освежить существующую заявку вместо создания дубля: published поднимается
 * наверх доски (повторное «еду 20 сентября» снова свежее), pending остаётся
 * в очереди модерации, архив не трогаем — его вернул туда модератор или дата.
 */
export async function touchListing(env: Env, id: string): Promise<Listing | null> {
  const listing = await getListingById(env, id);
  if (!listing) return null;
  if (listing.status === 'published') {
    await env.DB.prepare(
      "UPDATE listings SET published_at = datetime('now') WHERE id = ?"
    ).bind(id).run();
  }
  return getListingById(env, id);
}

/**
 * Создать заявку, но не плодить дубликаты: если такая уже есть — вернуть её
 * (и освежить, если она на доске). Через неё идут все источники: пересылки,
 * сообщения в чатах, мастер /post и форма на сайте.
 */
export async function createListingSafe(
  env: Env,
  input: ListingInput,
  opts: { force?: boolean } = {}
): Promise<{
  listing: Listing;
  created: boolean;
  duplicateOf: Listing | null;
  kind: DuplicateKind | null;
  why: string;
}> {
  const hit = await findDuplicate(env, input);
  // force — заявку создаём в любом случае (например, /post человек заполнил сам),
  // но сведения о дубле возвращаем: модератор увидит предупреждение.
  if (hit && hit.kind === 'duplicate' && !opts.force) {
    const refreshed = await touchListing(env, hit.listing.id);
    const listing = refreshed ?? hit.listing;
    return { listing, created: false, duplicateOf: listing, kind: 'duplicate', why: hit.why };
  }
  const listing = await createListing(env, input);
  return {
    listing,
    created: true,
    duplicateOf: hit ? hit.listing : null,
    kind: hit ? hit.kind : null,
    why: hit ? hit.why : '',
  };
}

/* ------------------------------------------------------------------ */
/* Расширение как «подключённый аккаунт»                                */
/*                                                                     */
/* Авторизация Telegram остаётся в браузере (расширение читает DOM      */
/* открытой вкладки), а панель сервера становится пультом: задаёт       */
/* белый список чатов и румов, видит статус, счётчики и ошибки.         */
/* Храним в KV (в parcel он уже есть), миграция не нужна.               */
/* ------------------------------------------------------------------ */

const EXT_CONFIG_KEY = 'ext:config';
const EXT_CLIENTS_KEY = 'ext:clients';
/** Сколько аккаунтов (браузеров) помним и как давно не выходившие на связь выбрасываем. */
const EXT_CLIENTS_MAX = 20;
const EXT_CLIENT_STALE_MS = 14 * 24 * 3600 * 1000;

/** Чат и рум (топик), которые расширение видело последними. */
export interface ExtensionChatRef {
  chatKey?: string | null;
  title?: string | null;
  username?: string | null;
  kind?: string | null;
  groupTitle?: string | null;
  topicTitle?: string | null;
  topicId?: number | null;
  whitelisted?: boolean;
  at?: string | null;
}

/** Как идёт автообход чатов (расширение само переключает чаты и румы). */
export interface ExtensionWalkRef {
  on?: boolean;
  /** сколько чатов и румов в плане */
  plan?: number | null;
  /** где сейчас и куда дальше */
  current?: string | null;
  next?: string | null;
  /** через сколько секунд переход (0 — как дочитает чат) */
  nextInSec?: number | null;
  /** сколько переходов сделал за последний час и какой предел */
  switchesHour?: number | null;
  switchesLimit?: number | null;
  note?: string | null;
  /** последние переходы: цель, открылся ли, чем кончилось */
  log?: Array<{ at: string; label: string; ok: boolean | null; note: string }>;
}

/** Один подключённый браузер с расширением. */
export interface ExtensionClient {
  clientId: string;
  collector?: string | null;
  at: string;
  url?: string | null;
  chat?: ExtensionChatRef | null;
  counters?: Record<string, number> | null;
  status?: string | null;
  error?: string | null;
  pending?: number;
  unreadable?: boolean;
  whitelist?: string[];
  intervalSec?: number;
  paused?: boolean;
  walk?: ExtensionWalkRef | null;
}

/** Настройки, которые панель отдаёт расширению. */
export interface ExtensionConfig {
  /**
   * Чаты и румы: 'Граница', 't.me/granica_es', 'Граница :: Очередь BY-PL',
   * 'Граница :: 7' или ссылка на рум 't.me/travelersminsk/91529'.
   */
  whitelist: string[];
  intervalSec: number | null;
  paused: boolean | null;
  /**
   * Автообход: расширение само открывает чаты и румы из белого списка
   * со случайными паузами (null — не трогаем локальную настройку клиента).
   */
  autoWalk?: boolean | null;
  /** сколько проходов прочитать в чате, прежде чем уйти дальше */
  walkReadsPerChat?: number | null;
  /** случайная пауза перед переходом: от… */
  walkMinSec?: number | null;
  /** …до */
  walkMaxSec?: number | null;
  /** предел переходов в час */
  walkMaxPerHour?: number | null;
  /** не переключать чат, пока пользователь сам работает во вкладке (с) */
  walkIdleGuardSec?: number | null;
  updatedAt: string;
}

async function kvGetJson<T>(env: Env, key: string): Promise<T | null> {
  try {
    const raw = await env.KV.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function strOrNull(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, max);
  return s || null;
}

/**
 * Привести то, что прислала панель, к безопасному виду.
 * Белый список обязателен (иначе null — панель получит 400).
 */
export function normalizeExtensionConfig(raw: unknown): ExtensionConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const rawList = Array.isArray(src.whitelist)
    ? src.whitelist
    : (typeof src.whitelist === 'string' ? src.whitelist.split(/[\n,;]+/) : null);
  if (!rawList) return null;
  const whitelist = rawList
    .map((x) => String(x ?? '').trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 50);
  const rawInterval = src.intervalSec == null ? null : Number(src.intervalSec);
  const intervalSec = rawInterval != null && Number.isFinite(rawInterval)
    ? Math.min(600, Math.max(60, Math.round(rawInterval)))
    : null;

  // Автообход: те же границы, что и у клиента (extension/core.js withDefaults) —
  // панель не должна уметь задать темп, который клиент сочтёт безумным.
  const num = (v: unknown, min: number, max: number): number | null => {
    if (v == null || v === '') return null;
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
  };
  const walkMinSec = num(src.walkMinSec, 10, 3600);
  const walkMaxSec = num(src.walkMaxSec, 10, 7200);
  return {
    whitelist,
    intervalSec,
    paused: typeof src.paused === 'boolean' ? src.paused : null,
    autoWalk: typeof src.autoWalk === 'boolean' ? src.autoWalk : null,
    walkReadsPerChat: num(src.walkReadsPerChat, 1, 20),
    walkMinSec,
    // «до» не может быть меньше «от»
    walkMaxSec: walkMinSec != null && walkMaxSec != null && walkMaxSec < walkMinSec ? walkMinSec : walkMaxSec,
    walkMaxPerHour: num(src.walkMaxPerHour, 1, 600),
    walkIdleGuardSec: num(src.walkIdleGuardSec, 0, 1800),
    updatedAt: new Date().toISOString(),
  };
}

export async function getExtensionConfig(env: Env): Promise<ExtensionConfig | null> {
  return kvGetJson<ExtensionConfig>(env, EXT_CONFIG_KEY);
}

export async function putExtensionConfig(env: Env, raw: unknown): Promise<ExtensionConfig | null> {
  const cfg = normalizeExtensionConfig(raw);
  if (!cfg) return null;
  await env.KV.put(EXT_CONFIG_KEY, JSON.stringify(cfg));
  return cfg;
}

/** Состояние автообхода из отметки расширения (только известные поля, обрезанные). */
function walkOf(raw: unknown): ExtensionWalkRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  const n = (v: unknown): number | null => (Number.isFinite(Number(v)) ? Number(v) : null);
  const log = Array.isArray(w.log)
    ? w.log.slice(0, 12).map((item) => {
        const r = (item ?? {}) as Record<string, unknown>;
        return {
          at: strOrNull(r.at, 40) ?? '',
          label: strOrNull(r.label, 120) ?? '',
          ok: typeof r.ok === 'boolean' ? r.ok : null,
          note: strOrNull(r.note, 200) ?? '',
        };
      })
    : [];
  return {
    on: typeof w.on === 'boolean' ? w.on : false,
    plan: n(w.plan),
    current: strOrNull(w.current, 160),
    next: strOrNull(w.next, 160),
    nextInSec: n(w.nextInSec),
    switchesHour: n(w.switchesHour),
    switchesLimit: n(w.switchesLimit),
    note: strOrNull(w.note, 300),
    log,
  };
}

/** Записать отметку расширения («аккаунт подключён, вижу такой-то чат»). */
export async function recordExtensionClient(env: Env, raw: unknown): Promise<ExtensionClient | null> {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const clientId = strOrNull(src.clientId, 64);
  if (!clientId) return null;

  const chat = (src.chat && typeof src.chat === 'object' ? src.chat : null) as Record<string, unknown> | null;
  const counters = (src.counters && typeof src.counters === 'object' ? src.counters : null) as Record<string, number> | null;
  const client: ExtensionClient = {
    clientId,
    collector: strOrNull(src.collector, 64),
    at: strOrNull(src.at, 40) ?? new Date().toISOString(),
    url: strOrNull(src.url, 300),
    chat: chat
      ? {
          chatKey: strOrNull(chat.chatId ?? chat.chatKey, 64),
          title: strOrNull(chat.title, 120),
          username: strOrNull(chat.username, 64),
          kind: strOrNull(chat.kind, 20),
          groupTitle: strOrNull(chat.groupTitle, 120),
          topicTitle: strOrNull(chat.topicTitle, 120),
          topicId: chat.topicId == null ? null : Number(chat.topicId),
          whitelisted: Boolean(chat.whitelisted),
          at: strOrNull(chat.at, 40),
        }
      : null,
    counters,
    status: strOrNull(src.status, 300),
    error: strOrNull(src.error, 500),
    pending: Number.isFinite(Number(src.pending)) ? Number(src.pending) : 0,
    unreadable: Boolean(src.unreadable),
    whitelist: Array.isArray(src.whitelist) ? src.whitelist.map((x) => String(x).slice(0, 200)).slice(0, 50) : [],
    intervalSec: Number.isFinite(Number(src.intervalSec)) ? Number(src.intervalSec) : undefined,
    paused: typeof src.paused === 'boolean' ? src.paused : undefined,
    walk: walkOf(src.walk),
  };

  const map = (await kvGetJson<Record<string, ExtensionClient>>(env, EXT_CLIENTS_KEY)) ?? {};
  map[clientId] = client;
  const now = Date.now();
  const fresh = Object.values(map)
    .filter((c) => {
      const t = Date.parse(c?.at ?? '');
      return !Number.isFinite(t) || now - t < EXT_CLIENT_STALE_MS;
    })
    .sort((a, b) => Date.parse(b.at ?? '') - Date.parse(a.at ?? ''))
    .slice(0, EXT_CLIENTS_MAX);
  const out: Record<string, ExtensionClient> = {};
  for (const c of fresh) out[c.clientId] = c;
  await env.KV.put(EXT_CLIENTS_KEY, JSON.stringify(out), { expirationTtl: 30 * 24 * 3600 });
  return client;
}

export async function listExtensionClients(env: Env): Promise<ExtensionClient[]> {
  const map = (await kvGetJson<Record<string, ExtensionClient>>(env, EXT_CLIENTS_KEY)) ?? {};
  return Object.values(map).sort((a, b) => Date.parse(b.at ?? '') - Date.parse(a.at ?? ''));
}

/* ------------------------------------------------------------------ */
/* Журнал приёма: что пришло от расширения и чем стало                  */
/* ------------------------------------------------------------------ */

/** Строка журнала: сообщение → заявка / дубль / отсеяно + ссылка на сообщение. */
export interface IngestLogRow {
  chatId: string;
  messageId: number;
  seenAt: string;
  listingId: string | null;
  status: string | null;
  type: string | null;
  fromCity: string | null;
  toCity: string | null;
  departureDate: string | null;
  origin: ListingOrigin | null;
  /** Ссылка на сообщение: t.me/<username>/<id> или служебная t.me/c/<id>/<id>. */
  link: string | null;
  /**
   * Чем стало сообщение: 'created' — из него создана заявка,
   * 'duplicate' — заявка уже была (это дубль, ссылка ведёт на чужую карточку),
   * 'none' — сообщение обработано, но заявки нет (отсев или откат).
   */
  kind: 'created' | 'duplicate' | 'none';
}

/**
 * Последние обработанные сообщения (tg_seen) вместе с тем, во что они превратились.
 * Ссылка строится та же, что на сайте: для публичных чатов — открытая,
 * для приватных супергрупп — служебная t.me/c/… (открывается у участников).
 */
export async function listIngestLog(env: Env, limit = 50): Promise<IngestLogRow[]> {
  const n = Math.min(200, Math.max(1, Math.round(limit)));
  const links = await getChatLinks(env).catch(() => ({}) as Record<string, string>);
  const res = await env.DB.prepare(
    `SELECT s.chat_id AS chatId, s.message_id AS messageId, s.seen_at AS seenAt, s.listing_id AS listingId,
            l.status AS status, l.type AS type, l.from_city AS fromCity, l.to_city AS toCity,
            l.departure_date AS departureDate, l.origin AS origin,
            l.source_chat_id AS lChatId, l.source_message_id AS lMessageId,
            l.source_topic_id AS lTopicId
       FROM tg_seen s
       LEFT JOIN listings l ON l.id = s.listing_id
      ORDER BY s.seen_at DESC, s.message_id DESC
      LIMIT ?`
  ).bind(n).all();

  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map((r) => {
    const chatId = String(r.chatId ?? '');
    const messageId = Number(r.messageId ?? 0);
    const origin = (r.origin as ListingOrigin | null) ?? null;
    const listingId = typeof r.listingId === 'string' ? r.listingId : null;
    // заявка «своя», если она создана ровно из этого сообщения; иначе это дубль
    const ownListing = listingId !== null &&
      String(r.lChatId ?? '') === chatId && Number(r.lMessageId ?? 0) === messageId;
    const kind: IngestLogRow['kind'] = listingId === null ? 'none' : (ownListing ? 'created' : 'duplicate');
    return {
      chatId,
      messageId,
      seenAt: String(r.seenAt ?? ''),
      listingId,
      kind,
      status: typeof r.status === 'string' ? r.status : null,
      type: typeof r.type === 'string' ? r.type : null,
      fromCity: typeof r.fromCity === 'string' ? r.fromCity : null,
      toCity: typeof r.toCity === 'string' ? r.toCity : null,
      departureDate: typeof r.departureDate === 'string' ? r.departureDate : null,
      origin,
      // рум берём из заявки: у отсеянных сообщений ('none') его не знаем
      link: listingSourceLink(chatId, messageId, links,
        ownListing && r.lTopicId ? Number(r.lTopicId) : null),
    };
  });
}
