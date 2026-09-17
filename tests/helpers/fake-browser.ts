/**
 * Мини-браузер для тестов extension/content.js без настоящего браузера.
 *
 * content.js — IIFE без экспортов, поэтому проверяем его «чёрным ящиком»:
 * что он прочитал в DOM, какой запрос ушёл в fetch, что написано в панели и
 * что сохранилось в localStorage. Всё остальное (детект, ключи, батчи) уже
 * покрыто тестами core.js и dom.js.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FakeDocument, FakeNode, bubble, bubblesList, queryAll } from './fake-dom';

const EXT = new URL('../../extension/', import.meta.url);

export interface FakeResponse {
  status?: number;
  body?: unknown;
  retryAfter?: number | null;
}

export interface FetchCall {
  url: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    cache?: string;
  };
}

export interface FakeBrowserOptions {
  /** URL открытой вкладки Telegram Web */
  url?: string;
  /** дерево страницы (лента чата); по умолчанию — несколько объявлений */
  page?: FakeNode;
  /** настройки, которые «пользователь сохранил в попапе» */
  settings?: Record<string, unknown>;
  /** заранее записанные счётчики/лог отправленного */
  stored?: Record<string, unknown>;
  /**
   * «Страницы» для автообхода: hash → дерево чата. Когда контент-скрипт меняет
   * `location.hash` (переход в следующий чат/рум), тело документа подменяется —
   * так в мини-браузере проверяется обход без настоящего Telegram.
   */
  pages?: Record<string, FakeNode>;
  /**
   * Виртуальное время: `Date.now()` внутри вкладки начинается с настоящего и
   * двигается методом `advance()`. Нужно, чтобы не ждать реальные паузы обхода.
   */
  fakeClock?: boolean;
}

export class FakeBrowser {
  readonly context: Record<string, any>;
  readonly fetchCalls: FetchCall[] = [];
  /** Ответы для отдельных маршрутов (настройки из панели, отметка «я жив»). */
  readonly routes: Array<{ match: string | RegExp; response: Partial<FakeResponse> }> = [];
  readonly logs: string[] = [];
  readonly intervals: Array<() => void> = [];
  /** с каким интервалом зарегистрирован опрос (мс) */
  readonly intervalMs: number[] = [];
  /** какие таймеры сняты (clearInterval) — по ним видно, что старый экземпляр остановлен */
  readonly cleared: number[] = [];
  readonly timeouts: Array<() => void> = [];
  /** какие адреса вкладки установил контент-скрипт (переходы автообхода) */
  readonly hashChanges: string[] = [];
  /** страницы по хэшу: подменяем тело документа при переходе */
  private readonly pages: Record<string, FakeNode>;
  /** виртуальное «сейчас» внутри вкладки */
  nowMs = Date.now();
  private response: FakeResponse = { status: 200, body: { ok: true, summary: {}, results: [] } };
  private readonly doc: FakeDocument;
  private readonly store = new Map<string, string>();

