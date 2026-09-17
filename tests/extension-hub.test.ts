import { describe, expect, it, beforeEach } from 'vitest';
import { createApp } from '../src/server';
import { createLocalEnv } from '../local/sqlite-env';
import {
  listExtensionClients,
  listIngestLog,
  normalizeExtensionConfig,
  recordExtensionClient,
} from '../src/store';
import type { Env } from '../src/types';

/**
 * Панель как пульт расширения (вариант B из ТЗ-ограничений).
 *
 * Авторизация Telegram остаётся в браузере заказчика — расширение читает DOM
 * открытой вкладки. Панель же задаёт белый список чатов и румов, видит статус
 * «аккаунт подключён» и журнал принятого со ссылками на сообщения.
 */

const TOKEN = 'test-ingest-token-abcdef';
const ADMIN = 'test-admin-token';
const NOW = Date.now();

const OFFER = '25.09 Варшава — Брест, возьму посылку до 20 кг, +48 579 264 254';
const PASSENGER = 'Кто подвезёт пассажира из Гродно в Минск сегодня вечером?';

describe('панель как пульт расширения', () => {
  let env: Env & { close: () => void };
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    env = createLocalEnv({ dbPath: ':memory:', vars: { INGEST_TOKEN: TOKEN, ADMIN_API_TOKEN: ADMIN } });
    app = createApp();
  });

  const req = async (
    path: string,
    opts: { method?: string; token?: string | null; admin?: boolean; body?: unknown } = {}
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    const token = opts.token === undefined ? (opts.admin ? ADMIN : TOKEN) : opts.token;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    return (await app.request(path, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }, env)) as Response;
  };

  it('настройки расширения закрыты токеном приёма (INGEST_TOKEN), а не админским', async () => {
    expect((await req('/api/extension/config', { token: null })).status).toBe(401);
    expect((await req('/api/extension/config', { token: ADMIN })).status).toBe(401);

    const res = await req('/api/extension/config');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, config: null });
  });

  it('без INGEST_TOKEN приём выключен: 503 и настройки, и отметка', async () => {
    const bare = createLocalEnv({ dbPath: ':memory:', vars: { ADMIN_API_TOKEN: ADMIN } });
    const config = await app.request('/api/extension/config', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }, bare);
    expect((config as Response).status).toBe(503);

    const hb = await app.request('/api/extension/heartbeat', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'x' }),
    }, bare);
    expect((hb as Response).status).toBe(503);
    bare.close();
  });

  it('панель задаёт белый список чатов и румов, расширение его забирает', async () => {
    const whitelist = ['Граница', 't.me/granica_es', 'Водители Польша–Беларусь :: Очередь BY-PL', 'Водители Польша–Беларусь :: 7'];
    const put = await req('/api/admin/extension/config', {
      method: 'PUT', admin: true, body: { whitelist, intervalSec: 90, paused: false },
    });
    expect(put.status).toBe(200);
    const saved = ((await put.json()) as { config: { whitelist: string[] } }).config;
    expect(saved.whitelist).toEqual(whitelist);

    const got = (await (await req('/api/extension/config')).json()) as { config: { whitelist: string[]; intervalSec: number; paused: boolean } };
    expect(got.config.whitelist).toEqual(whitelist);
    expect(got.config.intervalSec).toBe(90);
    expect(got.config.paused).toBe(false);
  });

  it('белый список можно прислать и текстом (строка на чат), мусор отклоняется 400', async () => {
    const ok = await req('/api/admin/extension/config', {
      method: 'PUT', admin: true, body: { whitelist: 'Граница\nВодители :: 7' },
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { config: { whitelist: string[] } }).config.whitelist).toEqual(['Граница', 'Водители :: 7']);

    expect((await req('/api/admin/extension/config', { method: 'PUT', admin: true, body: {} })).status).toBe(400);
    expect((await req('/api/admin/extension/config', { method: 'PUT', admin: true, body: { whitelist: 42 } })).status).toBe(400);
  });

  it('интервал опроса зажимается в 60..600 с (ТЗ п. 3)', () => {
    expect(normalizeExtensionConfig({ whitelist: [], intervalSec: 5 })?.intervalSec).toBe(60);
    expect(normalizeExtensionConfig({ whitelist: [], intervalSec: 5000 })?.intervalSec).toBe(600);
    expect(normalizeExtensionConfig({ whitelist: [], intervalSec: null })?.intervalSec).toBeNull();
    // больше 50 записей не храним: белый список — не способ залить мусор в KV
    expect(normalizeExtensionConfig({ whitelist: Array.from({ length: 80 }, (_, i) => `чат ${i}`) })?.whitelist).toHaveLength(50);
    expect(normalizeExtensionConfig(null)).toBeNull();
  });

  it('отметка «аккаунт подключён»: панель видит чат, рум, счётчики и состояние', async () => {
    const hb = await req('/api/extension/heartbeat', {
      method: 'POST',
      body: {
        clientId: 'client-0001',
        collector: 'tg-web-ext/0.9.0',
        at: new Date(NOW).toISOString(),
        url: 'https://web.telegram.org/a/#-1001234567890_7',
        status: 'рум: Очередь BY-PL — прочитано 12 сообщений',
        chat: {
          chatId: 'ext:-1001234567890', title: 'Водители Польша–Беларусь', kind: 'c',
          topicTitle: 'Очередь BY-PL', topicId: 7, whitelisted: true,
        },
        counters: { found: 12, sent: 3, created: 2, duplicate: 1, skipped: 9, runs: 5, errors: 0 },
        whitelist: ['Водители Польша–Беларусь :: 7'],
        intervalSec: 120,
        paused: false,
      },
    });
    expect(hb.status).toBe(200);
    expect(((await hb.json()) as { ok: boolean; clientId: string }).clientId).toBe('client-0001');

    const ext = (await (await req('/api/admin/extension', { admin: true })).json()) as {
      clients: Array<Record<string, any>>; config: unknown; ingestEnabled: boolean;
    };
    expect(ext.ingestEnabled).toBe(true);
    expect(ext.clients).toHaveLength(1);
    const c = ext.clients[0]!;
    expect(c.chat.chatKey).toBe('ext:-1001234567890');
    expect(c.chat.topicTitle).toBe('Очередь BY-PL');
    expect(c.chat.topicId).toBe(7);
    expect(c.counters.created).toBe(2);
    expect(c.status).toContain('Очередь BY-PL');
    expect(c.paused).toBe(false);
  });

  it('отметка без clientId → 400 (панель не должна рисовать анонимные аккаунты)', async () => {
    const res = await req('/api/extension/heartbeat', { method: 'POST', body: { status: 'ok' } });
    expect(res.status).toBe(400);
  });

  it('ответ на отметку несёт настройки панели: один запрос вместо двух', async () => {
    await req('/api/admin/extension/config', { method: 'PUT', admin: true, body: { whitelist: ['Граница :: 7'], paused: true } });
    const hb = await req('/api/extension/heartbeat', { method: 'POST', body: { clientId: 'client-0002' } });
    const body = (await hb.json()) as { config: { whitelist: string[]; paused: boolean } };
    expect(body.config.whitelist).toEqual(['Граница :: 7']);
    expect(body.config.paused).toBe(true);
  });

  it('аккаунтов помним не больше 20, а пропавшие больше 14 дней выпадают', async () => {
    for (let i = 0; i < 25; i++) {
      await recordExtensionClient(env, { clientId: `c-${i}`, at: new Date(NOW + i).toISOString() });
    }
    let clients = await listExtensionClients(env);
    expect(clients).toHaveLength(20);
    expect(clients[0]!.clientId).toBe('c-24'); // свежие первыми

    await recordExtensionClient(env, { clientId: 'c-old', at: new Date(NOW - 15 * 24 * 3600 * 1000).toISOString() });
    clients = await listExtensionClients(env);
    expect(clients.some((c) => c.clientId === 'c-old')).toBe(false);
  });
});

