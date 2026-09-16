import { describe, expect, it, beforeEach } from 'vitest';
import { createApp } from '../src/server';
import { INGEST_LIMITS, validateIngestBody, validateIngestMessage } from '../src/routes';
import { createLocalEnv } from '../local/sqlite-env';
import type { Env } from '../src/types';

const TOKEN = 'test-ingest-token-abcdef';
const ADMIN = 'test-admin-token';
const NOW = Date.now();

const OFFER = '25.09 Варшава — Брест, возьму посылку до 20 кг, +48 579 264 254';
const REQUEST = 'Нужно передать документы из Кракова в Минск завтра, до 2 кг, @sergei_i';
const PASSENGER = 'Кто подвезёт пассажира из Гродно в Минск сегодня вечером?';

function msg(overrides: Record<string, unknown> = {}) {
  return {
    chatId: 'web:drivers_pl_by',
    chatTitle: 'Водители Польша–Беларусь',
    chatUrl: 'https://t.me/drivers_pl_by',
    messageId: 12345,
    date: Math.floor(NOW / 1000),
    text: OFFER,
    authorName: 'Adelina Yasiuchenia',
    authorUsername: '@adelina_y',
    ...overrides,
  };
}

describe('POST /api/ingest — контракт (ТЗ п. 4)', () => {
  let env: Env & { close: () => void };
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    env = createLocalEnv({ dbPath: ':memory:', vars: { INGEST_TOKEN: TOKEN, ADMIN_API_TOKEN: ADMIN } });
    app = createApp();
  });

  const post = async (body: unknown, token: string | null = TOKEN, extra: Record<string, string> = {}): Promise<Response> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (token) headers.Authorization = `Bearer ${token}`;
    return app.request('/api/ingest', { method: 'POST', headers, body: JSON.stringify(body) }, env) as Promise<Response>;
  };

  it('200: батч из объявления, дубля и пассажирского — ожидаемый summary', async () => {
    // первое сообщение создаёт заявку
    const first = await post({ messages: [msg()] });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as Record<string, any>;
    expect(firstBody.ok).toBe(true);
    expect(firstBody.summary).toMatchObject({ received: 1, created: 1, duplicate: 0, skipped: 0, invalid: 0 });

    const listingId = firstBody.results[0].listings[0].id;

    // второй батч: дубль + пассажирское + новое объявление
    const res = await post({
      collector: 'tg-web-ext/1.0.0',
      messages: [
        msg({ messageId: 12345 }),                       // дубль
        msg({ messageId: 12346, text: PASSENGER }),        // пассажирское
        msg({ messageId: 12347, text: REQUEST }),          // новое объявление
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.summary).toMatchObject({ received: 3, created: 1, duplicate: 1, skipped: 1, invalid: 0 });

    const byId = Object.fromEntries(body.results.map((r: any) => [r.messageId, r]));
    expect(byId[12345]).toMatchObject({ status: 'duplicate', listingId });
    expect(byId[12346]).toMatchObject({ status: 'skipped', reason: 'passenger' });
    expect(byId[12347]).toMatchObject({ status: 'created' });
    expect(byId[12347].listings[0]).toMatchObject({ type: 'request', origin: 'extension', fromCity: 'Краков', toCity: 'Минск' });

    // cursors — максимальный принятый messageId по каждому chatId
    expect(body.cursors).toEqual({ 'web:drivers_pl_by': 12347 });
  });

  it('заявки всегда pending, origin=extension, уведомление не падает', async () => {
    await post({ messages: [msg()] });
    const row = (await env.DB.prepare('SELECT status, origin, source_chat_id, source_message_id FROM listings').first()) as Record<string, unknown>;
    expect(row).toMatchObject({ status: 'pending', origin: 'extension', source_chat_id: 'web:drivers_pl_by', source_message_id: 12345 });
  });

  it('401 без токена и с неверным токеном', async () => {
    expect((await post({ messages: [msg()] }, null)).status).toBe(401);
    expect((await post({ messages: [msg()] }, 'wrong-token')).status).toBe(401);
  });

  it('503 когда INGEST_TOKEN не задан (фича выключена)', async () => {
    const noToken = createLocalEnv({ dbPath: ':memory:', vars: { ADMIN_API_TOKEN: ADMIN } });
    const res = await app.request('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer whatever' },
      body: JSON.stringify({ messages: [msg()] }),
    }, noToken);
    expect(res.status).toBe(503);
    expect((await res.json() as any).error).toContain('INGEST_TOKEN');
    noToken.close();
  });

  it('400 на мусор: нет messages, не массив, пустой массив, битый JSON', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ messages: 'не массив' })).status).toBe(400);
    expect((await post({ messages: [] })).status).toBe(400);
    const badJson = await app.request('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: '{ не json',
    }, env);
    expect(badJson.status).toBe(400);
  });

  it('413 на 101 сообщение', async () => {
    const messages = Array.from({ length: INGEST_LIMITS.maxMessages + 1 }, (_, i) => msg({ messageId: i + 1 }));
    const res = await post({ messages });
    expect(res.status).toBe(413);
    expect((await res.json() as any).error).toContain(String(INGEST_LIMITS.maxMessages));
  });

  it('ровно 100 сообщений — принимается', async () => {
    const messages = Array.from({ length: INGEST_LIMITS.maxMessages }, (_, i) => msg({ messageId: i + 1, text: PASSENGER }));
    const res = await post({ messages });
    expect(res.status).toBe(200);
    expect((await res.json() as any).summary.received).toBe(100);
  });

  it('invalid-сообщение не роняет батч: остальные обрабатываются', async () => {
    const res = await post({
      messages: [
        { chatId: 'web:x', text: OFFER },                 // нет messageId → invalid
        { messageId: 5, text: OFFER },                    // нет chatId → invalid
        msg({ messageId: 77 }),                           // валидное
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.summary).toMatchObject({ received: 3, invalid: 2, created: 1 });
    const invalid = body.results.filter((r: any) => r.status === 'invalid');
    expect(invalid).toHaveLength(2);
    expect(invalid.every((r: any) => typeof r.reason === 'string')).toBe(true);
  });

  it('dryRun=true: разбор возвращаем, заявок и tg_seen нет', async () => {
    const res = await post({ dryRun: true, messages: [msg()] });
    const body = await res.json() as any;
    expect(body.dryRun).toBe(true);
    expect(body.summary.created).toBe(1);
    expect(body.results[0].fields[0]).toMatchObject({ type: 'offer', fromCity: 'Варшава', toCity: 'Брест' });
    expect(body.results[0].listings).toBeUndefined();

    const listings = (await env.DB.prepare('SELECT COUNT(*) AS n FROM listings').first()) as { n: number };
    const seen = (await env.DB.prepare('SELECT COUNT(*) AS n FROM tg_seen').first()) as { n: number };
    expect([listings.n, seen.n]).toEqual([0, 0]);

    // последующий обычный запрос создаёт заявку
    const real = await post({ messages: [msg()] });
    expect((await real.json() as any).summary.created).toBe(1);
  });

  it('chatUrl сохраняется в chat_links; приватный ext:* остаётся без ссылки', async () => {
    await post({ messages: [msg(), msg({ messageId: 555, chatId: 'ext:-100777', chatUrl: null })] });
    const web = (await env.DB.prepare('SELECT url FROM chat_links WHERE chat_id = ?').bind('web:drivers_pl_by').first()) as { url?: string };
    expect(web?.url).toBe('https://t.me/drivers_pl_by');
    const ext = (await env.DB.prepare('SELECT url FROM chat_links WHERE chat_id = ?').bind('ext:-100777').first()) as { url?: string } | null;
    expect(ext).toBeNull();
  });

  it('то же объявление другим сообщением — duplicate с пояснением, заявка одна', async () => {
    const first = await post({ messages: [msg({ messageId: 700 })] });
    const firstBody = await first.json() as Record<string, any>;
    const listingId = firstBody.results[0].listings[0].id;

    // водитель повторил объявление на следующий день: messageId другой, tg_seen молчит
    const res = await post({ messages: [msg({ messageId: 701, date: Math.floor(NOW / 1000) + 86400 })] });
    const body = await res.json() as Record<string, any>;
    expect(body.summary).toMatchObject({ received: 1, created: 0, duplicate: 1, listings: 0 });
    expect(body.results[0]).toMatchObject({ status: 'duplicate', listingId, duplicateOf: [listingId] });
    expect(typeof body.results[0].duplicateWhy).toBe('string');
    expect(body.results[0].duplicateWhy.length).toBeGreaterThan(0);

    const rows = (await env.DB.prepare('SELECT COUNT(*) AS n FROM listings').first()) as { n: number };
    expect(Number(rows.n)).toBe(1);
  });

  it('старые сообщения (>3 дней) отсеиваются как too_old', async () => {
    const oldDate = Math.floor(NOW / 1000) - 10 * 86400;
    const res = await post({ messages: [msg({ date: oldDate })] });
    const body = await res.json() as any;
    expect(body.results[0]).toMatchObject({ status: 'skipped', reason: 'too_old' });
  });

  it('429 на 61-й запрос за час + Retry-After', async () => {
    let lastStatus = 200;
    for (let i = 0; i <= INGEST_LIMITS.rateMax; i++) {
      const res = await post({ messages: [msg({ messageId: 1000 + i, text: PASSENGER })] });
      lastStatus = res.status;
      if (res.status === 429) {
        expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
        expect((await res.json() as any).error).toBe('rate_limited');
        break;
      }
    }
    expect(lastStatus).toBe(429);
  });

  it('CORS: preflight OPTIONS с origin web.telegram.org → 204 + заголовки', async () => {
    const res = await app.request('/api/ingest', {
      method: 'OPTIONS',
      headers: { Origin: 'https://web.telegram.org', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, authorization' },
    }, env);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://web.telegram.org');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('CORS: обычный POST отдаёт Allow-Origin для origin расширения', async () => {
    const res = await post({ messages: [msg()] }, TOKEN, { Origin: 'https://web.telegram.org' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://web.telegram.org');
  });

  it('GET /api/ingest/status — жив ли приём', async () => {
    const res = await app.request('/api/ingest/status', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json() as any).toMatchObject({ enabled: true });
  });
});

describe('валидация тела и сообщения (чистые функции)', () => {
  it('validateIngestBody: лимиты батча', () => {
    expect(validateIngestBody(null).status).toBe(400);
    expect(validateIngestBody([]).status).toBe(400);
    expect(validateIngestBody({ messages: [] }).status).toBe(400);
    expect(validateIngestBody({ messages: Array.from({ length: 101 }, () => ({})) }).status).toBe(413);
    expect(validateIngestBody({ messages: [msg()] }).status).toBeUndefined();
  });

  it('validateIngestMessage: обязательные поля и обрезка длинных', () => {
    expect(validateIngestMessage({ text: OFFER }).error).toContain('chatId');
    expect(validateIngestMessage({ chatId: 'web:x', text: OFFER }).error).toContain('messageId');
    expect(validateIngestMessage({ chatId: 'web:x', messageId: 0, text: OFFER }).error).toContain('messageId');
    expect(validateIngestMessage({ chatId: 'web:x', messageId: 1 }).error).toContain('text');

    const ok = validateIngestMessage(msg({ chatTitle: 'x'.repeat(300), authorUsername: 'user' }));
    expect(ok.value?.chatTitle?.length).toBe(INGEST_LIMITS.maxChatTitle);
    expect(ok.value?.authorUsername).toBe('@user');
  });

  it('chatUrl не из t.me отбрасывается (не портит chat_links)', () => {
    expect(validateIngestMessage(msg({ chatUrl: 'https://evil.example/x' })).value?.chatUrl).toBeNull();
    expect(validateIngestMessage(msg({ chatUrl: 'https://t.me/durov' })).value?.chatUrl).toBe('https://t.me/durov');
  });
});

describe('админ-API авто-сбора под Bearer ADMIN_API_TOKEN', () => {
  let env: Env & { close: () => void };
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    env = createLocalEnv({ dbPath: ':memory:', vars: { ADMIN_API_TOKEN: ADMIN, INGEST_TOKEN: TOKEN } });
    app = createApp();
  });
  const admin = async (method: string, path: string, body?: unknown): Promise<Response> =>
    app.request(path, {
      method,
      headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env) as Promise<Response>;

  it('401 без админского токена', async () => {
    const res = await app.request('/api/admin/watch-chats', {}, env);
    expect(res.status).toBe(401);
  });

  it('POST/GET/PUT/DELETE watch-chats — полный цикл', async () => {
    const created = await admin('POST', '/api/admin/watch-chats', { username: '@durov', kind: 'channel', title: 'Pavel Durov' });
    expect(created.status).toBe(200);
    const chat = (await created.json() as any).chat;
    expect(chat.id).toBe('web:durov');
    expect(chat.username).toBe('durov'); // @ срезан
    expect(chat.enabled).toBe(true);
    expect(chat.lastMessageId).toBeNull();

    // ссылка на источник сразу записана
    const link = (await env.DB.prepare('SELECT url FROM chat_links WHERE chat_id = ?').bind('web:durov').first()) as { url?: string };
    expect(link?.url).toBe('https://t.me/durov');

    // дубль → 409
    expect((await admin('POST', '/api/admin/watch-chats', { username: 'durov' })).status).toBe(409);
    // мусор → 400
    expect((await admin('POST', '/api/admin/watch-chats', { username: 'не юзернейм!' })).status).toBe(400);

    const list = (await admin('GET', '/api/admin/watch-chats').then((r) => r.json())) as any;
    expect(list.chats).toHaveLength(1);

    const put = await admin('PUT', '/api/admin/watch-chats/web:durov', { enabled: false, last_message_id: 100 });
    expect(((await put.json()) as any).chat).toMatchObject({ enabled: false, lastMessageId: 100 });

    // сброс курсора
    const reset = await admin('PUT', '/api/admin/watch-chats/web:durov', { last_message_id: null });
    expect(((await reset.json()) as any).chat.lastMessageId).toBeNull();

    expect((await admin('PUT', '/api/admin/watch-chats/web:durov', { last_message_id: -5 })).status).toBe(400);
    expect((await admin('PUT', '/api/admin/watch-chats/web:nope', { enabled: true })).status).toBe(404);

    const del = await admin('DELETE', '/api/admin/watch-chats/web:durov');
    expect(del.status).toBe(200);
    expect((await admin('DELETE', '/api/admin/watch-chats/web:durov')).status).toBe(404);
  });

  it('GET /api/admin/collect/status — сводка по источникам и квоте', async () => {
    const res = await admin('GET', '/api/admin/collect/status');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ ok: true, ingestTokenSet: true });
    expect(body.listingsByOrigin).toMatchObject({ bot: 0, collector: 0, extension: 0 });
    expect(body.watchChats).toMatchObject({ total: 0, enabled: 0 });
    expect(body.ai).toHaveProperty('collectLeft');
  });

  it('POST /api/admin/collect: ручной прогон работает при COLLECT_ENABLED=0, dryRun ничего не пишет', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync(new URL('./fixtures/tme-s-supergroup.html', import.meta.url), 'utf8');
    const realFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }) as unknown as typeof fetch;

    try {
      await admin('POST', '/api/admin/watch-chats', { username: 'drivers_pl_by', kind: 'supergroup' });

      // COLLECT_ENABLED в env не задан — ручной запуск из админки всё равно работает
      const dry = await admin('POST', '/api/admin/collect', { dryRun: true });
      expect(dry.status).toBe(200);
      const dryBody = await dry.json() as any;
      expect(dryBody.report.dryRun).toBe(true);
      expect(dryBody.report.chats[0].created).toBeGreaterThan(0); // предпросмотр нашёл объявления
      expect(requested[0]).toContain('https://t.me/s/drivers_pl_by');

      const listings = (await env.DB.prepare('SELECT COUNT(*) AS n FROM listings').first()) as { n: number };
      expect(listings.n).toBe(0);
      expect(((await admin('GET', '/api/admin/watch-chats').then((r) => r.json())) as any).chats[0].lastMessageId).toBeNull();

      // обычный прогон: заявки созданы, курсор сдвинут, отчёт лёг в KV
      const real = await admin('POST', '/api/admin/collect', { chatId: 'drivers_pl_by' });
      const realBody = await real.json() as any;
      expect(realBody.report.chats[0].status).toBe('ok');
      expect(realBody.report.chats[0].cursorAfter).toBe(9004);
      const after = (await env.DB.prepare('SELECT COUNT(*) AS n FROM listings').first()) as { n: number };
      expect(after.n).toBeGreaterThan(0);
      expect(await env.KV.get('collect:last-report')).toBeTruthy();

      // статус показывает последний отчёт
      const status = (await admin('GET', '/api/admin/collect/status').then((r) => r.json())) as any;
      expect(status.lastReport.totals.created).toBe(realBody.report.totals.created);
      expect(status.listingsByOrigin.collector).toBe(realBody.report.totals.created);
      expect(status.watchChats).toMatchObject({ total: 1, enabled: 1 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
