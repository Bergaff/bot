import { Hono } from 'hono';
import { aiQuotaLeft } from './ai.ts';
import { collectPublicChats, lastCollectReport } from './collect.ts';
import { ingestMessage, normalizeAt, parseMessageDate } from './ingest.ts';
import { normalizeUsername } from './preview.ts';
import {
  addWatchChat,
  bumpIngestDailyStats,
  countByOrigin,
  deleteWatchChat,
  getIngestDailyStats,
  getWatchChat,
  listWatchChats,
  patchWatchChat,
  upsertChatLink,
} from './store.ts';
import type { Env, ListingOrigin } from './types.ts';
import { rateLimit } from './util.ts';

/**
 * HTTP-слой ТЗ: POST /api/ingest (вариант B) и админ-API авто-сбора (п. 3.6).
 *
 * В `Bergaff/parcel` эти роуты добавляются в существующий src/index.ts:
 *   registerIngestRoutes(app)  — ДО app.use('/api/admin/*') (своя авторизация);
 *   registerAdminCollectRoutes(app) — ПОСЛЕ него (Bearer ADMIN_API_TOKEN).
 * CORS-middleware на '/api/*' уже отдаёт нужные заголовки для web.telegram.org.
 */

/* ------------------------------------------------------------------ */
/* Вариант B: приём сообщений из браузерного расширения                */
/* ------------------------------------------------------------------ */

/** Сообщение в батче расширения (контракт ТЗ п. 4.3). */
export interface IngestMessagePayload {
  chatId: string;
  messageId: number;
  text: string;
  chatTitle?: string | null;
  chatUrl?: string | null;
  date?: number | string | null;
  authorName?: string | null;
  authorUsername?: string | null;
}

export interface IngestBody {
  collector?: string;
  dryRun?: boolean;
  messages?: IngestMessagePayload[];
}

/** Ограничения контракта. */
export const INGEST_LIMITS = {
  maxMessages: 100,
  maxText: 4000,
  maxChatId: 64,
  maxChatTitle: 120,
  maxChatUrl: 200,
  maxAuthorName: 120,
  maxAuthorUsername: 64,
  maxCollector: 64,
  /** Запросов в час на один токен. */
  rateMax: 60,
  rateWindowSec: 3600,
  /** Сколько дней хранения у сообщений расширения (ТЗ п. 4.3). */
  defaultMaxAgeDays: 3,
} as const;

export interface IngestResultItem {
  chatId: string;
  messageId: number | null;
  status: 'created' | 'duplicate' | 'skipped' | 'invalid';
  reason?: string;
  listingId?: string | null;
  listings?: Array<{
    id: string;
    type: string;
    fromCity: string;
    toCity: string;
    departureDate: string | null;
    source: string;
    origin: ListingOrigin;
  }>;
  /** Дубль по смыслу (src/dedupe.ts): ids заявок, которые уже были. */
  duplicateOf?: string[] | null;
  /** Почему решено, что это дубль, — для лога расширения и разбора полётов. */
  duplicateWhy?: string | null;
  /** Заявка создана, но рядом есть похожая: модератору стоит взглянуть (kind='similar'). */
  similarTo?: { id: string; why: string } | null;
  /** dryRun: что разобрал конвейер (заявки при этом не создаются). */
  fields?: Array<{
    type: string;
    fromCity: string;
    toCity: string;
    departureDate: string | null;
    description: string;
  }>;
}

export interface IngestSummary {
  received: number;
  created: number;
  duplicate: number;
  skipped: number;
  invalid: number;
  listings: number;
}

export interface IngestResponse {
  ok: boolean;
  dryRun: boolean;
  summary: IngestSummary;
  results: IngestResultItem[];
  /** Максимальный принятый messageId по каждому chatId — локальный курсор клиента. */
  cursors: Record<string, number>;
  error?: string;
}

/** Одно сообщение батча: что не так (null — сообщение валидно). */
export function validateIngestMessage(raw: unknown): {
  value?: IngestMessagePayload;
  error?: string;
  /** Если поле просто «не то» — отбрасываем его, а не всё сообщение. */
} {
  if (typeof raw !== 'object' || raw === null) return { error: 'message must be an object' };
  const b = raw as Record<string, unknown>;

  const chatId = typeof b.chatId === 'string' ? b.chatId.trim() : '';
  if (!chatId || chatId.length > INGEST_LIMITS.maxChatId) {
    return { error: 'chatId: string 1..64 required' };
  }
  const messageId = typeof b.messageId === 'number' ? b.messageId : Number(b.messageId);
  if (!Number.isInteger(messageId) || messageId <= 0) {
    return { error: 'messageId: integer > 0 required' };
  }
  if (typeof b.text !== 'string') return { error: 'text: string required' };

  const str = (value: unknown, max: number): string | null => {
    if (typeof value !== 'string') return null;
    const clean = value.trim();
    if (!clean) return null;
    return clean.length > max ? clean.slice(0, max) : clean;
  };

  const chatUrl = str(b.chatUrl, INGEST_LIMITS.maxChatUrl);
  return {
    value: {
      chatId,
      messageId,
      text: b.text,
      chatTitle: str(b.chatTitle, INGEST_LIMITS.maxChatTitle),
      // ссылка на чат — только публичная t.me, иначе не сохраняем (как в PUT /api/admin/chat-links)
      chatUrl: chatUrl && /^https:\/\/t\.me\//.test(chatUrl) ? chatUrl : null,
      date: typeof b.date === 'number' || typeof b.date === 'string' ? b.date : null,
      authorName: str(b.authorName, INGEST_LIMITS.maxAuthorName),
      authorUsername: normalizeAt(str(b.authorUsername, INGEST_LIMITS.maxAuthorUsername)),
    },
  };
}

