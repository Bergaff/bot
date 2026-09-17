/**
 * Тесты админ-UI этапа 6: parcel/app-auto-collect.js + правки app.js.
 *
 * Блок прогоняется в том же виде, в каком он попадёт в прод: сервер демо
 * склеивает demo/helpers.js (настоящие помощники из public/app.js) +
 * app-auto-collect.js + demo/demo.js в один модуль. Здесь та же склейка
 * выполняется в vm с поддельными document/localStorage/fetch — так проверяется,
 * что блок действительно работает с помощниками parcel, а не «в вакууме».
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FakeDocument, FakeNode, queryAll } from './helpers/fake-dom';

const BUNDLE_FILES = [
  'parcel/demo/helpers.js',
  'parcel/app-auto-collect.js',
  'parcel/demo/demo.js',
];

const BUNDLE = BUNDLE_FILES
  .map((f) => `/* ---- ${f} ---- */\n${readFileSync(new URL('../' + f, import.meta.url), 'utf8')}`)
  .join('\n;\n');

/* ------------------------------------------------------------------ */
/* Данные, как их отдаёт сервер                                        */
/* ------------------------------------------------------------------ */

const LISTINGS = [
  {
    id: 'l-bot', type: 'offer', fromCity: 'Варшава', toCity: 'Брест', departureDate: '2026-09-19',
    weightKg: 20, price: '40 BYN', description: 'Возьму посылку до 20 кг.', phone: '+48 579 264 254',
    status: 'pending', source: 'telegram', sourceChat: 'Переслано от Ивана',
    sourceChatId: '-1001234567890', sourceMessageId: 4211, createdAt: '2026-09-16T10:00:00Z',
    publishedAt: null, origin: 'bot',
  },
  {
    id: 'l-collector', type: 'offer', fromCity: 'Брест', toCity: 'Варшава', departureDate: '2026-09-21',
    weightKg: 15, description: 'Возьму посылку до 15 кг.', telegram: '@sergei_i',
    status: 'pending', source: 'parser', sourceChat: 'Водители Польша–Беларусь',
    sourceChatId: 'web:drivers_pl_by', sourceMessageId: 1234, createdAt: '2026-09-16T11:00:00Z',
    publishedAt: null, origin: 'collector',
  },
  {
    id: 'l-extension', type: 'request', fromCity: 'Краков', toCity: 'Минск', departureDate: '2026-09-18',
    weightKg: 2, description: 'Нужно передать документы.', telegram: '@anna_k',
    status: 'pending', source: 'parser', sourceChat: 'Посылки Польша–Беларусь',
    sourceChatId: 'web:posylki_pl_by', sourceMessageId: 528, createdAt: '2026-09-16T12:00:00Z',
    publishedAt: null, origin: 'extension',
  },
  {
    id: 'l-old', type: 'request', fromCity: 'Гродно', toCity: 'Минск', description: 'Без origin — старая запись.',
    phone: '+375 29 123 45 67', status: 'pending', source: 'telegram',
    createdAt: '2026-09-15T09:00:00Z', publishedAt: null,
  },
];

const WATCH_CHATS = [
  {
    id: 'web:durov', username: 'durov', kind: 'channel', title: 'Durov’s Channel', enabled: true,
    lastMessageId: 531, lastCheckedAt: '2026-09-16 13:20:49', lastError: null, errorCount: 0,
    statsFound: 3, statsCreated: 0, statsSkipped: 3, addedAt: '2026-09-16 13:20:25',
  },
  {
    id: 'web:drivers_pl_by', username: 'drivers_pl_by', kind: 'supergroup', title: 'Водители Польша–Беларусь',
    enabled: true, lastMessageId: null, lastCheckedAt: null, lastError: 'markup_changed? (страница 200, но контейнеров сообщений нет)',
    errorCount: 2, statsFound: 6, statsCreated: 3, statsSkipped: 1, addedAt: '2026-09-16 13:20:25',
  },
  { id: 'web:off_chat', username: 'off_chat', kind: 'channel', title: null, enabled: false, lastMessageId: 12, lastCheckedAt: null, lastError: null, errorCount: 0, statsFound: 0, statsCreated: 0, statsSkipped: 0, addedAt: '2026-09-16 13:20:25' },
];

const STATUS = {
  ok: true,
  enabled: true,
  ingestTokenSet: true,
  watchChats: { total: 3, enabled: 2, withErrors: 1 },
  ai: { collectUsedToday: 4, collectLimit: 20, collectLeft: 16, ingestLeft: 20 },
  listingsByOrigin: { bot: 2, collector: 5, extension: 1 },
  extensionToday: { messages: 12, created: 3 },
  lastReport: {
    startedAt: '2026-09-16T13:20:49.156Z',
    finishedAt: '2026-09-16T13:20:49.826Z',
    dryRun: false,
    totals: { chats: 3, fetched: 6, new: 6, created: 3, duplicate: 0, skipped: 3, invalid: 0, errors: 1, disabled: 0, fetches: 3 },
    chats: [],
  },
};

/* ------------------------------------------------------------------ */
/* Мини-админка                                                        */
/* ------------------------------------------------------------------ */

export interface UiRequest { path: string; method: string; body: any; auth: string | null; }

export interface AdminUi {
  ctx: Record<string, any>;
  doc: FakeDocument;
  requests: UiRequest[];
  toasts: string[];
  flush: () => Promise<void>;
  list: FakeNode;
  count: FakeNode;
  find: (selector: string) => FakeNode[];
  click: (node: FakeNode) => Promise<void>;
  buttonByText: (text: string | RegExp, root?: FakeNode) => FakeNode;
}

export function createAdminUi(opts: {
  listings?: any[];
  watchChats?: any[] | { needsSetup: true };
  status?: any;
  sourceChats?: any[];
  confirmAnswer?: boolean;
  collectReport?: any;
  /** Ответ GET /api/admin/extension: подключённые расширения и настройки для них. */
  extension?: any;
  /** Ответ GET /api/admin/ingest/log: журнал принятого от расширений. */
  ingestLog?: any;
  fail?: (path: string, method: string) => number | null;
} = {}): AdminUi {
  const requests: UiRequest[] = [];
  const toasts: string[] = [];
  // настройки расширения, «как в KV»: PUT перезаписывает, GET отдаёт сохранённое
  let extConfig: any = null;
  const store = new Map<string, string>();
  // список чатов обхода живой: POST добавляет, DELETE убирает — как в настоящей БД.
  // Без этого нельзя проверить, что таблица обновляется БЕЗ перезагрузки страницы.
  const chatState: any[] = Array.isArray(opts.watchChats ?? WATCH_CHATS)
    ? [...((opts.watchChats ?? WATCH_CHATS) as any[])]
    : [];

  const page = new FakeNode('div');
  const list = new FakeNode('div', { attrs: { id: 'admin-list' } });
  const count = new FakeNode('p', { attrs: { id: 'admin-count' } });
  page.append(
    new FakeNode('div', { attrs: { id: 'toast' } }),
    new FakeNode('section', { attrs: { id: 'admin-login' } }),
    new FakeNode('section', { attrs: { id: 'admin-panel' } }).append(
      new FakeNode('div', { className: 'admin-tabs' }).append(
        new FakeNode('button', { attrs: { id: 'admin-tab-pending' } }),
        new FakeNode('button', { attrs: { id: 'admin-tab-board' } }),
        new FakeNode('button', { attrs: { id: 'admin-tab-chats' } }),
        new FakeNode('button', { attrs: { id: 'admin-run-collect' } }),
        new FakeNode('button', { attrs: { id: 'admin-refresh' } }),
        new FakeNode('button', { attrs: { id: 'admin-reset-demo' } }),
      ),
      count,
      list,
    ),
  );
  const doc = new FakeDocument(page);

  const self: any = {};
  const ctx = vm.createContext({
    document: doc,
    window: { POPUTKA_API_BASE: '', scrollTo: () => undefined, confirm: () => opts.confirmAnswer !== false },
    location: { search: '', hash: '' },
    navigator: {},
    confirm: () => opts.confirmAnswer !== false,
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
    },
    URLSearchParams,
    URL,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    console: { log: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: async (url: string, init: any = {}) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '');
      const method = String(init.method || 'GET').toUpperCase();
      const body = init.body ? JSON.parse(String(init.body)) : null;
      requests.push({ path, method, body, auth: (init.headers && init.headers.Authorization) || null });

      const failStatus = opts.fail ? opts.fail(path, method) : null;
      if (failStatus) return respond(failStatus, { error: 'failed' });

      if (method === 'GET' && path.startsWith('/api/admin/listings')) {
        const tab = /tab=(\w+)/.exec(path)?.[1] ?? 'pending';
        const all = opts.listings ?? LISTINGS;
        return respond(200, { items: tab === 'board' ? all.filter((l) => l.status !== 'pending') : all.filter((l) => l.status === 'pending') });
      }
      if (method === 'GET' && path === '/api/admin/watch-chats') {
        if (opts.watchChats && !Array.isArray(opts.watchChats)) return respond(200, { chats: [], needsSetup: true });
        return respond(200, { chats: chatState });
      }
      if (method === 'POST' && path === '/api/admin/watch-chats') {
        const username = String(body?.username ?? '')
          .replace(/^https?:\/\/t\.me\//, '').replace(/^@/, '').trim();
        if (!username) return respond(400, { error: 'username required' });
        if (chatState.some((c) => c.username === username)) return respond(409, { error: 'chat already watched' });
        const chat = {
          id: `web:${username}`, username, kind: body?.kind === 'supergroup' ? 'supergroup' : 'channel',
          title: null, enabled: true, lastMessageId: null, lastCheckedAt: null, lastError: null,
          errorCount: 0, statsFound: 0, statsCreated: 0, statsSkipped: 0, addedAt: '2026-09-16 14:00:00',
        };
        chatState.push(chat);
        return respond(200, { ok: true, chat });
      }
      if (method === 'DELETE' && path.startsWith('/api/admin/watch-chats/')) {
        const id = decodeURIComponent(path.slice('/api/admin/watch-chats/'.length));
        const i = chatState.findIndex((c) => c.id === id);
        if (i >= 0) chatState.splice(i, 1);
        return respond(200, { ok: true });
      }
      if (method === 'GET' && path === '/api/admin/collect/status') {
        return opts.status === null ? respond(500, { error: 'boom' }) : respond(200, opts.status ?? STATUS);
      }
      if (method === 'GET' && path === '/api/admin/extension') {
        const fallback = { clients: [], config: extConfig, ingestEnabled: true };
        return respond(200, opts.extension ?? fallback);
      }
      if (method === 'PUT' && path === '/api/admin/extension/config') {
        if (!body || body.whitelist == null) return respond(400, { error: 'whitelist: нужен массив строк' });
        const list = Array.isArray(body.whitelist) ? body.whitelist : String(body.whitelist).split('\n');
        extConfig = { whitelist: list, intervalSec: body.intervalSec ?? null, paused: body.paused ?? null, updatedAt: '2026-09-17T10:00:00.000Z' };
        return respond(200, { ok: true, config: extConfig });
      }
      if (method === 'GET' && path.startsWith('/api/admin/ingest/log')) {
        return respond(200, opts.ingestLog ?? { items: [] });
      }
      if (method === 'GET' && path === '/api/admin/source-chats') {
        return respond(200, { chats: opts.sourceChats ?? [] });
      }
      if (method === 'POST' && path === '/api/admin/collect') {
        return respond(200, {
          ok: true,
          report: opts.collectReport ?? {
            totals: { chats: 1, fetched: 3, new: 3, created: 2, duplicate: 0, skipped: 1, invalid: 0, errors: 0, disabled: 0, fetches: 1 },
            chats: [{ username: 'durov', status: 'ok', new: 3, created: 2 }],
          },
        });
      }
      if (method === 'POST' && path.startsWith('/api/admin/watch-chats/')) {
        return respond(200, { ok: true });
      }
      return respond(200, { ok: true });
    },
  });

  function respond(status: number, body: unknown) {
    const text = JSON.stringify(body);
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => null },
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  }

  // «тост» демо перехватываем, чтобы читать сообщения в тестах
  vm.runInContext(BUNDLE, ctx, { filename: 'demo-bundle.js' });
  const originalToast = ctx.toast;
  ctx.toast = (message: string) => { toasts.push(String(message)); originalToast(message); };

  self.ctx = ctx;
  self.doc = doc;
  self.requests = requests;
  self.toasts = toasts;
  self.list = list;
  self.count = count;
  self.flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
  self.find = (selector: string) => queryAll(list, selector);
  self.click = async (node: FakeNode) => { node.dispatch('click'); await self.flush(); };
  self.buttonByText = (text: string | RegExp, root: FakeNode = list) => {
    const found = queryAll(root, 'button').find((b) => (typeof text === 'string' ? b.textContent.includes(text) : text.test(b.textContent)));
    if (!found) throw new Error(`кнопка «${text}» не найдена в: ${root.textContent.slice(0, 200)}`);
    return found;
  };
  return self as AdminUi;
}

/** Отрисовать блок авто-сбора и вернуть его корень. */
async function renderBlock(ui: AdminUi): Promise<FakeNode> {
  const box: FakeNode = await ui.ctx.renderAutoCollect();
  ui.list.append(box);
  await ui.flush();
  return box;
}

/* ------------------------------------------------------------------ */

describe('блок склеивается и запускается с настоящими помощниками parcel', () => {
  it('все три файла входят в бандл и не конфликтуют именами', () => {
    expect(BUNDLE).toContain('function el(tag, attrs = {}, children = [])');
    expect(BUNDLE).toContain('function renderAutoCollect(container)');
    expect(BUNDLE).toContain('function pendingOriginFilter(items, current, onPick)');
    // app.js загружается как type="module": одно объявление на имя, иначе SyntaxError
    for (const name of ['function el(', 'function toast(', 'function renderAutoCollect(', 'function originBadge(']) {
      expect(BUNDLE.split(name).length - 1).toBe(1);
    }
  });

  it('при загрузке открывается вкладка «очередь»: запрос с Bearer-ключом', async () => {
    const ui = createAdminUi();
    await ui.flush();
    const req = ui.requests.find((r) => r.path.startsWith('/api/admin/listings'));
    expect(req?.method).toBe('GET');
    expect(req?.auth).toBe('Bearer demo-admin-token');
    expect(ui.find('.admin-card')).toHaveLength(4);
    expect(ui.count.textContent).toContain('Необработано заявок: 4');
  });
});

describe('фильтр очереди по источнику заявки', () => {
  it('originOf: неизвестное и старое — это бот', async () => {
    const ui = createAdminUi();
    await ui.flush();
    expect(ui.ctx.originOf({ origin: 'collector' })).toBe('collector');
    expect(ui.ctx.originOf({ origin: 'extension' })).toBe('extension');
    expect(ui.ctx.originOf({ origin: 'bot' })).toBe('bot');
    expect(ui.ctx.originOf({})).toBe('bot');
    expect(ui.ctx.originOf(null)).toBe('bot');
  });

  it('filterByOrigin и счётчики', async () => {
    const ui = createAdminUi();
    await ui.flush();
    expect(ui.ctx.filterByOrigin(LISTINGS, 'all')).toHaveLength(4);
    expect(ui.ctx.filterByOrigin(LISTINGS, 'bot').map((l: any) => l.id)).toEqual(['l-bot', 'l-old']);
    expect(ui.ctx.filterByOrigin(LISTINGS, 'extension').map((l: any) => l.id)).toEqual(['l-extension']);
    expect(ui.ctx.countByOriginClient(LISTINGS)).toEqual({ all: 4, bot: 2, collector: 1, extension: 1 });
    expect(ui.ctx.countByOriginClient(null)).toEqual({ all: 0, bot: 0, collector: 0, extension: 0 });
  });

  it('панель фильтра: четыре кнопки со счётчиками, клик переключает', async () => {
    const ui = createAdminUi();
    await ui.flush();
    const bar = ui.find('.origin-filter')[0]!;
    expect(queryAll(bar, 'button').map((b) => b.textContent))
      .toEqual(['все · 4', 'бот · 2', 'сборщик · 1', 'расширение · 1']);

    await ui.click(ui.buttonByText('расширение · 1'));
    expect(ui.find('.admin-card')).toHaveLength(1);
    expect(ui.find('.admin-card')[0]!.textContent).toContain('Краков → Минск');
    expect(ui.count.textContent).toContain('Необработано заявок: 4'); // счётчик — про всю очередь
    expect(ui.requests.filter((r) => r.path.startsWith('/api/admin/listings'))).toHaveLength(2);
  });

  it('пустой результат фильтра объясняется, а не выглядит поломкой', async () => {
    const ui = createAdminUi({ listings: LISTINGS.filter((l) => l.origin !== 'extension') });
    await ui.flush();
    await ui.click(ui.buttonByText('расширение · 0'));
    expect(ui.list.textContent).toContain('Заявок из источника «расширение» в очереди нет.');
  });

  it('клик по уже выбранному фильтру не дёргает сервер', async () => {
    const ui = createAdminUi();
    await ui.flush();
    const before = ui.requests.length;
    await ui.click(ui.buttonByText('все · 4'));
    expect(ui.requests).toHaveLength(before);
  });

  it('бейдж источника: только у собранных автоматически', async () => {
    const ui = createAdminUi();
    await ui.flush();
    expect(ui.ctx.originBadge({ origin: 'bot' })).toBeNull();
    expect(ui.ctx.originBadge({})).toBeNull();
    const collector = ui.ctx.originBadge({ origin: 'collector' }) as FakeNode;
    expect(collector.textContent).toBe('сборщик');
    expect(collector.className).toContain('badge-collector');
    const ext = ui.ctx.originBadge({ origin: 'extension' }) as FakeNode;
    expect(ext.textContent).toBe('расширение');
    expect(ext.getAttribute('title')).toContain('расширением');
  });

  it('в карточке очереди бейдж стоит перед подписью источника', async () => {
    const ui = createAdminUi();
    await ui.flush();
    const badges = ui.find('.badge-origin');
    expect(badges.map((b) => b.textContent)).toEqual(['сборщик', 'расширение']);
    const src = ui.find('.src');
    expect(src.length).toBe(4);
  });

  it('ПРАВКА 4: ссылка на источник для ключей web: и ext:', async () => {
    const ui = createAdminUi();
    await ui.flush();
    expect(ui.ctx.sourceLinkUrl({ sourceChatId: 'web:drivers_pl_by', sourceMessageId: 1234 }))
      .toBe('https://t.me/drivers_pl_by/1234');
    expect(ui.ctx.sourceLinkUrl({ sourceChatId: 'web:drivers_pl_by' })).toBe('https://t.me/drivers_pl_by');
    expect(ui.ctx.sourceLinkUrl({ sourceChatId: 'ext:-1001234567890', sourceMessageId: 7 })).toBeNull();
    // рум (топик) форум-чата: ссылка трёхчастная, как её даёт Telegram
    expect(ui.ctx.sourceLinkUrl({
      sourceChatId: 'web:travelersminsk', sourceTopicId: 91529, sourceMessageId: 713464,
    })).toBe('https://t.me/travelersminsk/91529/713464');
    expect(ui.ctx.sourceLinkUrl({ sourceChatId: '-1001234567890', sourceTopicId: 7, sourceMessageId: 9 }))
      .toBe('https://t.me/c/1234567890/7/9');
    expect(ui.ctx.sourceLinkUrl({ sourceChatId: '-1001234567890', sourceMessageId: 9 }))
      .toBe('https://t.me/c/1234567890/9');
    expect(ui.ctx.sourceLinkUrl({})).toBeNull();
    // ссылка, заданная админом, важнее вывода из ключа
    const linked = ui.find('.src a').map((a) => a.getAttribute('href'));
    expect(linked).toContain('https://t.me/drivers_pl_by/1234');
  });

  it('на вкладке «доска» фильтра по источнику нет', async () => {
    const ui = createAdminUi();
    await ui.flush();
    ui.ctx.switchAdminTab('board');
    await ui.flush();
    expect(ui.find('.origin-filter')).toHaveLength(0);
    expect(ui.requests.some((r) => r.path.includes('tab=board'))).toBe(true);
  });
});

describe('таблица чатов обхода', () => {
  it('показывает username, тип, статус, курсор, проверку, счётчики и ошибку', async () => {
    const ui = createAdminUi();
    const box = await renderBlock(ui);

    expect(box.textContent).toContain('Авто-сбор публичных чатов');
    const rows = queryAll(box, 'tbody tr');
    expect(rows).toHaveLength(3);

    const first = rows[0]!;
    expect(first.textContent).toContain('durov');
    expect(first.textContent).toContain('канал');
    expect(first.textContent).toContain('включён');
    expect(first.textContent).toContain('531');
    expect(first.textContent).toContain('3 / 0 / 3');
    const link = queryAll(first, 'a')[0]!;
    expect(link.getAttribute('href')).toBe('https://t.me/durov');
    expect(link.getAttribute('target')).toBe('_blank');

    const second = rows[1]!;
    expect(second.textContent).toContain('супергруппа');
    expect(second.textContent).toContain('не установлен');
    expect(second.textContent).toContain('markup_changed');
    expect(queryAll(second, 'td.err')).toHaveLength(1);

    const third = rows[2]!;
    expect(third.textContent).toContain('выключен');
    expect(ui.buttonByText('включить', third)).toBeTruthy();
  });

  it('кнопка «выключить» — PUT с enabled:false и админским ключом', async () => {
    const ui = createAdminUi();
    const box = await renderBlock(ui);
    const row = queryAll(box, 'tbody tr')[0]!;
    await ui.click(ui.buttonByText('выключить', row));

    const put = ui.requests.find((r) => r.method === 'PUT');
    expect(put?.path).toBe('/api/admin/watch-chats/web%3Adurov');
    expect(put?.body).toEqual({ enabled: false });
    expect(put?.auth).toBe('Bearer demo-admin-token');
  });

  it('«сбросить курсор» спрашивает подтверждение и шлёт last_message_id: null', async () => {
    const ui = createAdminUi();
    const box = await renderBlock(ui);
    const row = queryAll(box, 'tbody tr')[0]!;
    await ui.click(ui.buttonByText('сбросить курсор', row));
    expect(ui.requests.find((r) => r.method === 'PUT')?.body).toEqual({ last_message_id: null });

    const declined = createAdminUi({ confirmAnswer: false });
    const box2 = await renderBlock(declined);
    await declined.click(declined.buttonByText('сбросить курсор', queryAll(box2, 'tbody tr')[0]!));
    expect(declined.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
  });

  it('«проверить сейчас» запускает прогон одного чата и показывает итог', async () => {
    const ui = createAdminUi();
    const box = await renderBlock(ui);
    const row = queryAll(box, 'tbody tr')[0]!;
    await ui.click(ui.buttonByText('проверить сейчас', row));

    const post = ui.requests.find((r) => r.method === 'POST' && r.path === '/api/admin/collect');
    expect(post?.body).toEqual({ chatId: 'web:durov' });
    expect(ui.toasts.join('\n')).toContain('durov: ok — новых 3, заявок 2');
  });

  it('«удалить» убирает чат из обхода после подтверждения', async () => {
    const ui = createAdminUi();
    const box = await renderBlock(ui);
    const row = queryAll(box, 'tbody tr')[2]!;
    await ui.click(ui.buttonByText('удалить', row));
    const del = ui.requests.find((r) => r.method === 'DELETE');
    expect(del?.path).toBe('/api/admin/watch-chats/web%3Aoff_chat');
  });

  it('после «удалить» строка пропадает сама — перезагружать страницу не нужно', async () => {
    const ui = createAdminUi();
    const box = await renderBlock(ui);
    expect(queryAll(box, 'tbody tr')).toHaveLength(3);
    expect(box.textContent).toContain('off_chat');

    await ui.click(ui.buttonByText('удалить', queryAll(box, 'tbody tr')[2]!));

    // тот же смонтированный узел: строки стало две, удалённого чата в нём нет
    expect(queryAll(box, 'tbody tr')).toHaveLength(2);
    expect(box.textContent).not.toContain('off_chat');
    expect(box.textContent).toContain('durov');
  });

  it('ошибка прогона показывается модератору, а не теряется', async () => {
    const ui = createAdminUi({
      collectReport: { totals: {}, chats: [{ username: 'durov', status: 'error', new: 0, created: 0, error: 'fetch failed' }] },
    });
    const box = await renderBlock(ui);
    await ui.click(ui.buttonByText('проверить сейчас', queryAll(box, 'tbody tr')[0]!));
    expect(ui.toasts.join('\n')).toContain('durov: error');
    expect(ui.toasts.join('\n')).toContain('fetch failed');
  });
});

describe('форма добавления чата в обход', () => {
  it('POST /api/admin/watch-chats с юзернеймом и типом', async () => {
    const ui = createAdminUi();
    const box = await renderBlock(ui);
    const input = queryAll(box, 'input[type=text]')[0]!;
    input.value = 'https://t.me/posylki_pl_by';
    const select = queryAll(box, 'select')[0]!;
    select.value = 'supergroup';
    await ui.click(ui.buttonByText('добавить в обход', box));

    const post = ui.requests.find((r) => r.method === 'POST' && r.path === '/api/admin/watch-chats');
    expect(post?.body).toEqual({ username: 'https://t.me/posylki_pl_by', kind: 'supergroup' });
    expect(ui.toasts.join('\n')).toContain('Чат добавлен');
  });

  it('добавленный чат сразу появляется в таблице — без перезагрузки страницы', async () => {
    const ui = createAdminUi();
    const box = await renderBlock(ui);
    const input = queryAll(box, 'input[type=text]')[0]!;
    input.value = 'https://t.me/posylki_pl_by';

    await ui.click(ui.buttonByText('добавить в обход', box));

    expect(box.textContent).toContain('posylki_pl_by');
    expect(queryAll(box, 'tbody tr')).toHaveLength(4);
    expect(input.value).toBe('');
  });

  it('пустой ввод и повтор чата не создают мусорных запросов', async () => {
    const ui = createAdminUi();
    const box = await renderBlock(ui);
    await ui.click(ui.buttonByText('добавить в обход', box));
    expect(ui.requests.filter((r) => r.path === '/api/admin/watch-chats' && r.method === 'POST')).toHaveLength(0);
    expect(ui.toasts.join('\n')).toContain('Введите юзернейм чата');

    const dup = createAdminUi({ fail: (path, method) => (path === '/api/admin/watch-chats' && method === 'POST' ? 409 : null) });
    const box2 = await renderBlock(dup);
    const input = queryAll(box2, 'input[type=text]')[0]!;
    input.value = 'durov';
    await dup.click(dup.buttonByText('добавить в обход', box2));
    expect(dup.toasts.join('\n')).toContain('Такой чат уже в обходе.');
  });
});

describe('отчёт последнего прогона и статус источников', () => {
  it('видны cron, приём от расширения, чаты, квоты ИИ и итоги прогона', async () => {
    const ui = createAdminUi();
    const box = await renderBlock(ui);
    const report = queryAll(box, '.admin-report')[0]!;
    const text = report.textContent;
    expect(text).toContain('Отчёт последнего прогона и статус источников');
    expect(text).toContain('включён');
    expect(text).toContain('включён (INGEST_TOKEN задан)');
    expect(text).toContain('2 из 3 (с ошибками: 1)');
    expect(text).toContain('4 из 20, осталось 16');
    expect(text).toContain('бот 2 · сборщик 5 · расширение 1');
    expect(text).toContain('принято сообщений 12, создано заявок 3');
    expect(text).toContain('чатов 3, запросов 3, найдено 6, новых 6');
    expect(text).toContain('заявок 3, дублей 0, отсеяно 3, ошибок 1');
  });

  it('не задан INGEST_TOKEN — подсказка, что сделать', async () => {
    const ui = createAdminUi({ status: { ...STATUS, ingestTokenSet: false } });
    const box = await renderBlock(ui);
    expect(box.textContent).toContain('wrangler secret put INGEST_TOKEN');
  });

  it('dry run прогона помечен в отчёте', async () => {
    const ui = createAdminUi({
      status: { ...STATUS, lastReport: { ...STATUS.lastReport, dryRun: true } },
    });
    const box = await renderBlock(ui);
    expect(box.textContent).toContain('(dry run)');
  });

  it('прогона ещё не было — так и написано', async () => {
    const ui = createAdminUi({ status: { ...STATUS, lastReport: null } });
    const box = await renderBlock(ui);
    expect(box.textContent).toContain('ещё не запускался');
  });
});

describe('крайние состояния блока', () => {
  it('нет миграции 0006 — понятная подсказка вместо пустой таблицы', async () => {
    const ui = createAdminUi({ watchChats: { needsSetup: true } });
    const box = await renderBlock(ui);
    expect(box.textContent).toContain('Нужна миграция 0006_ingest.sql');
    expect(queryAll(box, 'table')).toHaveLength(0);
  });

  it('чатов в обходе нет — предлагаем добавить', async () => {
    const ui = createAdminUi({ watchChats: [] });
    const box = await renderBlock(ui);
    expect(box.textContent).toContain('Чатов в обходе нет');
    expect(queryAll(box, 'input[type=text]')).toHaveLength(1);
  });

  it('сервер недоступен — блок сообщает об этом и не роняет вкладку', async () => {
    const ui = createAdminUi({ fail: (path, method) => (path === '/api/admin/watch-chats' && method === 'GET' ? 500 : null) });
    const box = await renderBlock(ui);
    expect(box.textContent).toContain('Авто-сбор не загрузился');
  });

  it('статус недоступен — таблица всё равно показана', async () => {
    const ui = createAdminUi({ status: null });
    const box = await renderBlock(ui);
    expect(queryAll(box, 'tbody tr')).toHaveLength(3);
    // отчёт последнего прогона не показан; единственный details — журнал приёма расширения
    const reports = queryAll(box, '.admin-report');
    expect(reports).toHaveLength(1);
    expect(reports[0]!.textContent).toContain('Что принято от аккаунта');
    expect(box.textContent).not.toContain('Отчёт последнего прогона');
  });

  it('fmtWhen понимает и ISO, и формат sqlite', async () => {
    const ui = createAdminUi();
    await ui.flush();
    expect(ui.ctx.fmtWhen(null)).toBe('—');
    expect(ui.ctx.fmtWhen('2026-09-16 13:20:49')).toContain('2026');
    expect(ui.ctx.fmtWhen('2026-09-16T13:20:49.156Z')).toContain('2026');
    expect(ui.ctx.fmtWhen('не дата')).toBe('не дата');
  });
});

/* ------------------------------------------------------------------ */
/* Панель как пульт расширения: аккаунт Telegram, румы, журнал приёма   */
/* ------------------------------------------------------------------ */

const EXT_CLIENT = {
  clientId: '1f7c2b40-demo-0001',
  collector: 'tg-web-ext/0.9.0',
  at: new Date().toISOString(),
  url: 'https://web.telegram.org/a/#-1001234567890_7',
  chat: {
    chatKey: 'ext:-1001234567890', title: 'Водители Польша–Беларусь', username: null, kind: 'c',
    groupTitle: 'Водители Польша–Беларусь', topicTitle: 'Очередь BY-PL', topicId: 7, whitelisted: true,
  },
  counters: { found: 12, sent: 3, created: 2, duplicate: 1, skipped: 9, runs: 5, errors: 0 },
  status: 'рум: Очередь BY-PL — прочитано 12 сообщений',
  error: null,
  pending: 0,
  unreadable: false,
  whitelist: ['Водители Польша–Беларусь :: 7'],
  intervalSec: 120,
  paused: false,
};

const INGEST_LOG = [
  {
    seenAt: '2026-09-17 09:20:18', chatId: 'ext:-1001234567890', messageId: 528, kind: 'created',
    link: 'https://t.me/c/1234567890/528', listingId: 'f1c9bee0-1111-2222-3333-444455556666',
    status: 'pending', type: 'offer', fromCity: 'Минск', toCity: 'Варшава',
    departureDate: '2026-09-18', origin: 'extension',
  },
  {
    seenAt: '2026-09-17 09:19:02', chatId: 'web:drivers_pl_by', messageId: 9001, kind: 'duplicate',
    link: 'https://t.me/drivers_pl_by/9001', listingId: 'efb6fbe0-aaaa-bbbb-cccc-ddddeeeeffff',
    status: 'pending', type: 'offer', fromCity: 'Минск', toCity: 'Варшава',
    departureDate: '2026-09-18', origin: 'extension',
  },
];

describe('панель как пульт расширения', () => {
  it('аккаунт на связи: чат, рум, счётчики и состояние видны модератору', async () => {
    const ui = createAdminUi({ extension: { clients: [EXT_CLIENT], config: null, ingestEnabled: true } });
    const box = await renderBlock(ui);
    expect(box.textContent).toContain('Аккаунт Telegram (расширение)');
    expect(box.textContent).toContain('на связи');
    expect(box.textContent).toContain('Водители Польша–Беларусь');
    expect(box.textContent).toContain('Очередь BY-PL');          // рум из адреса вкладки
    expect(box.textContent).toContain('заявок 2');
    expect(box.textContent).toContain('дублей 1');
    expect(box.textContent).toContain('отсеяно 9');
    expect(box.textContent).toContain('состояние: рум: Очередь BY-PL');
    expect(box.textContent).toContain('tg-web-ext/0.9.0');
  });

  it('отметка старше 12 минут — «нет связи»: модератор понимает, что вкладку закрыли', async () => {
    const stale = { ...EXT_CLIENT, at: new Date(Date.now() - 20 * 60 * 1000).toISOString() };
    const ui = createAdminUi({ extension: { clients: [stale], config: null, ingestEnabled: true } });
    const box = await renderBlock(ui);
    expect(box.textContent).toContain('нет связи');
    expect(box.textContent).toContain('20 мин назад');
  });

  it('пауза, ошибка и «разметка не читается» видны в панели, а не молчат в браузере', async () => {
    const ui = createAdminUi({
      extension: {
        clients: [{ ...EXT_CLIENT, paused: true, error: '429 Too Many Requests — ждём 30 с', unreadable: true }],
        config: null, ingestEnabled: true,
      },
    });
    const box = await renderBlock(ui);
    expect(box.textContent).toContain('ПАУЗА');
    expect(box.textContent).toContain('429 Too Many Requests');
    expect(box.textContent).toContain('не читается');
  });

  it('никого нет — инструкция, как подключить аккаунт', async () => {
    const ui = createAdminUi();
    const box = await renderBlock(ui);
    expect(box.textContent).toContain('Ни один браузер ещё не подключился');
    expect(box.textContent).toContain('Самопроверка');
  });

  it('приём выключен (нет INGEST_TOKEN) — панель говорит, что сделать на сервере', async () => {
    const ui = createAdminUi({ extension: { clients: [], config: null, ingestEnabled: false } });
    const box = await renderBlock(ui);
    expect(box.textContent).toContain('Приём выключен');
    expect(box.textContent).toContain('INGEST_TOKEN');
  });

  it('белый список чатов и румов: форма заполнена, сохранение уходит PUT-ом', async () => {
    const ui = createAdminUi({
      extension: {
        clients: [],
        config: { whitelist: ['Граница', 'Водители Польша–Беларусь :: Очередь BY-PL', 'Водители Польша–Беларусь :: 7'], intervalSec: 90, paused: true, updatedAt: '2026-09-17T08:00:00.000Z' },
        ingestEnabled: true,
      },
    });
    const box = await renderBlock(ui);

    const area = queryAll(box, 'textarea')[0]!;
    expect(area.value).toBe('Граница\nВодители Польша–Беларусь :: Очередь BY-PL\nВодители Польша–Беларусь :: 7');
    expect(box.textContent).toContain('::');  // синтаксис рума объяснён рядом с полем

    area.value = 'Граница :: Очередь BY-PL\nГраница :: 7';
    await ui.click(ui.buttonByText('сохранить и передать расширению', box));

    const put = ui.requests.find((r) => r.method === 'PUT' && r.path === '/api/admin/extension/config');
    expect(put?.body).toEqual({ whitelist: ['Граница :: Очередь BY-PL', 'Граница :: 7'], intervalSec: 90, paused: true });
    expect(ui.toasts.join(' | ')).toContain('Передано расширению: 2 записей');
  });

  it('журнал приёма: ссылка на сообщение, заявка это или дубль', async () => {
    const ui = createAdminUi({ ingestLog: { items: INGEST_LOG } });
    const box = await renderBlock(ui);
    expect(box.textContent).toContain('Что принято от аккаунта: последние 2 сообщений');
    expect(box.textContent).toContain('заявка создана');
    expect(box.textContent).toContain('Минск → Варшава');
    expect(box.textContent).toContain('дубль: такая заявка уже была');
    expect(box.textContent).toContain('расширение');  // подпись origin

    const links = queryAll(box, 'a').map((a: any) => a.attrs?.href ?? a.getAttribute?.('href')).filter(Boolean);
    expect(links).toContain('https://t.me/c/1234567890/528');   // приватная супергруппа
    expect(links).toContain('https://t.me/drivers_pl_by/9001'); // публичный чат
  });

  it('журнал пуст — объясняем, что отсеянное сюда не попадает вовсе', async () => {
    const ui = createAdminUi({ ingestLog: { items: [] } });
    const box = await renderBlock(ui);
    expect(box.textContent).toContain('Пока пусто');
    expect(box.textContent).toContain('пассажирские');
  });

  it('нет миграции 0006 в журнале — подсказка про миграции', async () => {
    const ui = createAdminUi({ ingestLog: { items: [], needsSetup: true } });
    const box = await renderBlock(ui);
    expect(box.textContent).toContain('0006_ingest.sql');
  });

  it('расширение доступно только админу: запросы идут с Bearer ADMIN_API_TOKEN', async () => {
    const ui = createAdminUi({ extension: { clients: [EXT_CLIENT], config: null, ingestEnabled: true }, ingestLog: { items: INGEST_LOG } });
    await renderBlock(ui);
    const ext = ui.requests.find((r) => r.path === '/api/admin/extension');
    const log = ui.requests.find((r) => r.path.startsWith('/api/admin/ingest/log'));
    expect(ext?.auth).toBe('Bearer demo-admin-token');
    expect(log?.auth).toBe('Bearer demo-admin-token');
  });
});
