/**
 * Тесты оркестратора client-части: extension/content.js (этап 3 ТЗ).
 *
 * content.js запускается в мини-браузере (tests/helpers/fake-browser.ts):
 * поддельные document/localStorage/fetch/таймеры, настоящие core.cjs, dom.cjs
 * и бандл parser.ts. Проверяем поведение, которое обещано в ТЗ:
 *   - белый список: чужие чаты не читаются вовсе;
 *   - на сервер уходит только похожее на объявление, батчами ≤ batchSize;
 *   - режим подтверждения, пауза, счётчики, локальный лог отправленного;
 *   - 401/503 → остановка с внятной ошибкой, 429 → backoff, 4xx-контракт → стоп;
 *   - нечитаемая разметка → «не могу прочитать сообщения», а не тишина.
 */
import { describe, expect, it } from 'vitest';
import { FakeNode, bubble, bubblesList } from './helpers/fake-dom';
import { FakeBrowser, brokenPage, minutesAgoIso } from './helpers/fake-browser';

const CHAT_KEY = 'web:drivers_pl_by';

function okResponse(received = 2, created = 1, duplicate = 1) {
  return {
    status: 200,
    body: {
      ok: true,
      dryRun: false,
      summary: { received, created, duplicate, skipped: 0, invalid: 0, listings: created },
      results: [
        { chatId: CHAT_KEY, messageId: 528, status: 'created', listings: [{ id: 'l-1', origin: 'extension' }] },
        { chatId: CHAT_KEY, messageId: 531, status: 'duplicate', listingId: 'l-1' },
      ],
      cursors: { [CHAT_KEY]: 531 },
    },
  };
}

/** Лента из n объявлений — для проверки нарезки на батчи. */
function offersPage(n: number): FakeNode {
  const chatInfo = new FakeNode('div', { className: 'chat-info' })
    .append(new FakeNode('div', { className: 'peer-title', text: 'Водители Польша–Беларусь' }));
  const list = bubblesList(Array.from({ length: n }, (_, i) => bubble({
    text: `${10 + (i % 20)}.09 Варшава — Брест, возьму посылку №${i} до 20 кг, +48 579 264 ${100 + i}`,
    id: String(1000 + i),
    datetime: minutesAgoIso(60 - (i % 50)),
  })));
  return new FakeNode('div', { className: 'page' }).append(chatInfo, list);
}

describe('запуск в вкладке Telegram Web', () => {
  it('рисует панель, ставит таймер опроса и подключает детект на правилах parser.ts', async () => {
    const b = await new FakeBrowser({ settings: { intervalSec: 180 } }).ready();
    expect(b.panel()).toBeTruthy();
    expect(b.panelText()).toContain('попутка. сбор');
    expect(b.intervalMs[b.intervalMs.length - 1]).toBe(180_000);
    expect(b.logs.join('\n')).toContain('детект на правилах parser.ts');
  });

  it('без сервера и токена ничего не отправляет и подсказывает открыть попап', async () => {
    const b = await new FakeBrowser({ settings: { serverUrl: '', token: '' } }).ready();
    await b.firstTick();
    expect(b.fetchCalls).toHaveLength(0);
    expect(b.panelText()).toContain('Не заданы сервер или INGEST_TOKEN');
    expect(b.saved().sentKeys ?? []).toEqual([]);
  });

  it('с пустым белым списком сообщения не читаются вовсе', async () => {
    const b = await new FakeBrowser({ settings: { whitelist: [] } }).ready();
    b.respond(okResponse());
    await b.firstTick();
    expect(b.fetchCalls).toHaveLength(0);
    expect(b.panelText()).toContain('не в белом списке');
    expect(b.saved().counters?.found ?? 0).toBe(0);
  });
});

