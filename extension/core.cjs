/**
 * Ядро сборщика для Telegram Web — ЧИСТАЯ логика, без DOM и без fetch.
 *
 * Файл намеренно в формате UMD и с расширением .cjs:
 *   - в расширении/юзерскрипте подключается обычным <script> (content scripts
 *     в MV3 не умеют ES-модули) и кладёт API в globalThis.PoputkaCore;
 *   - в тестах импортируется как CommonJS (tests/extension-core.test.ts).
 *
 * Здесь всё, что можно проверить без браузера: белый список чатов, ключи
 * chatId, клиентский детект объявлений, локальная дедупликация, батчи,
 * backoff, классификация ошибок HTTP и сборка тела запроса под контракт
 * POST /api/ingest.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PoputkaCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Версия клиента — уходит в поле collector (ТЗ п. 4.3). */
  const COLLECTOR = 'tg-web-ext/1.0.0';

  /** Настройки по умолчанию. Всё хранится в chrome.storage / localStorage. */
  const DEFAULT_SETTINGS = {
    /** Базовый URL воркера, например https://pop-utka.app */
    serverUrl: '',
    /** INGEST_TOKEN (wrangler secret put INGEST_TOKEN) */
    token: '',
    /** Опрос вкладки: 60–180 с (ТЗ п. 4.5) */
    intervalSec: 120,
    /** Не больше ~20 сообщений за один POST */
    batchSize: 20,
    /** Сколько последних сообщений чата читать за проход */
    maxPerChat: 30,
    /** Спрашивать подтверждение перед отправкой (по умолчанию включён) */
    confirmMode: true,
    /** Пауза — ничего не читаем и не отправляем */
    paused: false,
    /** Белый список чатов: названия или ссылки t.me/… (пусто — ничего не собираем) */
    whitelist: [],
    /** Локальный отсев: сообщения старше N часов не отправляем */
    maxAgeHours: 72,
    /** Отправлять только сообщения с контактом (телефон/@username) */
    requireContact: false,
    /** Служебный лог отправленного (ключи chatId:messageId), хранится отдельно */
  };

  /** Сколько ключей «отправлено» держим локально: память не резиновая. */
  const SENT_LOG_LIMIT = 3000;

  /* ---------------------------------------------------------------- */
  /* Хранилище настроек: chrome.storage.local или localStorage         */
  /* ---------------------------------------------------------------- */

  /** chrome.storage.local (расширение) */
  function chromeStore(namespace) {
    return {
      async read() {
        const all = await chrome.storage.local.get(namespace);
        return all[namespace] || {};
      },
      async write(data) {
        await chrome.storage.local.set({ [namespace]: data });
      },
    };
  }

  /** localStorage (юзерскрипт) */
  function localStore(namespace) {
    return {
      read() {
        try { return JSON.parse(localStorage.getItem(namespace) || '{}') || {}; }
        catch { return {}; }
      },
      write(data) {
        localStorage.setItem(namespace, JSON.stringify(data));
        return Promise.resolve();
      },
    };
  }

  /** Настройки с дефолтами + валидацией диапазонов. */
  function withDefaults(raw) {
    const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
    s.intervalSec = clamp(Number(s.intervalSec) || DEFAULT_SETTINGS.intervalSec, 60, 600);
    s.batchSize = clamp(Math.round(Number(s.batchSize) || DEFAULT_SETTINGS.batchSize), 1, 100);
    s.maxPerChat = clamp(Math.round(Number(s.maxPerChat) || DEFAULT_SETTINGS.maxPerChat), 1, 200);
    s.maxAgeHours = clamp(Number(s.maxAgeHours) || DEFAULT_SETTINGS.maxAgeHours, 1, 24 * 30);
    s.confirmMode = s.confirmMode !== false;
    s.paused = s.paused === true;
    s.requireContact = s.requireContact === true;
    s.whitelist = Array.isArray(s.whitelist) ? s.whitelist.filter((x) => typeof x === 'string' && x.trim()) : [];
    s.serverUrl = String(s.serverUrl || '').trim().replace(/\/+$/, '');
    s.token = String(s.token || '').trim();
    return s;
  }

  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

  /**
   * Годится ли URL сервера. Возвращает текст проблемы или null.
   * https — всегда; http — только для локальной отладки (127.0.0.1/localhost),
   * потому что страница web.telegram.org открыта по https и обычный http-адрес
   * браузер заблокирует как mixed content.
   */
  function serverUrlProblem(raw) {
    const url = String(raw || '').trim();
    if (!url) return 'Укажите базовый URL сервера (например https://pop-utka.app).';
    if (/^https:\/\/[^\s/]/.test(url)) return null;
    if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(url)) return null;
    return 'URL сервера должен начинаться с https://. Для локальной отладки годится ' +
      'http://127.0.0.1:8790 — остальные http-адреса браузер заблокирует как mixed content ' +
      '(страница Telegram Web открыта по https).';
  }

  /* ---------------------------------------------------------------- */
  /* Белый список чатов                                                */
  /* ---------------------------------------------------------------- */

  /** Запись белого списка: ссылка t.me/<username>, @username или название чата. */
  function normalizeWhitelistEntry(raw) {
    const value = String(raw || '').trim();
    if (!value) return null;
    const link = /t\.me\/(?:s\/)?@?([A-Za-z][A-Za-z0-9_]{3,31})/i.exec(value);
    if (link) return { kind: 'username', value: link[1].toLowerCase() };
    const at = /^@([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(value);
    if (at) return { kind: 'username', value: at[1].toLowerCase() };
    return { kind: 'title', value: squashTitle(value) };
  }

  function normalizeWhitelist(list) {
    return (list || []).map(normalizeWhitelistEntry).filter(Boolean);
  }

  /**
   * Сравнимый вид названия чата: регистр, ё/е, разные тире и повторы пробелов
   * не должны мешать совпадению («Водители Польша–Беларусь» = «водители польша-беларусь»).
   */
  function squashTitle(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[\u2010-\u2015\u2212]/g, '-') // ‐‑–—–− → обычный дефис
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Пускаем ли чат в работу. Вне белого списка сообщения не читаются ВОВСЕ
   * (ТЗ п. 4.5) — это главная защита от лишнего трафика и от приватности.
   */
  function matchesWhitelist(chat, whitelist) {
    const entries = normalizeWhitelist(whitelist);
    if (entries.length === 0) return false;
    const title = squashTitle(chat && chat.title);
    const username = String((chat && chat.username) || '').toLowerCase();
    for (const e of entries) {
      if (e.kind === 'username') {
        if (username && username === e.value) return true;
        // в названии чата иногда пишут юзернейм — считаем совпадением
        if (title && title.includes(e.value)) return true;
      } else if (title && (title === e.value || title.includes(e.value) || e.value.includes(title))) {
        return true;
      }
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* Ключи чата и сообщения                                            */
  /* ---------------------------------------------------------------- */

  /**
   * chatId для сервера (ТЗ п. 4.3):
   *   публичный чат  → 'web:<username>'   (совпадает с ключом серверного сборщика —
   *                    одно и то же сообщение из двух источников не даст дубль)
   *   приватный чат  → 'ext:<внутренний id>'
   */
  function chatKeyOf(chat) {
    if (!chat) return null;
    if (chat.username) return 'web:' + String(chat.username).replace(/^@/, '');
    if (chat.id !== undefined && chat.id !== null && chat.id !== '') return 'ext:' + chat.id;
    if (chat.title) return 'ext:' + stableId('title:' + squashTitle(chat.title));
    return null;
  }

  /**
   * Детерминированный положительный int31 из строки.
   *
   * Нужен, если DOM-клиент не отдаёт числовой id сообщения: сервер требует
   * `messageId: integer > 0`, а дедупликация на сервере идёт по паре
   * (chatId, messageId). Синтетический id устойчив: то же сообщение в том же
   * чате даст то же число и в следующий проход, и после перезапуска браузера,
   * поэтому tg_seen его отловит как duplicate.
   */
  function stableId(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    // 31 бит, строго > 0
    return (h & 0x7fffffff) || 1;
  }

  function syntheticMessageId(chatKey, text, dateMs) {
    return stableId([chatKey, String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500), dateMs || ''].join('|'));
  }

  /* ---------------------------------------------------------------- */
  /* Клиентский детект (ТЗ п. 4.5)                                     */
  /* ---------------------------------------------------------------- */

  /** Запасной список ключевых слов, если бандл парсера не подключился. */
  const KEYWORD_HINTS = /(посылк|бандерол|переда[мтн]|перевез|доставк|груз|вещи|коробк|документ|лекарств|возьму|везу|есть место|нужно передать|ищу|кто (?:везёт|едет|поедет|может))/i;
  const PASSENGER_HINTS = /(пассажир|подвезти|подвезёт|довезти человека|мест в машине|ищу попутку)/i;

  /**
   * Отправлять ли сообщение на сервер.
   * `parser` — бандл src/parser.ts (PoputkaParser); если его нет, работаем
   * по упрощённому списку слов (ТЗ это допускает, но тогда серверный dryRun
   * обязателен для предпросмотра).
   */
  function detect(text, parser, settings) {
    const body = String(text || '').replace(/\u00a0/g, ' ').trim();
    if (body.length < 10) return { send: false, reason: 'short' };
    if (body.length > 4000) return { send: false, reason: 'too_long' };

    const parsed = parser && typeof parser.parseTelegramMessage === 'function'
      ? parser.parseTelegramMessage(body)
      : null;

    const passenger = parser && typeof parser.isPassengerOnly === 'function'
      ? parser.isPassengerOnly(body)
      : (PASSENGER_HINTS.test(body) && !/(посылк|переда|груз|вещи|коробк|документ)/i.test(body));
    if (passenger) return { send: false, reason: 'passenger', parsed };

    const worth = parser && typeof parser.worthAiCheck === 'function'
      ? parser.worthAiCheck(body)
      : KEYWORD_HINTS.test(body);
    if (!worth) return { send: false, reason: 'chatter', parsed };

    const hasContact = Boolean(parsed && (parsed.phone || parsed.telegram)) ||
      /(\+?\d[\d\s\-()]{8,16}\d|@[A-Za-z][A-Za-z0-9_]{3,31}|t\.me\/[A-Za-z][A-Za-z0-9_]{3,31})/.test(body);
    if (settings && settings.requireContact && !hasContact) {
      return { send: false, reason: 'no_contact', parsed };
    }
    return { send: true, reason: 'ok', parsed, hasContact };
  }

  /* ---------------------------------------------------------------- */
  /* Возраст, дедупликация, батчи                                      */
  /* ---------------------------------------------------------------- */

  /** Сообщение не старше maxAgeHours (дата из DOM может быть приблизительной). */
  function withinAge(dateMs, maxAgeHours, now) {
    if (!dateMs) return true; // дату не достали — решит сервер (своя maxAgeDays)
    const ageHours = ((now || Date.now()) - dateMs) / 3600000;
    if (ageHours < -24 * 3) return false; // «дата в будущем» — явно мусор
    return ageHours <= (maxAgeHours || 72);
  }

  /** Ключ локальной отметки «уже отправлено». */
  function sentKey(chatId, messageId) { return chatId + ':' + messageId; }

  /** Отсеять то, что уже отправляли. `sent` — массив ключей из хранилища. */
  function filterUnsent(messages, sent) {
    const seen = new Set(Array.isArray(sent) ? sent : []);
    const out = [];
    for (const m of messages) {
      const key = sentKey(m.chatId, m.messageId);
      if (seen.has(key)) continue;
      seen.add(key); // защита от повторов внутри одной пачки
      out.push(m);
    }
    return out;
  }

  /** Режем на батчи не больше batchSize (серверный предел — 100). */
  function chunk(messages, size) {
    const n = Math.max(1, Math.min(100, size || 20));
    const out = [];
    for (let i = 0; i < messages.length; i += n) out.push(messages.slice(i, i + n));
    return out;
  }

  /** Не больше maxPerChat последних сообщений, по возрастанию времени. */
  function takeRecent(messages, maxPerChat) {
    const n = Math.max(1, maxPerChat || 30);
    const sorted = messages.slice().sort((a, b) => (a.dateMs || 0) - (b.dateMs || 0));
    return sorted.slice(-n);
  }

  /** Экспоненциальный backoff с джиттером и потолком (для 429/5xx/сети). */
  function backoffMs(attempt, baseMs, maxMs) {
    const base = baseMs || 5000;
    const cap = maxMs || 15 * 60 * 1000;
    const exp = Math.min(cap, base * Math.pow(2, Math.max(0, (attempt || 1) - 1)));
    const jitter = Math.round(exp * 0.2 * Math.random());
    return Math.min(cap, exp + jitter);
  }

  /**
   * Что делать с ошибкой HTTP (ТЗ п. 4.5):
   *   401/503 → остановиться и показать ошибку (токен отозван или фича выключена);
   *   429/5xx/сеть → backoff и повторить;
   *   400/413 → остановиться: клиент шлёт мусор, надо чинить контракт.
   */
  function classifyStatus(status) {
    if (status === 401 || status === 403) return 'stop_auth';
    if (status === 503) return 'stop_disabled';
    if (status === 429) return 'backoff';
    if (status >= 500) return 'backoff';
    if (status === 400 || status === 413) return 'stop_payload';
    if (status >= 200 && status < 300) return 'ok';
    return 'unknown';
  }

  /* ---------------------------------------------------------------- */
  /* Контракт POST /api/ingest                                         */
  /* ---------------------------------------------------------------- */

  /** Тело запроса из списка сообщений (поля — строго по контракту). */
  function buildPayload(messages, opts) {
    const o = opts || {};
    return {
      collector: o.collector || COLLECTOR,
      dryRun: o.dryRun === true,
      messages: messages.map((m) => {
        const out = {
          chatId: m.chatId,
          messageId: m.messageId,
          text: m.text,
        };
        if (m.chatTitle) out.chatTitle = m.chatTitle;
        if (m.chatUrl) out.chatUrl = m.chatUrl;
        if (m.date) out.date = m.date;
        if (m.authorName) out.authorName = m.authorName;
        if (m.authorUsername) out.authorUsername = m.authorUsername;
        return out;
      }),
    };
  }

  /** Сообщение DOM → элемент контракта. */
  function toPayloadMessage(raw, settings) {
    const chat = raw.chat || {};
    const chatId = chat.chatId || chatKeyOf(chat);
    const text = String(raw.text || '').trim();
    const dateMs = raw.dateMs || null;
    const messageId = Number.isInteger(raw.messageId) && raw.messageId > 0
      ? raw.messageId
      : syntheticMessageId(chatId, text, dateMs);
    return {
      chatId,
      messageId,
      text: text.slice(0, 4000),
      chatTitle: chat.title ? String(chat.title).slice(0, 120) : null,
      // публичная ссылка — только когда знаем юзернейм (приватные не публикуем)
      chatUrl: chat.username ? 'https://t.me/' + String(chat.username).replace(/^@/, '') : null,
      // unix-секунды, как в контракте
      date: dateMs ? Math.floor(dateMs / 1000) : null,
      authorName: raw.authorName ? String(raw.authorName).slice(0, 120) : null,
      authorUsername: raw.authorUsername ? String(raw.authorUsername).slice(0, 64) : null,
      dateMs,
      idSource: Number.isInteger(raw.messageId) && raw.messageId > 0 ? 'dom' : 'synthetic',
    };
  }

  /** Счётчики по ответу сервера: что добавляем в локальный лог и в статистику. */
  function summarizeResponse(body) {
    const out = { received: 0, created: 0, duplicate: 0, skipped: 0, invalid: 0, listings: 0, sentKeys: [] };
    if (!body || typeof body !== 'object') return out;
    const s = body.summary || {};
    out.received = Number(s.received || 0);
    out.created = Number(s.created || 0);
    out.duplicate = Number(s.duplicate || 0);
    out.skipped = Number(s.skipped || 0);
    out.invalid = Number(s.invalid || 0);
    out.listings = Number(s.listings || 0);
    for (const r of body.results || []) {
      if (!r || !r.chatId) continue;
      // duplicate/created/skipped — сообщение обработано, повторно слать не нужно
      if (r.status !== 'invalid' && r.messageId) out.sentKeys.push(sentKey(r.chatId, r.messageId));
    }
    return out;
  }

  /** Слить счётчики проходов. */
  function mergeCounters(a, b) {
    const base = a || {};
    const add = b || {};
    const keys = ['found', 'sent', 'received', 'created', 'duplicate', 'skipped', 'invalid', 'listings', 'runs', 'errors'];
    const out = {};
    for (const k of keys) out[k] = Number(base[k] || 0) + Number(add[k] || 0);
    out.lastRunAt = add.lastRunAt || base.lastRunAt || null;
    out.lastError = add.lastError !== undefined ? add.lastError : base.lastError || null;
    return out;
  }

  /** Обрезать лог отправленного до SENT_LOG_LIMIT (храним самые свежие). */
  function pruneSentLog(keys, limit) {
    const arr = Array.isArray(keys) ? keys : [];
    const max = limit || SENT_LOG_LIMIT;
    return arr.length > max ? arr.slice(arr.length - max) : arr;
  }

  /* ---------------------------------------------------------------- */
  /* Диагностика                                                       */
  /* ---------------------------------------------------------------- */

  /** Короткий отчёт «что вижу в вкладке» — для попапа и отладки разметки. */
  function diagnostic(report) {
    const r = report || {};
    const lines = [];
    lines.push('URL: ' + (r.url || '—'));
    lines.push('Чат: ' + (r.chat && r.chat.title ? r.chat.title : 'не определён') +
      (r.chat && r.chat.username ? ' (@' + r.chat.username + ')' : '') +
      ' → chatId ' + (r.chatKey || '—'));
    lines.push('В белом списке: ' + (r.whitelisted ? 'да' : 'нет'));
    lines.push('Сообщений прочитано: ' + (r.total || 0) + ' (стратегия: ' + (r.strategy || '—') + ')');
    lines.push('К отправке: ' + (r.toSend || 0) + ', уже отправлено: ' + (r.alreadySent || 0) +
      ', отсеяно детектом: ' + (r.filtered || 0));
    if (r.reasons) {
      const parts = Object.keys(r.reasons).map((k) => k + ' ' + r.reasons[k]);
      if (parts.length) lines.push('Причины отсева: ' + parts.join(', '));
    }
    if (r.unreadable) lines.push('⚠ НЕ МОГУ ПРОЧИТАТЬ СООБЩЕНИЯ: разметка Telegram Web изменилась или чат пуст.');
    return lines.join('\n');
  }

  return {
    COLLECTOR,
    DEFAULT_SETTINGS,
    SENT_LOG_LIMIT,
    chromeStore,
    localStore,
    withDefaults,
    clamp,
    serverUrlProblem,
    normalizeWhitelist,
    normalizeWhitelistEntry,
    matchesWhitelist,
    squashTitle,
    chatKeyOf,
    stableId,
    syntheticMessageId,
    detect,
    withinAge,
    sentKey,
    filterUnsent,
    chunk,
    takeRecent,
    backoffMs,
    classifyStatus,
    buildPayload,
    toPayloadMessage,
    summarizeResponse,
    mergeCounters,
    pruneSentLog,
    diagnostic,
  };
});