describe('журнал приёма: ссылка на сообщение и защита от дубля', () => {
  let env: Env & { close: () => void };
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    env = createLocalEnv({ dbPath: ':memory:', vars: { INGEST_TOKEN: TOKEN, ADMIN_API_TOKEN: ADMIN } });
    app = createApp();
  });

  const ingest = async (messages: Array<Record<string, unknown>>): Promise<any> => {
    const res = (await app.request('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ collector: 'tg-web-ext/0.9.0', messages }),
    }, env)) as Response;
    expect(res.status).toBe(200);
    return res.json();
  };

  const log = async (): Promise<Array<Record<string, any>>> => {
    const res = (await app.request('/api/admin/ingest/log?limit=20', {
      headers: { Authorization: `Bearer ${ADMIN}` },
    }, env)) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, any>> };
    return body.items;
  };

  const msg = (overrides: Record<string, unknown> = {}) => ({
    chatId: 'ext:-1001234567890',
    chatTitle: 'Водители Польша–Беларусь',
    messageId: 528,
    date: Math.floor(NOW / 1000),
    text: OFFER,
    authorName: 'Андрей',
    ...overrides,
  });

  it('пуст, пока ничего не принято', async () => {
    expect(await log()).toEqual([]);
  });

  it('приватная супергруппа: служебная ссылка t.me/c/<id>/<msg> — её можно открыть и переслать', async () => {
    await ingest([msg()]);
    const items = await log();
    expect(items).toHaveLength(1);
    expect(items[0]!.link).toBe('https://t.me/c/1234567890/528');
    expect(items[0]!.kind).toBe('created');
    expect(items[0]!.status).toBe('pending'); // ТЗ: всё принятое — только в очередь
    expect(items[0]!.origin).toBe('extension');
    expect(items[0]!.fromCity).toBeTruthy();
  });

  it('публичный чат: открытая ссылка t.me/<username>/<msg>', async () => {
    await ingest([msg({ chatId: 'web:drivers_pl_by', chatUrl: 'https://t.me/drivers_pl_by', messageId: 9001 })]);
    const items = await log();
    expect(items[0]!.link).toBe('https://t.me/drivers_pl_by/9001');
  });

  it('то же сообщение второй раз — дубль: новая строка журнала не появляется', async () => {
    const first = await ingest([msg()]);
    expect(first.summary.created).toBe(1);
    const second = await ingest([msg()]);
    expect(second.summary.duplicate).toBe(1);
    expect(second.summary.created).toBe(0);

    const items = await log();
    expect(items).toHaveLength(1);
    expect(items[0]!.messageId).toBe(528);
    expect(items[0]!.kind).toBe('created');
  });

  it('отсеянное (пассажирское) в журнал не попадает: оно не стало заявкой', async () => {
    const res = await ingest([msg({ messageId: 700, text: PASSENGER })]);
    expect(res.summary.skipped).toBe(1);
    expect(await log()).toEqual([]);
  });

  it('store: строка журнала знает, своя ли это заявка или чужая (дубль)', async () => {
    await ingest([msg()]);
    const rows = await listIngestLog(env, 10);
    expect(rows[0]!.kind).toBe('created');
    expect(rows[0]!.listingId).toBeTruthy();
    expect(rows[0]!.link).toBe('https://t.me/c/1234567890/528');
  });
});
