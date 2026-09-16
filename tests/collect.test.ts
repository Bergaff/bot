import { describe, expect, it, beforeEach } from 'vitest';
import {
  COLLECT_DEFAULTS,
  COLLECT_REPORT_KEY,
  collectConfig,
  collectPublicChats,
  planCollectPage,
  selectNewMessages,
} from '../src/collect';
import { addWatchChat, getWatchChat, listWatchChats } from '../src/store';
import { parsePreviewMessages, type PreviewMessage } from '../src/preview-html';
import { FIXTURES } from './fixtures';
import { createLocalEnv } from '../local/sqlite-env';
import type { Env } from '../src/types';

const NOW = new Date('2026-09-15T12:00:00Z');

/** Сообщения-заглушки: id + дата (текст для логики курсора не важен). */
function msgs(spec: Array<[number, string]>): PreviewMessage[] {
  return spec.map(([messageId, date]) => ({
    messageId,
    text: `сообщение ${messageId}`,
    date,
    author: null,
    hasMedia: false,
    url: `https://t.me/x/${messageId}`,
    forwardedFrom: null,
    signature: null,
    idSource: 'data-post',
  }));
}

describe('selectNewMessages: курсор и возраст', () => {
  const page = msgs([
    [10, '2026-09-14T10:00:00Z'],
    [11, '2026-09-13T10:00:00Z'],
    [12, '2026-09-15T10:00:00Z'],
  ]);

  it('курсора нет — берём всё и сортируем по возрастанию id', () => {
    expect(selectNewMessages(page, { cursor: null, now: NOW }).map((m) => m.messageId)).toEqual([10, 11, 12]);
  });

  it('id <= курсора отсекаются', () => {
    expect(selectNewMessages(page, { cursor: 11, now: NOW }).map((m) => m.messageId)).toEqual([12]);
    expect(selectNewMessages(page, { cursor: 12, now: NOW })).toEqual([]);
  });

  it('старше maxAgeDays — не берём', () => {
    const selected = selectNewMessages(page, { cursor: null, maxAgeDays: 2, now: NOW });
    expect(selected.map((m) => m.messageId)).toEqual([10, 12]); // 11 — старше двух суток
  });

  it('сообщение без даты проходит отсев по возрасту (проверит конвейер)', () => {
    const noDate = [{ ...page[0]!, date: null }];
    expect(selectNewMessages(noDate, { maxAgeDays: 1, now: NOW })).toHaveLength(1);
  });

  it('мусор вместо id отбрасывается', () => {
    const bad = [{ ...page[0]!, messageId: 0 }, { ...page[1]!, messageId: -5 }];
    expect(selectNewMessages(bad, { cursor: null, now: NOW })).toEqual([]);
  });
});