  constructor(opts: FakeBrowserOptions = {}) {
    const page = opts.page ?? defaultPage();
    this.doc = new FakeDocument(page);
    this.pages = opts.pages ?? {};

    const url = new URL(opts.url ?? 'https://web.telegram.org/k/#@drivers_pl_by');
    const self = this;

    this.context = vm.createContext({
      console: {
        info: (...args: unknown[]) => { self.logs.push(args.map(String).join(' ')); },
        warn: (...args: unknown[]) => { self.logs.push(args.map(String).join(' ')); },
        error: (...args: unknown[]) => { self.logs.push(args.map(String).join(' ')); },
      },
      document: this.doc,
      navigator: {},
      CSS: { escape: (s: string) => String(s).replace(/[:.]/g, (c) => '\\' + c) },
      localStorage: {
        getItem: (k: string) => (self.store.has(k) ? self.store.get(k)! : null),
        setItem: (k: string, v: string) => { self.store.set(k, String(v)); },
        removeItem: (k: string) => { self.store.delete(k); },
      },
      fetch: async (u: string, init: any) => {
        self.fetchCalls.push({ url: String(u), init });
        // маршрут с собственным ответом (например /api/extension/config) важнее общего
        const route = self.routes.find((r) => (typeof r.match === 'string' ? String(u).includes(r.match) : r.match.test(String(u))));
        const response = route ? route.response : self.response;
        const status = response.status ?? 200;
        const text = response.body === undefined ? '' : JSON.stringify(response.body);
        return {
          status,
          ok: status >= 200 && status < 300,
          headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' && response.retryAfter != null ? String(response.retryAfter) : null) },
          text: async () => text,
          json: async () => JSON.parse(text),
        };
      },
      // Виртуальные часы: контент-скрипт живёт по ним, иначе тесты ждали бы
      // настоящие паузы автообхода (60–240 с).
      Date: opts.fakeClock
        ? class FakeDate extends Date {
            constructor(...args: unknown[]) {
              super(...(args.length ? (args as [any]) : ([self.nowMs] as [any])));
            }
            static now(): number { return self.nowMs; }
          }
        : Date,
      setInterval: (fn: () => void, ms?: number) => {
        self.intervals.push(fn);
        self.intervalMs.push(Number(ms) || 0);
        return self.intervals.length;
      },
      clearInterval: (id: unknown) => { self.cleared.push(Number(id)); },
      setTimeout: (fn: () => void, ms?: number) => {
        self.timeouts.push(fn);
        const id = self.timeouts.length;
        const delay = Number(ms) || 0;
        // Короткие таймеры (опрос «дорисовался ли чат» при автообходе, сброс флага
        // своего клика) срабатывают сами — тест не должен ждать полсекунды.
        // Длинные остаются ручными: первый проход (4 с) вызывает firstTick().
        if (delay > 0 && delay <= 2000) {
          setTimeout(() => {
            // с виртуальными часами таймер ещё и двигает время вкладки:
            // ожидание «дорисовался ли чат» (30 × 500 мс) должно когда-то кончиться
            if (opts.fakeClock) self.nowMs += delay;
            fn();
          }, 0);
        }
        return id;
      },
    });

    // Адрес вкладки: запись в location.hash открывает «страницу» из opts.pages —
    // так автообход переключает чаты и румы внутри мини-браузера.
    const loc: Record<string, any> = { href: url.href, origin: url.origin };
    let currentHash = url.hash;
    Object.defineProperty(loc, 'hash', {
      get: () => currentHash,
      set: (raw: string) => {
        const next = String(raw).startsWith('#') ? String(raw) : '#' + String(raw);
        if (next === currentHash) return;
        currentHash = next;
        self.hashChanges.push(next);
        loc.href = url.origin + url.pathname + next;
        const page = self.pages[next] ?? self.pages[next.replace(/^#/, '')];
        if (page) self.doc.body.replaceChildren(page);
      },
    });
    const win: Record<string, any> = { location: loc };
    this.context.window = win;
    this.context.location = loc;

    // настройки «как из попапа»
    const saved = Object.assign({ settings: defaultSettings() }, opts.stored ?? {});
    if (opts.settings) saved.settings = Object.assign(defaultSettings(), opts.settings);
    this.store.set('poputchka', JSON.stringify(saved));

    // те же файлы и в том же порядке, что и в manifest.json
    for (const file of ['vendor/parser.js', 'core.js', 'dom.js', 'content.js']) {
      vm.runInContext(readFileSync(new URL(file, EXT), 'utf8'), this.context, { filename: file });
    }
  }

  /** Что ответит сервер на следующий POST /api/ingest. */
  respond(response: FakeResponse): this { this.response = response; return this; }

  /** Дождаться завершения инициализации (панель появилась, таймер стоит). */
  async ready(): Promise<this> { await this.flush(); return this; }

  /** Дождаться, пока асинхронный проход внутри vm завершится. */
  async flush(times = 12): Promise<void> {
    for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
  }

  /** Первый проход (content.js откладывает его на 4 с после загрузки). */
  async firstTick(): Promise<void> {
    const fn = this.timeouts[this.timeouts.length - 1];
    if (fn) fn();
    await this.flush();
  }

  /**
   * Внедрить контент-скрипт в уже работающую страницу ещё раз — так делает попап
   * кнопкой «Подключить к вкладке» (chrome.scripting.executeScript).
   */
  reinject(): void {
    vm.runInContext(readFileSync(new URL('content.js', EXT), 'utf8'), this.context, { filename: 'content.js (повторно)' });
  }

  /** Метка живого экземпляра, которую контент-скрипт оставляет на window. */
  bootMarker(): { extId?: string; boot?: Record<string, any>; live?: () => boolean; stop?: () => void } | undefined {
    return (this.context.window as Record<string, any>).__poputchkaBoot;
  }

  /** Пользователь печатает/кликает/крутит колесо во вкладке Telegram. */
  userTouches(type: 'keydown' | 'mousedown' | 'wheel' | 'touchstart' = 'mousedown'): this {
    this.doc.userEvent(type);
    return this;
  }

  /** Двинуть виртуальное время вкладки вперёд (паузы автообхода). */
  advance(ms: number): this { this.nowMs += ms; return this; }

  /** Какой чат сейчас открыт (по адресу вкладки). */
  get hash(): string { return (this.context.location as Record<string, any>).hash; }

  /** Проход по таймеру опроса. */
  async tick(): Promise<void> {
    const fn = this.intervals[this.intervals.length - 1];
    if (fn) fn();
    await this.flush();
  }

  /** Клик по кнопке панели (по видимому тексту). */
  async click(label: string | RegExp): Promise<void> {
    const btn = this.panelNodes('button').find((b) => {
      const text = b.textContent;
      return typeof label === 'string' ? text.includes(label) : label.test(text);
    });
    if (!btn) throw new Error(`кнопка «${label}» в панели не найдена: ${this.panelText()}`);
    btn.dispatch('click');
    await this.flush();
  }

  panel(): FakeNode | null { return this.doc.getElementById('pk-panel'); }

  panelNodes(selector: string): FakeNode[] {
    const panel = this.panel();
    return panel ? queryAll(panel, selector) : [];
  }

  /** Весь видимый текст панели — по нему проверяем статус, счётчики и ошибки. */
  panelText(): string { return this.panel()?.textContent ?? ''; }

  /** Что клиент сохранил в localStorage (настройки, счётчики, лог отправленного). */
  saved(): {
    settings?: Record<string, any>;
    counters?: Record<string, number>;
    sentKeys?: string[];
    /** Журнал разбора: каждое прочитанное сообщение, вердикт и ссылка на него. */
    recent?: Array<Record<string, any>>;
    /** Где автообход остановился: индекс цели, переходы за час, журнал переходов. */
    walk?: Record<string, any>;
    clientId?: string;
    alive?: { at?: number; ok?: boolean; error?: string | null; version?: string; url?: string | null; status?: string };
  } {
    return JSON.parse(this.store.get('poputchka') ?? '{}');
  }

  /** Тело последней ОТПРАВКИ СООБЩЕНИЙ (служебные запросы не в счёт). */
  lastPayload(): any {
    const call = this.ingestCalls[this.ingestCalls.length - 1];
    return call ? JSON.parse(call.init.body) : null;
  }

  /** Только отправки сообщений: POST /api/ingest. */
  get ingestCalls(): FetchCall[] { return this.fetchCalls.filter((c) => c.url.includes('/api/ingest')); }

  /** Отметки «аккаунт подключён» для панели. */
  get heartbeatCalls(): FetchCall[] { return this.fetchCalls.filter((c) => c.url.includes('/api/extension/heartbeat')); }

  /** Запросы настроек из панели. */
  get configCalls(): FetchCall[] { return this.fetchCalls.filter((c) => c.url.includes('/api/extension/config')); }

  /** Задать ответ отдельному маршруту (до запуска прохода). */
  setRoute(match: string | RegExp, response: Partial<FakeResponse>): void {
    this.routes.push({ match, response });
  }

  /** Тело последней отметки для панели. */
  lastHeartbeat(): any {
    const call = this.heartbeatCalls[this.heartbeatCalls.length - 1];
    return call ? JSON.parse(call.init.body) : null;
  }
}

/* ------------------------------------------------------------------ */

function defaultSettings(): Record<string, unknown> {
  return {
    serverUrl: 'https://pop-utka.app',
    token: 'secret-token',
    intervalSec: 120,
    batchSize: 20,
    maxPerChat: 30,
    confirmMode: false,
    paused: false,
    whitelist: ['t.me/drivers_pl_by'],
    maxAgeHours: 72,
    requireContact: false,
    autoWalk: false,
    walkReadsPerChat: 2,
    walkMinSec: 60,
    walkMaxSec: 240,
    walkMaxPerHour: 20,
    walkIdleGuardSec: 45,
  };
}

/**
 * ISO-дата «N минут назад»: content.js живёт по настоящему Date.now(),
 * поэтому фикстуры должны быть относительными, иначе тесты состарятся.
 */
export function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/** Лента публичного чата: 2 объявления, болтовня и пассажирская попутка. */
export function defaultPage(): FakeNode {
  const chatInfo = new FakeNode('div', { className: 'chat-info' })
    .append(new FakeNode('div', { className: 'peer-title', text: 'Водители Польша–Беларусь' }));
  const list = bubblesList([
    bubble({ text: '25.09 Варшава — Брест, возьму посылку до 20 кг, +48 579 264 254', id: '528', datetime: minutesAgoIso(45), author: 'Сергей @sergei_i' }),
    bubble({ text: 'Всем привет! Как дела?', id: '529', datetime: minutesAgoIso(44), author: 'Ольга' }),
    bubble({ text: 'Кто подвезёт пассажира из Гродно в Минск сегодня вечером?', id: '530', datetime: minutesAgoIso(43), author: 'Пётр' }),
    bubble({ text: 'Нужно передать документы из Кракова в Минск 26.09, до 2 кг, @anna_k', id: '531', datetime: minutesAgoIso(42), author: 'Анна' }),
  ]);
  return new FakeNode('div', { className: 'page' }).append(chatInfo, list);
}

/** Страница с незнакомой разметкой — «не могу прочитать сообщения». */
export function brokenPage(): FakeNode {
  return new FakeNode('div', { className: 'brand-new-layout' })
    .append(new FakeNode('section', { className: 'unknown', text: '25.09 Варшава — Брест, возьму посылку' }));
}