/** Тело запроса /api/ingest: батч, флаги, ошибки формата. */
export function validateIngestBody(raw: unknown): {
  body?: Required<Pick<IngestBody, 'dryRun'>> & { collector: string | null; messages: unknown[] };
  status?: 400 | 413;
  error?: string;
} {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { status: 400, error: 'body must be a JSON object' };
  }
  const b = raw as Record<string, unknown>;
  const messages = b.messages;
  if (!Array.isArray(messages)) return { status: 400, error: 'messages: array required' };
  if (messages.length === 0) return { status: 400, error: 'messages: at least 1 message required' };
  if (messages.length > INGEST_LIMITS.maxMessages) {
    return { status: 413, error: `messages: max ${INGEST_LIMITS.maxMessages} per request` };
  }
  const collector = typeof b.collector === 'string' ? b.collector.slice(0, INGEST_LIMITS.maxCollector) : null;
  return { body: { dryRun: b.dryRun === true, collector, messages } };
}

/** Ответ 429: сколько секунд ждать до следующего окна лимита. */
function retryAfterSec(windowSec: number): number {
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / windowSec);
  return Math.max(1, (bucket + 1) * windowSec - now);
}

/**
 * Обработать батч расширения (без HTTP — её можно звать и из CLI, и из тестов).
 * Авторизация и rate limit — на вызывающем слое.
 */
export async function runIngestBatch(
  env: Env,
  rawBody: unknown,
  opts: { maxAgeDays?: number } = {}
): Promise<{ status: 200 | 400 | 413; body: IngestResponse }> {
  const validated = validateIngestBody(rawBody);
  if (!validated.body) {
    return {
      status: validated.status ?? 400,
      body: {
        ok: false,
        dryRun: false,
        summary: { received: 0, created: 0, duplicate: 0, skipped: 0, invalid: 0, listings: 0 },
        results: [],
        cursors: {},
        error: validated.error ?? 'bad request',
      },
    };
  }
  const { dryRun, messages } = validated.body;
  const maxAgeDays = opts.maxAgeDays ?? intOr(env.INGEST_MAX_AGE_DAYS, INGEST_LIMITS.defaultMaxAgeDays);

  const summary: IngestSummary = {
    received: messages.length, created: 0, duplicate: 0, skipped: 0, invalid: 0, listings: 0,
  };
  const results: IngestResultItem[] = [];
  const cursors: Record<string, number> = {};

  // валидные сообщения сортируем по (chatId, messageId ↑) — ТЗ п. 4.4.7
  const valid: Array<{ payload: IngestMessagePayload }> = [];
  for (const raw of messages) {
    const checked = validateIngestMessage(raw);
    const chatId = typeof (raw as Record<string, unknown>)?.chatId === 'string'
      ? String((raw as Record<string, unknown>).chatId)
      : '';
    const messageId = Number((raw as Record<string, unknown>)?.messageId);
    if (chatId) cursors[chatId] = Math.max(cursors[chatId] ?? 0, Number.isFinite(messageId) ? messageId : 0);
    if (!checked.value) {
      summary.invalid++;
      results.push({
        chatId,
        messageId: Number.isInteger(messageId) && messageId > 0 ? messageId : null,
        status: 'invalid',
        reason: checked.error,
      });
      continue;
    }
    valid.push({ payload: checked.value });
  }
  valid.sort((a, b) => {
    if (a.payload.chatId !== b.payload.chatId) return a.payload.chatId < b.payload.chatId ? -1 : 1;
    return a.payload.messageId - b.payload.messageId;
  });

  // своя квота ИИ (ai:ingest:day:*): бюджет бота расширение не съедает
  let quotaLeft = dryRun ? Number.MAX_SAFE_INTEGER : await aiQuotaLeft(env, 'extension').catch(() => 0);

  for (const { payload } of valid) {
    const useAi = dryRun || quotaLeft > 0;
    const res = await ingestMessage(
      env,
      payload.text,
      {
        chatId: payload.chatId,
        chatTitle: payload.chatTitle ?? null,
        messageId: payload.messageId,
        chatUrl: payload.chatUrl,
        authorName: payload.authorName ?? null,
        authorUsername: payload.authorUsername ?? null,
        origin: 'extension',
      },
      {
        maxAgeDays,
        date: payload.date ?? null,
        useAi,
        dryRun,
        aiScope: 'extension',
      }
    );

    const item: IngestResultItem = {
      chatId: payload.chatId,
      messageId: payload.messageId,
      status: res.status,
      reason: res.reason,
    };
    if (res.status === 'created') {
      summary.created++;
      summary.listings += res.listings.length;
      if (!dryRun && useAi && res.source === 'parser') quotaLeft = Math.max(0, quotaLeft - 1);
      if (!dryRun) {
        item.listings = res.listings.map((l) => ({
          id: l.id,
          type: l.type,
          fromCity: l.fromCity,
          toCity: l.toCity,
          departureDate: l.departureDate ?? null,
          source: l.source,
          origin: l.origin ?? 'extension',
        }));
      }
      if (res.duplicateOf?.length) {
        item.duplicateOf = res.duplicateOf;
        item.duplicateWhy = res.duplicateWhy ?? null;
      }
      if (res.similarTo) item.similarTo = res.similarTo;
      if (dryRun && res.fields) {
        item.fields = res.fields.map((f) => ({
          type: f.type,
          fromCity: f.fromCity,
          toCity: f.toCity,
          departureDate: f.departureDate,
          description: f.description,
        }));
      }
    } else if (res.status === 'duplicate') {
      summary.duplicate++;
      item.listingId = res.existingListingId ?? null;
      // дубль бывает двух видов: то же сообщение (tg_seen) и то же объявление
      // другим сообщением (src/dedupe.ts) — второй приходит с пояснением
      item.duplicateOf = res.duplicateOf ?? (res.existingListingId ? [res.existingListingId] : null);
      item.duplicateWhy = res.duplicateWhy ?? null;
    } else if (res.status === 'skipped') {
      summary.skipped++;
    } else {
      summary.invalid++;
    }
    results.push(item);
  }

  if (!dryRun && valid.length > 0) {
    await bumpIngestDailyStats(env, summary.received, summary.listings).catch(() => undefined);
  }

  return {
    status: 200,
    body: { ok: true, dryRun, summary, results, cursors },
  };
}