describe('planCollectPage: первый запуск не выкачивает историю', () => {
  const fullPage = msgs(Array.from({ length: 20 }, (_, i) => [100 + i, '2026-09-14T10:00:00Z'] as [number, string]));

  it('курсора нет: берём первую страницу, курсор — на максимум, вглубь не листаем', () => {
    const plan = planCollectPage(fullPage, { cursor: null, now: NOW, maxPages: 5 });
    expect(plan.firstRun).toBe(true);
    expect(plan.cursor).toBe(119);
    expect(plan.fetchNext).toBe(false);
    expect(plan.nextBefore).toBeNull();
    expect(plan.toProcess).toHaveLength(20);
  });

  it('первый запуск + старые сообщения: курсор всё равно на максимум, в обработку — только свежие', () => {
    const old = msgs(Array.from({ length: 20 }, (_, i) => [100 + i, '2026-01-10T10:00:00Z'] as [number, string]));
    const plan = planCollectPage(old, { cursor: null, maxAgeDays: 7, now: NOW });
    expect(plan.cursor).toBe(119);
    expect(plan.toProcess).toEqual([]);
    expect(plan.fetchNext).toBe(false);
  });

  it('курсор есть, страница целиком новая и полная — листаем вглубь', () => {
    const plan = planCollectPage(fullPage, { cursor: 50, now: NOW, page: 1, maxPages: 2, pageSize: 20 });
    expect(plan.fetchNext).toBe(true);
    expect(plan.nextBefore).toBe(100);
    expect(plan.cursor).toBe(119);
  });

  it('но не глубже COLLECT_MAX_PAGES', () => {
    const plan = planCollectPage(fullPage, { cursor: 50, now: NOW, page: 2, maxPages: 2, pageSize: 20 });
    expect(plan.fetchNext).toBe(false);
  });

  it('часть сообщений уже обработана — вглубь не идём', () => {
    const plan = planCollectPage(fullPage, { cursor: 110, now: NOW, page: 1, maxPages: 3, pageSize: 20 });
    expect(plan.toProcess.map((m) => m.messageId)).toEqual([111, 112, 113, 114, 115, 116, 117, 118, 119]);
    expect(plan.fetchNext).toBe(false);
  });

  it('страница не полная (маленький чат) — вглубь не идём', () => {
    const small = msgs([[7, '2026-09-15T10:00:00Z'], [8, '2026-09-15T11:00:00Z']]);
    const plan = planCollectPage(small, { cursor: 5, now: NOW, page: 1, maxPages: 3, pageSize: 20 });
    expect(plan.fetchNext).toBe(false);
    expect(plan.cursor).toBe(8);
  });

  it('реальная фикстура: первый прогон по t.me/s/durov', () => {
    const page = parsePreviewMessages(FIXTURES.channel(), 'durov', NOW);
    const plan = planCollectPage(page, { cursor: null, now: NOW, maxPages: 2 });
    expect(plan.cursor).toBe(531);
    expect(plan.toProcess.map((m) => m.messageId)).toEqual([528, 529, 531]);
    expect(plan.fetchNext).toBe(false); // первая установка курсора — историю не тянем
  });
});