describe('проход по чату из белого списка', () => {
  it('один POST /api/ingest с Bearer-токеном и только объявлениями', async () => {
    const b = await new FakeBrowser().ready();
    b.respond(okResponse());
    await b.firstTick();

    expect(b.fetchCalls).toHaveLength(1);
    const call = b.fetchCalls[0]!;
    expect(call.url).toBe('https://pop-utka.app/api/ingest');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers.Authorization).toBe('Bearer secret-token');
    expect(call.init.headers['Content-Type']).toBe('application/json');
    expect(call.init.cache).toBe('no-store');

    const payload = b.lastPayload();
    expect(payload.collector).toBe('tg-web-ext/1.0.0');
    expect(payload.dryRun).toBe(false);
    // болтовня (529) и пассажирская попутка (530) отсеяны ещё в вкладке
    expect(payload.messages.map((m: any) => m.messageId)).toEqual([528, 531]);
    expect(payload.messages[0]).toMatchObject({
      chatId: CHAT_KEY,
      chatUrl: 'https://t.me/drivers_pl_by',
      chatTitle: 'Водители Польша–Беларусь',
      authorUsername: '@sergei_i',
    });
  });

  it('счётчики — в панель и в localStorage, отправленное — в локальный лог', async () => {
    const b = await new FakeBrowser().ready();
    b.respond(okResponse());
    await b.firstTick();

    const saved = b.saved();
    expect(saved.counters).toMatchObject({ found: 4, sent: 2, created: 1, duplicate: 1 });
    expect(saved.sentKeys).toEqual([`${CHAT_KEY}:528`, `${CHAT_KEY}:531`]);
    expect(b.panelText()).toContain('отправлено 2, заявок 1, дублей 1');
  });

  it('повторный проход ничего не отправляет: сработал локальный лог', async () => {
    const b = await new FakeBrowser().ready();
    b.respond(okResponse());
    await b.firstTick();
    expect(b.fetchCalls).toHaveLength(1);

    await b.tick();
    expect(b.fetchCalls).toHaveLength(1);
    expect(b.panelText()).toContain('нового нет');
    expect(b.saved().counters!.runs ?? 0).toBeLessThanOrEqual(1);
  });

  it('то, что уже лежит в логе отправленного, повторно не уходит', async () => {
    const b = await new FakeBrowser({
      stored: { sentKeys: [`${CHAT_KEY}:528`, `${CHAT_KEY}:531`] },
    }).ready();
    b.respond(okResponse());
    await b.firstTick();
    expect(b.fetchCalls).toHaveLength(0);
    expect(b.panelText()).toContain('нового нет');
  });

  it('чат не из белого списка: сообщения не читаются вовсе', async () => {
    const b = await new FakeBrowser({ settings: { whitelist: ['Совершенно другой чат'] } }).ready();
    b.respond(okResponse());
    await b.firstTick();
    expect(b.fetchCalls).toHaveLength(0);
    expect(b.panelText()).toContain('не в белом списке');
    expect(b.saved().counters?.found ?? 0).toBe(0);
  });

  it('приватный чат: ключ ext:… и никакой публичной ссылки', async () => {
    const page = new FakeNode('div', { className: 'page' }).append(
      new FakeNode('div', { className: 'chat-info' })
        .append(new FakeNode('div', { className: 'peer-title', text: 'Семейный чат' })),
      bubblesList([bubble({
        text: 'Передам посылку из Минска в Гродно 20.09, до 5 кг, +375 29 123 45 67',
        id: '77', datetime: minutesAgoIso(10),
      })]),
    );
    const b = await new FakeBrowser({
      url: 'https://web.telegram.org/a/#/im/p-1001234567890',
      page,
      settings: { whitelist: ['Семейный чат'] },
    }).ready();
    b.respond({ status: 200, body: { ok: true, summary: { received: 1, created: 1 }, results: [] } });
    await b.firstTick();

    expect(b.fetchCalls).toHaveLength(1);
    const [message] = b.lastPayload().messages;
    expect(message.chatId).toBe('ext:-1001234567890');
    expect(message).not.toHaveProperty('chatUrl');
    expect(message.chatTitle).toBe('Семейный чат');
  });

  it('режет на батчи не больше batchSize (ТЗ: ~20 сообщений на запрос)', async () => {
    const b = await new FakeBrowser({
      page: offersPage(45),
      settings: { batchSize: 20, maxPerChat: 60 },
    }).ready();
    b.respond({ status: 200, body: { ok: true, summary: { received: 20, created: 20 }, results: [] } });
    await b.firstTick();

    expect(b.fetchCalls).toHaveLength(3);
    expect(b.fetchCalls.map((c) => JSON.parse(c.init.body).messages.length)).toEqual([20, 20, 5]);
  });

  it('maxPerChat ограничивает чтение ленты (не выкачиваем весь чат)', async () => {
    const b = await new FakeBrowser({
      page: offersPage(45),
      settings: { maxPerChat: 5, batchSize: 20 },
    }).ready();
    b.respond({ status: 200, body: { ok: true, summary: { received: 5, created: 5 }, results: [] } });
    await b.firstTick();

    expect(b.fetchCalls).toHaveLength(1);
    expect(b.lastPayload().messages).toHaveLength(5);
    expect(b.saved().counters).toMatchObject({ found: 5 });
  });
});

describe('режим подтверждения и пауза', () => {
  it('confirmMode: сначала спрашивает, отправляет только по клику', async () => {
    const b = await new FakeBrowser({ settings: { confirmMode: true } }).ready();
    b.respond(okResponse());
    await b.firstTick();

    expect(b.fetchCalls).toHaveLength(0);
    expect(b.panelText()).toContain('найдено 2 — подтвердите отправку');
    expect(b.panelText()).toContain('Ждут подтверждения: 2');
    expect(b.panelText()).toContain('возьму посылку до 20 кг');

    await b.click(/Отправить найденные/);
    expect(b.fetchCalls).toHaveLength(1);
    expect(b.lastPayload().messages.map((m: any) => m.messageId)).toEqual([528, 531]);
    expect(b.saved().sentKeys).toHaveLength(2);
    // отправленное уходит из очереди подтверждения
    expect(b.panelText()).not.toContain('Ждут подтверждения');
  });

  it('кнопка «Пауза» останавливает сбор и сохраняется между проходами', async () => {
    const b = await new FakeBrowser().ready();
    b.respond(okResponse());

    await b.click('Пауза');
    expect(b.saved().settings!.paused).toBe(true);
    expect(b.panelText()).toContain('⏸ пауза');

    await b.firstTick();
    expect(b.fetchCalls).toHaveLength(0);
    expect(b.panelText()).toContain('пауза');

    await b.click('Продолжить');
    expect(b.saved().settings!.paused).toBe(false);
    await b.tick();
    expect(b.fetchCalls).toHaveLength(1);
  });

  it('кнопка «Диагностика» показывает, что именно видит клиент', async () => {
    const b = await new FakeBrowser().ready();
    b.respond(okResponse());
    await b.firstTick();
    await b.click('Диагностика');

    const text = b.panelText();
    expect(text).toContain('В белом списке: да');
    expect(text).toContain(CHAT_KEY);
    expect(text).toContain('.bubbles .bubble');
    expect(text).toContain('Причины отсева');
  });
});