/** POST /api/ingest — своя авторизация (INGEST_TOKEN), не админская. */
export function registerIngestRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post('/api/ingest', async (c) => {
    const token = c.env.INGEST_TOKEN;
    // секрета нет — фича выключена, расширение должно остановиться и показать ошибку
    if (!token) return c.json({ error: 'ingest disabled: INGEST_TOKEN is not set' }, 503);

    const auth = c.req.header('Authorization') ?? '';
    if (auth !== `Bearer ${token}`) return c.json({ error: 'unauthorized' }, 401);

    // 60 запросов в час на токен (ключ — первые 8 символов, чтобы не логировать токен)
    const rl = await rateLimit(c.env, `ingest:${token.slice(0, 8)}`, INGEST_LIMITS.rateMax, INGEST_LIMITS.rateWindowSec);
    if (!rl.allowed) {
      c.header('Retry-After', String(retryAfterSec(INGEST_LIMITS.rateWindowSec)));
      return c.json({ error: 'rate_limited', limit: INGEST_LIMITS.rateMax, windowSec: INGEST_LIMITS.rateWindowSec }, 429);
    }

    const raw = await c.req.json().catch(() => null);
    if (raw === null) return c.json({ error: 'invalid JSON body' }, 400);

    const { status, body } = await runIngestBatch(c.env, raw);
    if (status !== 200) return c.json(body, status);
    return c.json(body);
  });

  /** Жив ли приём (расширение может проверить токен до первого батча). */
  app.get('/api/ingest/status', async (c) => {
    const enabled = Boolean(c.env.INGEST_TOKEN);
    const stats = enabled ? await getIngestDailyStats(c.env) : { messages: 0, created: 0 };
    return c.json({ enabled, today: stats, aiQuotaLeft: enabled ? await aiQuotaLeft(c.env, 'extension') : 0 });
  });
}

/* ------------------------------------------------------------------ */
/* Вариант A: админ-API авто-сбора (под middleware /api/admin/*)       */
/* ------------------------------------------------------------------ */