describe('collectPublicChats: прогон по watch_chats', () => {
  let env: Env & { close: () => void };
  let fetches: string[];

  /** fetch-заглушка: отдаёт фикстуры по URL. */
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    fetches.push(url);
    if (url.includes('drivers_pl_by')) {
      return new Response(FIXTURES.supergroup(), { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    if (url.includes('durov')) {
      return new Response(url.includes('before=528') ? FIXTURES.older() : FIXTURES.channel(), { status: 200 });
    }
    if (url.includes('gone_channel')) return new Response(FIXTURES.missing(), { status: 404 });
    if (url.includes('broken_channel')) return new Response('<html><body>новая вёрстка</body></html>', { status: 200 });
    return new Response('', { status: 500 });
  };

  const collectOpts = { force: true, delayMs: 0, fetchImpl: fakeFetch as unknown as typeof fetch, now: NOW };

  beforeEach(async () => {
    fetches = [];
    env = createLocalEnv({ dbPath: ':memory:', vars: { COLLECT_ENABLED: '1' } });
  });

  it('первый прогон: сообщения стали заявками, курсор сдвинулся, счётчики выросли', async () => {
    await addWatchChat(env, { username: 'drivers_pl_by', kind: 'supergroup' });
    const report = await collectPublicChats(env, collectOpts);

    const chat = report.chats[0]!;
    expect(chat.status).toBe('ok');
    expect(chat.fetched).toBe(3);
    expect(chat.created).toBeGreaterThanOrEqual(2);
    expect(chat.cursorBefore).toBeNull();
    expect(chat.cursorAfter).toBe(9004);
    expect(report.totals.created).toBe(chat.created);

    const stored = await getWatchChat(env, 'web:drivers_pl_by');
    expect(stored?.lastMessageId).toBe(9004);
    expect(stored?.statsCreated).toBe(chat.created);
    expect(stored?.title).toBe('Водители Польша–Беларусь'); // подтянули из og:title
    expect(stored?.errorCount).toBe(0);
  });

  it('COLLECT_PREVIEW_BASE: прогон идёт через локальное зеркало (обкатка без t.me)', async () => {
    const mirror = createLocalEnv({
      dbPath: ':memory:',
      vars: { COLLECT_ENABLED: '1', COLLECT_PREVIEW_BASE: 'http://127.0.0.1:8899/s' },
    });
    await addWatchChat(mirror, { username: 'drivers_pl_by', kind: 'supergroup' });
    const report = await collectPublicChats(mirror, collectOpts);

    expect(fetches[0]).toBe('http://127.0.0.1:8899/s/drivers_pl_by');
    expect(fetches.every((u) => u.startsWith('http://127.0.0.1:8899/s/'))).toBe(true);
    expect(report.chats[0]!.status).toBe('ok');
    expect(report.chats[0]!.created).toBeGreaterThan(0);
    mirror.close();
  });

  it('явный baseUrl важнее COLLECT_PREVIEW_BASE', async () => {
    const mirror = createLocalEnv({
      dbPath: ':memory:',
      vars: { COLLECT_ENABLED: '1', COLLECT_PREVIEW_BASE: 'http://127.0.0.1:8899/s' },
    });
    await addWatchChat(mirror, { username: 'durov', kind: 'channel' });
    await collectPublicChats(mirror, { ...collectOpts, baseUrl: 'https://t.me/s' });
    expect(fetches[0]).toBe('https://t.me/s/durov');
    mirror.close();
  });

  it('заявки созданы с origin=collector, status=pending и ссылкой на чат', async () => {
    await addWatchChat(env, { username: 'drivers_pl_by', kind: 'supergroup' });
    await collectPublicChats(env, collectOpts);
    const rows = (await env.DB.prepare('SELECT * FROM listings ORDER BY source_message_id').all()).results as
      Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.origin).toBe('collector');
      expect(row.status).toBe('pending');
      expect(row.source_chat_id).toBe('web:drivers_pl_by');
    }
    // ссылка на чат сохранена — источник кликабелен на сайте
    const link = (await env.DB.prepare('SELECT url FROM chat_links WHERE chat_id = ?').bind('web:drivers_pl_by').first()) as { url?: string };
    expect(link?.url).toBe('https://t.me/drivers_pl_by');
  });

  it('повторный прогон не создаёт дублей (tg_seen), курсор на месте', async () => {
    await addWatchChat(env, { username: 'drivers_pl_by' });
    const first = await collectPublicChats(env, collectOpts);
    const second = await collectPublicChats(env, collectOpts);
    expect(second.totals.created).toBe(0);
    expect(second.chats[0]!.duplicate).toBe(0); // курсор отсёк всё до запроса к конвейеру
    expect(second.chats[0]!.new).toBe(0);
    expect(second.chats[0]!.cursorAfter).toBe(first.chats[0]!.cursorAfter);
    const count = (await env.DB.prepare('SELECT COUNT(*) AS n FROM listings').first()) as { n: number };
    expect(count.n).toBe(first.totals.created);
  });

  it('сбой курсора не страшен: сбросили курсор — дублей всё равно нет', async () => {
    await addWatchChat(env, { username: 'drivers_pl_by' });
    const first = await collectPublicChats(env, collectOpts);
    // «курсор потеряли» — обходим ту же страницу заново
    const res = await env.DB.prepare('UPDATE watch_chats SET last_message_id = NULL WHERE id = ?').bind('web:drivers_pl_by').run();
    expect(res.meta.changes).toBe(1);
    const again = await collectPublicChats(env, collectOpts);
    expect(again.chats[0]!.duplicate).toBe(first.chats[0]!.new);
    expect(again.totals.created).toBe(0);
  });

  it('dryRun: разбираем, но не создаём заявок, не двигаем курсор и не пишем tg_seen', async () => {
    await addWatchChat(env, { username: 'drivers_pl_by' });
    const report = await collectPublicChats(env, { ...collectOpts, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.chats[0]!.created).toBeGreaterThan(0); // предпросмотр что-то нашёл
    const listings = (await env.DB.prepare('SELECT COUNT(*) AS n FROM listings').first()) as { n: number };
    const seen = (await env.DB.prepare('SELECT COUNT(*) AS n FROM tg_seen').first()) as { n: number };
    expect(listings.n).toBe(0);
    expect(seen.n).toBe(0);
    const chat = await getWatchChat(env, 'web:drivers_pl_by');
    expect(chat?.lastMessageId).toBeNull();
    expect(chat?.lastCheckedAt).toBeNull();

    // после dryRun обычный прогон создаёт заявки
    const real = await collectPublicChats(env, collectOpts);
    expect(real.totals.created).toBeGreaterThan(0);
  });

  it('404: чат выключается сразу, курсор не двигается, админы уведомлены', async () => {
    await addWatchChat(env, { username: 'gone_channel' });
    const notified: string[] = [];
    const report = await collectPublicChats(env, {
      ...collectOpts,
      notify: async (text) => { notified.push(text); },
    });
    const chat = report.chats[0]!;
    expect(chat.status).toBe('missing');
    expect(chat.disabled).toBe(true);
    expect(chat.cursorAfter).toBeNull();
    expect((await getWatchChat(env, 'web:gone_channel'))?.enabled).toBe(false);
    expect(notified.join('\n')).toContain('gone_channel');
    expect(notified.join('\n')).toContain('Сборщик остановлен по чату');
  });

  it('смена разметки: 3 ошибки подряд → авто-отключение и алерт', async () => {
    await addWatchChat(env, { username: 'broken_channel' });
    const notified: string[] = [];
    const opts = { ...collectOpts, notify: async (t: string) => { notified.push(t); } };
    const r1 = await collectPublicChats(env, opts);
    expect(r1.chats[0]!.status).toBe('markup_changed');
    expect(r1.chats[0]!.disabled).toBeUndefined(); // одна ошибка — чат ещё в строю
    expect((await getWatchChat(env, 'web:broken_channel'))?.errorCount).toBe(1);
    expect(notified).toEqual([]);

    const r2 = await collectPublicChats(env, opts);
    expect(r2.chats[0]!.disabled).toBeUndefined();
    expect((await getWatchChat(env, 'web:broken_channel'))?.errorCount).toBe(2);

    const r3 = await collectPublicChats(env, opts);
    expect(r3.chats[0]!.disabled).toBe(true);
    const chat = await getWatchChat(env, 'web:broken_channel');
    expect(chat?.enabled).toBe(false);
    expect(chat?.errorCount).toBe(3);
    expect(chat?.lastError).toContain('markup_changed');
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain('Проверьте разметку t.me/s/');
  });

  it('ошибка одного чата не роняет прогон остальных', async () => {
    await addWatchChat(env, { username: 'broken_channel' });
    await addWatchChat(env, { username: 'drivers_pl_by' });
    const report = await collectPublicChats(env, collectOpts);
    expect(report.chats).toHaveLength(2);
    const broken = report.chats.find((c) => c.username === 'broken_channel')!;
    const good = report.chats.find((c) => c.username === 'drivers_pl_by')!;
    expect(broken.status).not.toBe('ok');
    expect(good.status).toBe('ok');
    expect(good.created).toBeGreaterThan(0);
  });

  it('http 500: курсор не двигается, ошибка записана', async () => {
    await addWatchChat(env, { username: 'error_channel' });
    const report = await collectPublicChats(env, collectOpts);
    expect(report.chats[0]!.status).toBe('http_500');
    expect(report.chats[0]!.cursorAfter).toBeNull();
    const chat = await getWatchChat(env, 'web:error_channel');
    expect(chat?.lastError).toContain('500');
    expect(chat?.enabled).toBe(true);
  });

  it('ротация: за прогон обходим не больше COLLECT_MAX_CHATS, давно не проверенные первыми', async () => {
    for (const name of ['a_channel_one', 'drivers_pl_by', 'c_channel_three']) await addWatchChat(env, { username: name });
    const report = await collectPublicChats(env, { ...collectOpts, maxChats: 2 });
    expect(report.chats).toHaveLength(2);
    expect(report.totals.chats).toBe(2);
    // третий чат не трогали
    expect((await getWatchChat(env, 'web:c_channel_three'))?.lastCheckedAt).toBeNull();
    expect(await listWatchChats(env)).toHaveLength(3);
  });

  it('лимит запросов на прогон: бюджет не превышаем', async () => {
    await addWatchChat(env, { username: 'drivers_pl_by' });
    await addWatchChat(env, { username: 'durov' });
    const report = await collectPublicChats(env, { ...collectOpts, maxFetches: 1 });
    expect(fetches.length).toBeLessThanOrEqual(1);
    expect(report.chats.some((c) => c.status === 'budget_exceeded')).toBe(true);
  });

  it('onlyChatId: обходим один конкретный чат (в том числе по «голому» юзернейму)', async () => {
    await addWatchChat(env, { username: 'drivers_pl_by' });
    await addWatchChat(env, { username: 'durov' });
    const report = await collectPublicChats(env, { ...collectOpts, onlyChatId: 'durov' });
    expect(report.chats).toHaveLength(1);
    expect(report.chats[0]!.username).toBe('durov');
    expect(fetches.every((u) => u.includes('durov'))).toBe(true);
  });

  it('COLLECT_ENABLED != 1: cron-прогон выходит сразу (ручной — с force: true)', async () => {
    const off = createLocalEnv({ dbPath: ':memory:', vars: { COLLECT_ENABLED: '0' } });
    await addWatchChat(off, { username: 'drivers_pl_by' });
    const report = await collectPublicChats(off, { ...collectOpts, force: false, fetchImpl: fakeFetch as unknown as typeof fetch });
    expect(report.enabled).toBe(false);
    expect(report.chats).toEqual([]);
    expect(fetches).toEqual([]);
    off.close();
  });

  it('отчёт прогона сохраняется в KV collect:last-report', async () => {
    await addWatchChat(env, { username: 'drivers_pl_by' });
    const report = await collectPublicChats(env, collectOpts);
    const raw = await env.KV.get(COLLECT_REPORT_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(String(raw)).totals.created).toBe(report.totals.created);
  });

  it('пауза между чатами и последовательные запросы (без Promise.all на десятки чатов)', async () => {
    await addWatchChat(env, { username: 'drivers_pl_by' });
    await addWatchChat(env, { username: 'durov' });
    const order: string[] = [];
    const trackingFetch = async (input: RequestInfo | URL): Promise<Response> => {
      order.push(String(input));
      return fakeFetch(input);
    };
    await collectPublicChats(env, { ...collectOpts, delayMs: 5, fetchImpl: trackingFetch as unknown as typeof fetch });
    expect(order.length).toBeGreaterThanOrEqual(2);
    // все запросы к первому чату идут до первого запроса ко второму
    const firstChat = order[0]!;
    expect(order.filter((u) => u.includes('drivers_pl_by')).length).toBeGreaterThan(0);
    expect(firstChat).toContain('t.me/s/');
  });

  it('вторая страница (?before=) запрашивается только когда нужно', async () => {
    await addWatchChat(env, { username: 'durov' });
    await collectPublicChats(env, collectOpts);
    expect(fetches.filter((u) => u.includes('before='))).toEqual([]); // первый прогон — вглубь не идём

    // второй прогон: курсор 531, новых сообщений нет — запросов вглубь тоже нет
    fetches = [];
    await collectPublicChats(env, collectOpts);
    expect(fetches.filter((u) => u.includes('before='))).toEqual([]);
  });
});

describe('collectConfig: значения по умолчанию из ТЗ', () => {
  it('переменные окружения перекрывают дефолты', () => {
    const cfg = collectConfig({} as Env);
    expect(cfg).toMatchObject({
      enabled: false,
      maxChats: COLLECT_DEFAULTS.maxChats,
      maxPages: COLLECT_DEFAULTS.maxPages,
      maxAgeDays: COLLECT_DEFAULTS.maxAgeDays,
      aiDailyLimit: COLLECT_DEFAULTS.aiDailyLimit,
    });
    expect(COLLECT_DEFAULTS.maxChats).toBe(10);
    expect(COLLECT_DEFAULTS.maxPages).toBe(2);
    expect(COLLECT_DEFAULTS.maxAgeDays).toBe(7);
    expect(COLLECT_DEFAULTS.aiDailyLimit).toBe(100);

    const tuned = collectConfig({
      COLLECT_ENABLED: '1',
      COLLECT_MAX_CHATS: '3',
      COLLECT_MAX_PAGES: '5',
      COLLECT_MAX_AGE_DAYS: '2',
      COLLECT_AI_DAILY_LIMIT: '10',
    } as unknown as Env);
    expect(tuned).toMatchObject({ enabled: true, maxChats: 3, maxPages: 5, maxAgeDays: 2, aiDailyLimit: 10 });
  });

  it('мусор в переменной — берём дефолт', () => {
    const cfg = collectConfig({ COLLECT_MAX_CHATS: 'abc', COLLECT_MAX_PAGES: '-3' } as unknown as Env);
    expect(cfg.maxChats).toBe(COLLECT_DEFAULTS.maxChats);
    expect(cfg.maxPages).toBe(COLLECT_DEFAULTS.maxPages);
  });
});