describe('ошибки сервера и сети (ТЗ п. 4.5)', () => {
  it('401 — остановиться и показать ошибку, дальше не слать', async () => {
    const b = await new FakeBrowser().ready();
    b.respond({ status: 401, body: { error: 'unauthorized' } });
    await b.firstTick();
    expect(b.panelText()).toContain('Токен не принят (401)');

    b.respond(okResponse());
    await b.tick();
    expect(b.fetchCalls).toHaveLength(1); // повторных запросов нет
    expect(b.saved().sentKeys ?? []).toEqual([]);
  });

  it('503 — приём выключен на сервере (не задан INGEST_TOKEN)', async () => {
    const b = await new FakeBrowser().ready();
    b.respond({ status: 503, body: { error: 'ingest disabled: INGEST_TOKEN is not set' } });
    await b.firstTick();
    expect(b.panelText()).toContain('Приём выключен на сервере (503)');
    await b.tick();
    expect(b.fetchCalls).toHaveLength(1);
  });

  it('429 с Retry-After — ждём указанное время, ничего не теряя', async () => {
    const b = await new FakeBrowser().ready();
    b.respond({ status: 429, retryAfter: 600, body: { error: 'rate_limited' } });
    await b.firstTick();
    expect(b.panelText()).toContain('Сервер ответил 429');
    expect(b.panelText()).toContain('Подождём 600 с');

    b.respond(okResponse());
    await b.tick(); // ещё идёт окно лимита
    expect(b.fetchCalls).toHaveLength(1);
    expect(b.saved().sentKeys ?? []).toEqual([]); // сообщения не помечены отправленными
  });

  it('5xx — backoff и повтор позже', async () => {
    const b = await new FakeBrowser().ready();
    b.respond({ status: 502, body: null });
    await b.firstTick();
    expect(b.panelText()).toContain('Сервер ответил 502');
    await b.tick();
    expect(b.fetchCalls).toHaveLength(1);
  });

  it('413/400 — стоп с текстом ошибки сервера (надо чинить контракт)', async () => {
    const b = await new FakeBrowser().ready();
    b.respond({ status: 413, body: { error: 'messages: max 100 per request' } });
    await b.firstTick();
    expect(b.panelText()).toContain('Сервер отклонил запрос (413)');
    expect(b.panelText()).toContain('max 100 per request');
    await b.tick();
    expect(b.fetchCalls).toHaveLength(1);
  });

  it('нет связи — backoff и понятное сообщение', async () => {
    const b = await new FakeBrowser().ready();
    b.respond({ status: 200, body: { ok: true, summary: {}, results: [] } });
    // имитируем обрыв сети: fetch бросает исключение
    (b.context as any).fetch = async () => { throw new Error('Failed to fetch'); };
    await b.firstTick();
    expect(b.panelText()).toContain('Нет связи с сервером');
    expect(b.panelText()).toContain('Failed to fetch');
    expect(b.saved().sentKeys ?? []).toEqual([]);
  });

  it('битый JSON в ответе не роняет клиент', async () => {
    const b = await new FakeBrowser().ready();
    (b.context as any).fetch = async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => '<html>proxy error</html>',
    });
    await b.firstTick();
    expect(b.panelText()).toContain('отправлено 2');
    expect(b.saved().counters).toMatchObject({ sent: 2, created: 0 });
  });
});

describe('изменившаяся разметка Telegram Web', () => {
  it('честно пишет «не могу прочитать сообщения» и считает ошибку', async () => {
    const b = await new FakeBrowser({ page: brokenPage() }).ready();
    b.respond(okResponse());
    await b.firstTick();

    expect(b.fetchCalls).toHaveLength(0);
    expect(b.panelText()).toContain('Не могу прочитать сообщения');
    expect(b.panelText()).toContain('⚠ разметка');
    expect(b.saved().counters).toMatchObject({ errors: 1 });

    await b.click('Диагностика');
    expect(b.panelText()).toContain('НЕ МОГУ ПРОЧИТАТЬ СООБЩЕНИЯ');
  });
});