export function registerAdminCollectRoutes(app: Hono<{ Bindings: Env }>): void {
  /** Список чатов обхода: курсоры, счётчики, ошибки. */
  app.get('/api/admin/watch-chats', async (c) => {
    try {
      return c.json({ chats: await listWatchChats(c.env) });
    } catch (e) {
      if (String(e).includes('no such table')) {
        return c.json({ chats: [], needsSetup: true, error: 'Примените миграцию 0006_ingest.sql' });
      }
      throw e;
    }
  });

  /** Добавить публичный чат в обход. */
  app.post('/api/admin/watch-chats', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { username?: unknown; kind?: unknown; title?: unknown }
      | null;
    const username = normalizeUsername(typeof body?.username === 'string' ? body.username : '');
    if (!username) {
      return c.json({ error: 'username: нужен публичный юзернейм t.me/<username> (5–32 знака, без @)' }, 400);
    }
    const kind = body?.kind === 'supergroup' ? 'supergroup' : 'channel';
    const title = typeof body?.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : null;
    try {
      const existing = await getWatchChat(c.env, `web:${username}`);
      if (existing) return c.json({ error: 'chat already watched', chat: existing }, 409);
      const chat = await addWatchChat(c.env, { username, kind, title });
      // источник сразу кликабелен на сайте: web:<username> → https://t.me/<username>
      await upsertChatLink(c.env, chat.id, `https://t.me/${username}`).catch(() => undefined);
      return c.json({ ok: true, chat });
    } catch (e) {
      if (String(e).includes('no such table')) {
        return c.json({ error: 'Примените миграцию 0006_ingest.sql (npm run deploy)' }, 500);
      }
      throw e;
    }
  });

  /** Правка чата: вкл/выкл, тип, название, сброс курсора. */
  app.put('/api/admin/watch-chats/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: 'body required' }, 400);
    const patch: Parameters<typeof patchWatchChat>[2] = {};
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (body.kind === 'channel' || body.kind === 'supergroup') patch.kind = body.kind;
    if (typeof body.title === 'string') patch.title = body.title.trim().slice(0, 120) || null;
    if ('last_message_id' in body) {
      const raw = body.last_message_id;
      if (raw === null) patch.lastMessageId = null;
      else {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) return c.json({ error: 'last_message_id: целое число ≥ 0 или null' }, 400);
        patch.lastMessageId = n;
      }
    }
    try {
      const chat = await patchWatchChat(c.env, id, patch);
      if (!chat) return c.json({ error: 'not_found' }, 404);
      return c.json({ ok: true, chat });
    } catch (e) {
      if (String(e).includes('no such table')) return c.json({ error: 'not_found' }, 404);
      throw e;
    }
  });

  /** Убрать чат из обхода (созданные заявки не трогаем). */
  app.delete('/api/admin/watch-chats/:id', async (c) => {
    try {
      const ok = await deleteWatchChat(c.env, c.req.param('id'));
      if (!ok) return c.json({ error: 'not_found' }, 404);
      return c.json({ ok: true });
    } catch (e) {
      if (String(e).includes('no such table')) return c.json({ error: 'not_found' }, 404);
      throw e;
    }
  });

  /** Ручной прогон сборщика: { chatId?, dryRun? }. */
  app.post('/api/admin/collect', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { chatId?: unknown; dryRun?: unknown; force?: unknown }
      | null;
    const chatId = typeof body?.chatId === 'string' && body.chatId.trim() ? body.chatId.trim() : undefined;
    const report = await collectPublicChats(c.env, {
      onlyChatId: chatId,
      dryRun: body?.dryRun === true,
      // ручной запуск работает даже при COLLECT_ENABLED=0
      force: body?.force !== false,
    });
    return c.json({ ok: true, report });
  });

  /** Отчёт последнего прогона + суммарные счётчики. */
  app.get('/api/admin/collect/status', async (c) => {
    const { report, aiUsedToday, errorCount } = await lastCollectReport(c.env);
    const origins = await countByOrigin(c.env);
    const ingestToday = await getIngestDailyStats(c.env);
    let chatsTotal = 0;
    let chatsEnabled = 0;
    try {
      const all = await listWatchChats(c.env);
      chatsTotal = all.length;
      chatsEnabled = all.filter((chat) => chat.enabled).length;
    } catch {
      // таблицы ещё нет
    }
    return c.json({
      ok: true,
      enabled: c.env.COLLECT_ENABLED === '1',
      ingestTokenSet: Boolean(c.env.INGEST_TOKEN),
      watchChats: { total: chatsTotal, enabled: chatsEnabled, withErrors: errorCount },
      ai: {
        collectUsedToday: aiUsedToday,
        collectLimit: intOr(c.env.COLLECT_AI_DAILY_LIMIT, 100),
        collectLeft: await aiQuotaLeft(c.env, 'collect').catch(() => 0),
        ingestLeft: await aiQuotaLeft(c.env, 'extension').catch(() => 0),
      },
      listingsByOrigin: origins,
      extensionToday: ingestToday,
      lastReport: report,
    });
  });
}

function intOr(raw: string | undefined, fallback: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
