/**
 * Ядро сборщика для Telegram Web — ЧИСТАЯ логика, без DOM и без fetch.
 *
 * Файл намеренно в формате UMD и с расширением .js:
 *   - в расширении/юзерскрипте подключается обычным <script> (content scripts
 *     в MV3 не умеют ES-модули) и кладёт API в globalThis.PoputkaCore;
 *   - в тестах импортируется как CommonJS (tests/extension-core.test.ts) —
 *     для этого рядом лежит extension/package.json с "type": "commonjs".
 *
 * Расширение именно .js обязательно: Chrome определяет тип файла контент-скрипта
 * по расширению и отказывается грузить .cjs («Invalid script mime type») — тогда
 * не внедряется НИ ОДИН файл списка, и вкладка «не отвечает».
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
  const COLLECTOR = 'tg-web-ext/1.0.4';

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

    /* Автообход: расширение само открывает чаты и румы из белого списка.
       По умолчанию ВЫКЛЮЧЕН — это уже автоматизация аккаунта (см. walkDecision). */
    autoWalk: false,
    /** Сколько проходов прочитать в одном чате, прежде чем уйти дальше */
    walkReadsPerChat: 2,
    /** Случайная пауза перед переходом: от… */
    walkMinSec: 60,
    /** …до (пауза каждый раз разная — как у человека) */
    walkMaxSec: 240,
    /** Предел переходов в час: защита от «слишком бодрого» обхода */
    walkMaxPerHour: 20,
    /** Не переключать чат, пока пользователь сам печатает/кликает (0 — не ждать) */
    walkIdleGuardSec: 45,
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
    s.autoWalk = s.autoWalk === true;
    s.walkReadsPerChat = clamp(Math.round(Number(s.walkReadsPerChat) || DEFAULT_SETTINGS.walkReadsPerChat), 1, 20);
    s.walkMinSec = clamp(Math.round(Number(s.walkMinSec) || DEFAULT_SETTINGS.walkMinSec), 10, 3600);
    s.walkMaxSec = clamp(Math.round(Number(s.walkMaxSec) || DEFAULT_SETTINGS.walkMaxSec), 10, 7200);
    if (s.walkMaxSec < s.walkMinSec) s.walkMaxSec = s.walkMinSec;
    s.walkMaxPerHour = clamp(Math.round(Number(s.walkMaxPerHour) || DEFAULT_SETTINGS.walkMaxPerHour), 1, 600);
    s.walkIdleGuardSec = clamp(Math.round(Number(s.walkIdleGuardSec) || 0), 0, 1800);
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
  /**
   * Канонический peer-id чата из того, что отдаёт Telegram Web.
   *
   * Клиент показывает чат по-разному: /k/#-1001234567890, /a/#/im?p=g1234567890,
   * ?p=u123456 (личный), ?p=c123456 (обычная группа). Приводим к одному виду —
   * тогда из приватной супергруппы можно построить служебную ссылку
   * https://t.me/c/<id>/<msgId>, которая открывается у участников чата
   * (именно её просит модератор: «дать ссылку на сообщение, чтобы переслать»).
   */
  function normalizePeerId(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    let m = /^[gG](\d{4,})$/.exec(s);                 // супергруппа/канал: g1234567890
    if (m) return { id: '-100' + m[1], kind: 'supergroup' };
    m = /^[cC](\d{4,})$/.exec(s);                     // обычная группа: c1234567890
    if (m) return { id: '-' + m[1], kind: 'group' };
    m = /^[uU](\d{4,})$/.exec(s);                     // личный чат: u1234567890
    if (m) return { id: m[1], kind: 'user' };
    if (/^-100\d{4,}$/.test(s)) return { id: s, kind: 'supergroup' };
    if (/^-\d{4,}$/.test(s)) return { id: s, kind: 'group' };
    if (/^\d{4,}$/.test(s)) return { id: s, kind: 'user' };
    return null;
  }

  function normalizeWhitelistEntry(raw) {
    const value = String(raw || '').trim();
    if (!value) return null;
    // «чат :: тема» — считать только один рум (топик) форум-супергруппы.
    // Тема задаётся названием («Граница :: Очередь BY-PL») или id («Граница :: 12»).
    const parts = value.split(/\s*(?:::|>>)\s*/);
    const base = normalizeChatPart((parts[0] || '').trim());
    if (!base) return null;
    base.raw = String(raw).trim();
    const topicPart = (parts[1] || '').trim();
    if (!topicPart) return base;
    if (/^\d{1,12}$/.test(topicPart)) {
      return Object.assign(base, { topicId: Number(topicPart), topic: null, topicStrict: true, raw: raw });
    }
    return Object.assign(base, { topic: squashTitle(topicPart), topicId: null, topicStrict: true, raw: raw });
  }

  /**
   * Запись белого списка → { kind, value, topicId?, topic?, topicStrict? }.
   *
   * Рум (топик) форум-чата можно задать тремя способами:
   *   «Граница :: Очередь BY-PL» / «Граница :: 7»  — явно;
   *   «t.me/travelersminsk/91529»                  — ссылкой на рум (как её даёт Telegram);
   *   «t.me/travelersminsk/91529/713464»           — ссылкой на сообщение в руме:
   *                                                первое число — рум, второе — сообщение;
   *   «t.me/c/1234567890/91529»                    — то же для приватной супергруппы.
   */
  function normalizeChatPart(value) {
    if (!value) return null;

    // приватная супергруппа/канал: t.me/c/<id>[/<рум>[/<сообщение>]]
    const priv = /t\.me\/c\/(\d{4,})(?:\/(\d{1,12}))?(?:\/(\d{1,12}))?/i.exec(value);
    if (priv) {
      const entry = { kind: 'peer', value: '-100' + priv[1] };
      if (priv[2]) { entry.topicId = Number(priv[2]); entry.topicStrict = true; }
      return entry;
    }

    // публичный чат: t.me/<username>[/<рум>[/<сообщение>]]
    const link = /t\.me\/(?:s\/)?@?([A-Za-z][A-Za-z0-9_]{3,31})(?:\/(\d{1,12}))?(?:\/(\d{1,12}))?/i.exec(value);
    if (link) {
      const entry = { kind: 'username', value: link[1].toLowerCase() };
      if (link[2]) {
        entry.topicId = Number(link[2]);
        // три сегмента — точно рум + сообщение; два — может быть и ссылкой на сообщение
        // в обычном чате, поэтому такую запись смягчаем (см. matchesWhitelist)
        entry.topicStrict = Boolean(link[3]);
      }
      return entry;
    }

    const at = /^@([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(value);
    if (at) return { kind: 'username', value: at[1].toLowerCase() };
    return { kind: 'title', value: squashTitle(value) };
  }

  function normalizeWhitelist(list) {
    // терпим к строке (настройки из панели могут прийти текстом): режем по строкам/запятым
    const arr = typeof list === 'string'
      ? list.split(/[\n,;]+/)
      : (Array.isArray(list) ? list : []);
    return arr.map(normalizeWhitelistEntry).filter(Boolean);
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
    const titles = chatTitleCandidates(chat);
    const username = String((chat && chat.username) || '').toLowerCase();
    const peer = normalizePeerId(chat && chat.id);
    const peerId = peer ? peer.id : null;
    const topics = topicCandidates(chat);
    const topicId = chat && chat.topicId != null && chat.topicId !== '' ? Number(chat.topicId) : null;
    // форум ли открыт: знаем id рума или видим имя темы
    const looksLikeForum = topicId != null || topics.length > 0;

    for (const e of entries) {
      if (!chatPartMatches(e, titles, username, peerId)) continue;
      // запись без указания рума — берём весь чат, все румы
      if (e.topic == null && e.topicId == null) return true;
      if (e.topicId != null && topicId === e.topicId) return true;
      if (e.topic && topics.some((t) => t === e.topic || t.includes(e.topic) || e.topic.includes(t))) return true;
      // Ссылка t.me/<username>/<число> в чате, который не похож на форум, — это, скорее всего,
      // ссылка на сообщение, а не на рум. Читаем весь чат: иначе сбор молча встанет навсегда.
      if (e.topicId != null && e.topicStrict === false && !looksLikeForum) return true;
      // чат совпал, но рум задан и не совпал/не прочитался — не читаем (ТЗ: только белый список)
    }
    return false;
  }

  /** Названия, по которым узнаём чат: заголовок шапки и, если прочиталось, имя группы. */
  function chatTitleCandidates(chat) {
    const out = [];
    const t = squashTitle(chat && chat.title);
    const g = squashTitle(chat && chat.groupTitle);
    if (t) out.push(t);
    if (g && g !== t) out.push(g);
    return out;
  }

  /** Названия, по которым узнаём рум (топик): явный заголовок темы или шапка при найденной группе. */
  function topicCandidates(chat) {
    const out = [];
    const tt = squashTitle(chat && chat.topicTitle);
    if (tt) out.push(tt);
    const t = squashTitle(chat && chat.title);
    const g = squashTitle(chat && chat.groupTitle);
    if (g && t && t !== g) out.push(t);
    return out;
  }

  function chatPartMatches(entry, titles, username, peerId) {
    // запись ссылкой на приватный чат (t.me/c/<id>): сравниваем внутренние id
    if (entry.kind === 'peer') {
      return Boolean(peerId) && String(peerId) === String(entry.value);
    }
    if (entry.kind === 'username') {
      return Boolean(username && username === entry.value) ||
        // в названии чата иногда пишут юзернейм — считаем совпадением
        titles.some((t) => t.includes(entry.value));
    }
    return titles.some((t) => t === entry.value || t.includes(entry.value) || entry.value.includes(t));
  }

  /**
   * Почему чат не подошёл белому списку — для диагностики (на логику не влияет).
   * Отличает «чат не в списке» от «чат тот, но рум не совпал или не прочитался».
   */
  /**
   * Запасной вариант для форум-чатов.
   *
   * Бывает, что Telegram Web показывает заголовок открытого рума, но числовой
   * id рума в URL не отдаёт. Тогда запись вида `t.me/<чат>/<рум>` не с чем
   * сравнить, и сбор молча встал бы. Если в белом списке за этим чатом закреплён
   * РОВНО ОДИН рум — берём его id (и обязательно сообщаем об этом пользователю:
   * вызывающий печатает `note`).
   *
   * Возвращает { topicId, note } или null, если угадывать нельзя:
   * нет признаков открытого рума, румов закреплено несколько или ни одного.
   */
  function adoptTopicFromWhitelist(chat, whitelist) {
    if (!chat) return null;
    if (chat.topicId != null && chat.topicId !== '') return null;   // id и так прочитался
    if (topicCandidates(chat).length === 0) return null;            // не видно, что открыт рум

    const entries = normalizeWhitelist(whitelist);
    const titles = chatTitleCandidates(chat);
    const username = String(chat.username || '').toLowerCase();
    const peer = normalizePeerId(chat.id);
    const pinned = entries.filter((e) =>
      e.topicId != null && chatPartMatches(e, titles, username, peer ? peer.id : null));
    const ids = pinned.map((e) => e.topicId).filter((v, i, arr) => arr.indexOf(v) === i);
    if (ids.length !== 1) return null;                              // неоднозначно — не угадываем

    const room = topicCandidates(chat)[0];
    return {
      topicId: ids[0],
      note: 'id рума взят из ссылки в белом списке (клиент не отдал его в адресе). ' +
        'Проверьте, что открыт рум «' + (room || '?') + '».',
    };
  }

  function whitelistMismatch(chat, whitelist) {
    const entries = normalizeWhitelist(whitelist);
    if (entries.length === 0) return 'Белый список пуст — сообщения не читаются вовсе.';
    if (matchesWhitelist(chat, whitelist)) return null;
    const titles = chatTitleCandidates(chat);
    const username = String((chat && chat.username) || '').toLowerCase();
    const peer = normalizePeerId(chat && chat.id);
    const sameChat = entries.filter((e) => chatPartMatches(e, titles, username, peer ? peer.id : null));
    if (sameChat.length === 0) return 'Чат не в белом списке.';
    const topics = topicCandidates(chat);
    const hasTopicId = Boolean(chat && chat.topicId != null && chat.topicId !== '');
    if (topics.length === 0 && !hasTopicId) {
      return 'Чат в белом списке с указанием рума, но тема (рум) не прочиталась — сообщения не читаются. ' +
        'Откройте конкретный рум в Telegram Web (список тем румом не считается) ' +
        'или уберите указание рума из записи, если нужны все румы этого чата.';
    }
    return 'Чат в белом списке, но рум не совпал: открыт «' +
      (topics[0] || ('id ' + chat.topicId)) + '», а в списке «' +
      sameChat.map((e) => (e.topic || (e.topicId != null ? 'id ' + e.topicId : 'все румы'))).join(', ') + '».';
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
    const peer = normalizePeerId(chat && chat.id);
    if (peer) return 'ext:' + peer.id;
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
        // рум форум-чата: нужен серверу для ссылки t.me/<username>/<рум>/<сообщение>
        if (m.topicId) out.topicId = m.topicId;
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
    const fromDom = Number.isInteger(raw.messageId) && raw.messageId > 0;
    const messageId = fromDom ? raw.messageId : syntheticMessageId(chatId, text, dateMs);
    const topicId = chat.topicId != null && chat.topicId !== '' ? Number(chat.topicId) : null;
    return {
      chatId,
      messageId,
      // рум (топик) форум-чата: сервер строит по нему правильную ссылку на сообщение
      topicId: Number.isInteger(topicId) && topicId > 0 ? topicId : null,
      // ссылка на само сообщение — для панели расширения и попапа (в контракт не уходит)
      link: messageLink(chat, messageId, { idSource: fromDom ? 'dom' : 'synthetic' }),
      text: text.slice(0, 4000),
      chatTitle: chat.title ? String(chat.title).slice(0, 120) : null,
      // публичная ссылка — только когда знаем юзернейм (приватные не публикуем)
      chatUrl: chat.username ? 'https://t.me/' + String(chat.username).replace(/^@/, '') : null,
      // unix-секунды, как в контракте
      date: dateMs ? Math.floor(dateMs / 1000) : null,
      authorName: raw.authorName ? String(raw.authorName).slice(0, 120) : null,
      authorUsername: raw.authorUsername ? String(raw.authorUsername).slice(0, 64) : null,
      dateMs,
      idSource: fromDom ? 'dom' : 'synthetic',
    };
  }

  /**
   * Ссылка на сообщение — чтобы открыть его в Telegram и переслать вручную.
   *
   * Формат Telegram:
   *   публичный чат            t.me/<username>[/<рум>]/<id сообщения>
   *   приватная супергруппа    t.me/c/<id без -100>[/<рум>]/<id сообщения>
   *
   * Для обычной группы и личного чата ссылок на сообщение не существует — null.
   * Синтетический id (DOM не отдал настоящий) ссылкой не снабжаем: она вела бы
   * на случайное сообщение, а не на найденное.
   */
  function messageLink(chat, messageId, opts) {
    const o = opts || {};
    const id = Number(messageId);
    if (!Number.isInteger(id) || id <= 0) return null;
    if (o.synthetic === true || o.idSource === 'synthetic') return null;

    const c = chat || {};
    const topicRaw = c.topicId != null && c.topicId !== '' ? Number(c.topicId) : null;
    const topicPart = topicRaw && Number.isInteger(topicRaw) && topicRaw > 0 ? '/' + topicRaw : '';

    const username = c.username ? String(c.username).replace(/^@/, '') : null;
    if (username) return 'https://t.me/' + username + topicPart + '/' + id;

    const peer = normalizePeerId(c.id);
    if (peer && /^-100\d+$/.test(peer.id)) {
      return 'https://t.me/c/' + peer.id.slice(4) + topicPart + '/' + id;
    }
    return null;
  }

  /** Счётчики по ответу сервера: что добавляем в локальный лог и в статистику. */
  function summarizeResponse(body, batch) {
    const out = { received: 0, created: 0, duplicate: 0, skipped: 0, invalid: 0, listings: 0, sentKeys: [] };
    const rejected = {};
    if (body && typeof body === 'object') {
      const s = body.summary || {};
      out.received = Number(s.received || 0);
      out.created = Number(s.created || 0);
      out.duplicate = Number(s.duplicate || 0);
      out.skipped = Number(s.skipped || 0);
      out.invalid = Number(s.invalid || 0);
      out.listings = Number(s.listings || 0);
      for (const r of body.results || []) {
        if (!r || !r.chatId) continue;
        if (r.status === 'invalid') {
          // такое сообщение сервер не принял — оставляем его на повтор
          if (r.messageId) rejected[sentKey(r.chatId, r.messageId)] = true;
          continue;
        }
        // duplicate/created/skipped — сообщение обработано, повторно слать не нужно
        if (r.messageId) out.sentKeys.push(sentKey(r.chatId, r.messageId));
      }
    }
    /*
     * Страховка от повторов. Ответ без results (старая версия сервера, прокси,
     * пустое тело) не повод слать тот же батч каждый проход: что отправили сами
     * и сервер принял (2xx), то считаем обработанным. Исключение — сообщения,
     * которые сервер прямо назвал invalid.
     */
    for (const m of (batch || [])) {
      if (!m || m.chatId == null || m.messageId == null) continue;
      const key = sentKey(m.chatId, m.messageId);
      if (rejected[key] || out.sentKeys.indexOf(key) !== -1) continue;
      out.sentKeys.push(key);
    }
    return out;
  }

  /**
   * Объяснить ошибку «вкладка не отвечает» так, чтобы было понятно, что делать.
   * alive — последняя отметка контент-скрипта из storage (heartbeat), её может не быть.
   */
  function explainTabError(errText, alive, now) {
    const text = String(errText || '');
    const at = now || Date.now();
    const ageMin = alive && alive.at ? Math.round((at - Number(alive.at)) / 60000) : null;
    const ageText = ageMin == null ? null : (ageMin <= 0 ? 'только что' : ageMin + ' мин назад');

    if (/Extension context invalidated/i.test(text)) {
      return 'Расширение обновлено или переустановлено, а вкладка держит старую копию. Обновите web.telegram.org (F5). ' +
        'Если не поможет — удалите расширение и загрузите папку extension/ заново: после повторного скачивания ZIP ' +
        'папка часто переезжает, и Chrome продолжает смотреть в старое место.';
    }
    if (/Receiving end does not exist|message port closed|Could not establish connection/i.test(text)) {
      if (alive && alive.ok === false && alive.error) {
        return 'Контент-скрипт загрузился, но упал при инициализации: ' + alive.error +
          '. Обновите вкладку; если повторится — пришлите этот текст.';
      }
      if (alive && ageText) {
        return 'Расширение отвечало в этой вкладке ' + ageText + ', но сейчас не отвечает. ' +
          'Нажмите «Подключить к вкладке» (или обновите web.telegram.org — F5) и повторите.';
      }
      return 'Контент-скрипт не подключён к этой вкладке: она открыта раньше установки расширения, ' +
        'восстановлена из кэша или расширению урезали доступ к сайту. Нажмите «Подключить к вкладке» — ' +
        'попап внедрит скрипт сам, без перезагрузки. Если кнопки нет (старая копия папки), обновите ' +
        'web.telegram.org (F5) и проверьте chrome://extensions → «Доступ к сайту» → «На всех сайтах».';
    }
    if (/Cannot access|Permission|not allowed|May not be permitted/i.test(text)) {
      return 'Браузер не даёт расширению доступ к вкладке: ' + text +
        '. Убедитесь, что адрес вкладки начинается с https://web.telegram.org/';
    }
    return text ? 'Вкладка не ответила: ' + text : 'Вкладка не ответила.';
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
  /* ---------------------------------------------------------------- */
  /* Автообход чатов и румов                                           */
  /* ---------------------------------------------------------------- */

  /**
   * План обхода — цели из белого списка, по порядку записей.
   *
   * Цель описывает, КАК её открыть: юзернейм/peer-id (переход по адресу, как если
   * бы пользователь сам вставил ссылку) или только название (тогда остаётся клик
   * по строке в боковой панели — см. dom.findChatRow).
   */
  function walkTargets(whitelist) {
    const seen = {};
    const out = [];
    for (const entry of normalizeWhitelist(whitelist)) {
      // «Граница :: Очередь BY-PL»: имя рума нужно, чтобы найти строку в списке
      const key = entry.kind + ':' + entry.value + ':' + (entry.topicId || '') + ':' + (entry.topic || '');
      if (seen[key]) continue;
      seen[key] = true;
      const label = entry.kind === 'peer'
        ? 'приватный чат ' + entry.value + (entry.topicId ? ', рум ' + entry.topicId : '')
        : (entry.value + (entry.topicId ? '/' + entry.topicId : '') + (entry.topic ? ' :: ' + entry.topic : ''));
      out.push({
        raw: entry.raw || label,
        label,
        kind: entry.kind,
        value: entry.value,
        topicId: entry.topicId != null ? entry.topicId : null,
        topic: entry.topic || null,
        /** строгая запись: нужен именно этот рум, а не весь чат */
        topicStrict: entry.topicStrict !== false || entry.topicId == null ? true : false,
        chatKey: entry.kind === 'peer' ? 'ext:' + entry.value : (entry.kind === 'username' ? 'web:' + entry.value : null),
      });
    }
    return out;
  }

  /**
   * Какой клиент Telegram Web открыт: от этого зависит форма адреса.
   * null — это вообще не Telegram Web (тогда обход адрес не трогает).
   */
  function clientFlavor(location) {
    const href = String((location && location.href) || '');
    if (!/web\.telegram\.org\//i.test(href)) return null;
    if (/web\.telegram\.org\/a\//i.test(href)) return 'a';
    if (/web\.telegram\.org\/z\//i.test(href)) return 'z';
    return 'k';
  }

  /**
   * Адрес (hash), по которому клиент откроет цель — как если бы пользователь
   * сам перешёл по ссылке. null, если по адресу открыть нельзя (цель задана
   * только названием) — тогда нужен клик по строке боковой панели.
   *
   * Web K:  #<username>[/<рум>]            #-100<id>[/<рум>]
   * Web A/Z: #/im?p=@<username>            #/im?p=g<id>[_<рум>]
   */
  function walkHashFor(target, location) {
    if (!target) return null;
    const flavor = clientFlavor(location);
    if (!flavor) return null;   // не клиент Telegram Web — адрес не переписываем
    const topic = target.topicId != null ? target.topicId : null;

    if (target.kind === 'username') {
      if (flavor === 'k') return '#' + target.value + (topic ? '/' + topic : '');
      // Web A/Z юзернейм понимает, а вот рум по адресу в них не открывается
      return topic ? null : '#/im?p=@' + target.value;
    }
    if (target.kind === 'peer') {
      const digits = String(target.value).replace(/^-100/, '');
      if (flavor === 'k') return '#' + target.value + (topic ? '/' + topic : '');
      return '#/im?p=g' + digits + (topic ? '_' + topic : '');
    }
    return null;   // цель задана названием — только клик по списку чатов
  }

  /** Случайная пауза между переходами (мс): каждый раз разная. */
  function walkPauseMs(minSec, maxSec, rand) {
    const lo = Math.max(1, Number(minSec) || 60);
    const hi = Math.max(lo, Number(maxSec) || lo);
    const r = typeof rand === 'function' ? rand() : Math.random();
    return Math.round((lo + (hi - lo) * r) * 1000);
  }

  /** Переходы за последний час (с одновременной обрезкой старых отметок). */
  function walkSwitchesInHour(stamps, now) {
    const from = (now || Date.now()) - 3600 * 1000;
    return (stamps || []).filter((t) => Number(t) > from);
  }

  /**
   * Какую цель плана мы сейчас читаем: если пользователь открыл чат руками,
   * обход продолжается с него, а не «сначала». -1 — открытый чат не из плана.
   */
  function walkIndexForChat(plan, chat) {
    const key = chatKeyOf(chat);
    if (!key) return -1;
    const topicId = chat && chat.topicId != null && chat.topicId !== '' ? Number(chat.topicId) : null;
    let sameChat = -1;
    for (let i = 0; i < (plan || []).length; i++) {
      const t = plan[i];
      if (t.chatKey !== key) continue;
      if (t.topicId == null) { if (sameChat < 0) sameChat = i; continue; }
      if (t.topicId === topicId) return i;
      if (sameChat < 0) sameChat = i;
    }
    // открытый чат показал КОНКРЕТНЫЙ рум, которого в плане нет — это не наша цель;
    // «примерно тот же чат» годится, только когда рум не прочитался вовсе
    return topicId == null ? sameChat : -1;
  }

  /**
   * Куда идти дальше: следующая по порядку цель, которую в этом круге не
   * провалили. Если не открылось всё (нет входа в аккаунт, разметка не читается),
   * список проваленных сбрасывается и обход пробует снова — с теми же паузами.
   */
  function walkNextIndex(plan, from, failed) {
    const list = plan || [];
    const n = list.length;
    if (!n) return 0;
    const bad = {};
    for (const label of (failed || [])) bad[label] = true;
    for (let step = 1; step <= n; step++) {
      const i = (((from + step) % n) + n) % n;
      if (!bad[list[i].label]) return i;
    }
    return (((from + 1) % n) + n) % n;
  }

  /**
   * Открыт ли сейчас чат/рум, соответствующий цели обхода.
   *
   * Для цели с румом достаточно и того, что клиент показывает заголовок темы,
   * но не отдал её id (см. adoptTopicFromWhitelist) — иначе обход вечно считал бы
   * переход неудачным и дёргал вкладку.
   */
  function walkTargetMatches(target, chat) {
    if (!target || !chat) return false;
    const key = chatKeyOf(chat);

    if (target.chatKey) {
      if (key !== target.chatKey) return false;
      if (target.topicId == null) return true;
      const topicId = chat.topicId != null && chat.topicId !== '' ? Number(chat.topicId) : null;
      if (topicId === target.topicId) return true;
      return topicId == null && topicCandidates(chat).length > 0;
    }

    // цель задана названием (запись «Граница :: Очередь BY-PL») — сравниваем тексты
    const wanted = squashTitle(target.topic || target.value);
    if (!wanted) return false;
    const titles = chatTitleCandidates(chat).concat(topicCandidates(chat));
    return titles.some((t) => t === wanted || t.includes(wanted) || wanted.includes(t));
  }

  /**
   * Решение одного такта обхода — вся логика «читать / ждать / переходить» здесь,
   * чистой функцией (так её можно проверить тестами без браузера).
   *
   * Ограничения, которые делают обход похожим на человека и не дают ему
   * разогнаться: случайная пауза перед каждым переходом, предел переходов в час,
   * запрет переключать чат, пока пользователь сам печатает или кликает, и
   * несколько проходов чтения на одном чате (не «пролистнуть и убежать»).
   */
  function walkDecision(input, settings) {
    const s = settings || {};
    const now = input.now || Date.now();
    const plan = input.plan || [];
    if (!s.autoWalk) return { action: 'off' };
    if (plan.length === 0) return { action: 'idle', reason: 'empty', note: 'Белый список пуст — обходить нечего.' };
    if (input.switching) {
      return { action: 'wait-load', target: plan[input.index] || plan[0], reason: 'load', note: 'Открываю чат, жду пока дорисуется…' };
    }

    const index = Number.isInteger(input.index) && input.index >= 0 && input.index < plan.length ? input.index : 0;
    const target = plan[index];
    const next = (index + 1) % plan.length;

    const nextAt = Number(input.nextAt) || 0;
    if (nextAt > now) {
      return {
        action: 'wait', reason: 'pause', target, waitSec: Math.ceil((nextAt - now) / 1000),
        note: 'Пауза перед переходом: ' + Math.ceil((nextAt - now) / 1000) + ' с (дальше «' + (plan[next] || target).label + '»).',
      };
    }
    const guardMs = (Number(s.walkIdleGuardSec) || 0) * 1000;
    const idleFor = input.lastUserActivity ? now - Number(input.lastUserActivity) : Infinity;
    if (guardMs > 0 && idleFor < guardMs) {
      return {
        action: 'wait', reason: 'user', target,
        note: 'Вы сами работаете во вкладке — чат не переключаю ещё ' + Math.ceil((guardMs - idleFor) / 1000) + ' с.',
      };
    }
    const stamps = walkSwitchesInHour(input.switches, now);
    const limit = Number(s.walkMaxPerHour) || DEFAULT_SETTINGS.walkMaxPerHour;
    if (stamps.length >= limit) {
      return {
        action: 'wait', reason: 'limit', target, switchesHour: stamps.length,
        note: 'Предел переходов в час (' + limit + ') достигнут — обход подождёт.',
      };
    }
    const reads = Number(input.reads) || 0;
    const readsPerChat = Number(s.walkReadsPerChat) || DEFAULT_SETTINGS.walkReadsPerChat;
    if (reads >= readsPerChat) {
      return {
        action: 'navigate', target: plan[next], from: target, index: next, switchesHour: stamps.length,
        note: 'Перехожу в «' + plan[next].label + '».',
      };
    }
    return { action: 'read', target, reads, reason: 'read', note: 'Читаю «' + target.label + '» (проход ' + (reads + 1) + ' из ' + readsPerChat + ').' };
  }

  /** Как подписать вердикт по сообщению в панели и в диагностике. */
  const VERDICT_LABELS = {
    listing: '🟢 объявление',
    rejected: '⚪ отсеяно',
    duplicate: '🔁 уже отправляли',
    old: '🕑 старое',
    sent: '✅ ушло на сервер',
  };

  /** Почему детект решил именно так (reason из detect()). */
  const REASON_LABELS = {
    ok: 'есть признаки объявления',
    short: 'короче 10 символов',
    too_long: 'длиннее 4000 символов',
    passenger: 'про поездку людей, без посылок',
    chatter: 'нет признаков объявления (обычная переписка)',
    no_contact: 'нет контакта для связи',
    old: 'старше окна сбора',
    duplicate: 'уже отправляли это сообщение',
  };

  function explainReason(reason) {
    if (!reason) return '';
    return REASON_LABELS[reason] || reason;
  }

  /**
   * Одна строка журнала разбора — «что расширение увидело и что решило».
   * `rec` — запись из state.recent контент-скрипта (см. rememberExamined).
   */
  function verdictLine(rec) {
    const r = rec || {};
    const label = VERDICT_LABELS[r.verdict] || r.verdict || '—';
    const who = r.author ? r.author + ': ' : '';
    const text = '"' + String(r.text || '') + '"';
    const why = r.reason ? ' — ' + explainReason(r.reason) : '';
    const link = r.link ? ' → ' + r.link : ' (ссылки нет: id сообщения не прочитался)';
    const sent = r.sent ? ' ✅ отправлено' : '';
    return label + ' · ' + who + text + why + sent + '\n    ' + link;
  }

  function diagnostic(report) {
    const r = report || {};
    const lines = [];
    lines.push('URL: ' + (r.url || '—'));
    lines.push('Чат: ' + (r.chat && r.chat.title ? r.chat.title : 'не определён') +
      (r.chat && r.chat.username ? ' (@' + r.chat.username + ')' : '') +
      ' → chatId ' + (r.chatKey || '—'));
    if (r.chat && (r.chat.topicTitle || r.chat.topicId != null)) {
      lines.push('Рум (тема): ' + (r.chat.topicTitle || '—') +
        (r.chat.topicId != null ? ' (id ' + r.chat.topicId + ')' : '') +
        (r.chat.topicIdSource === 'whitelist' ? ' — id из белого списка' : ''));
    }
    if (r.chat && r.chat.groupTitle) lines.push('Группа: ' + r.chat.groupTitle);
    lines.push('В белом списке: ' + (r.whitelisted ? 'да' : 'нет') +
      (r.whitelistNote ? ' — ' + r.whitelistNote : ''));
    lines.push('Сообщений прочитано: ' + (r.total || 0) + ' (стратегия: ' + (r.strategy || '—') + ')');
    lines.push('К отправке: ' + (r.toSend || 0) + ', уже отправлено: ' + (r.alreadySent || 0) +
      ', отсеяно детектом: ' + (r.filtered || 0));
    if (r.reasons) {
      const parts = Object.keys(r.reasons).map((k) => k + ' ' + r.reasons[k]);
      if (parts.length) lines.push('Причины отсева: ' + parts.join(', '));
    }
    if (r.unreadable) lines.push('⚠ НЕ МОГУ ПРОЧИТАТЬ СООБЩЕНИЯ: разметка Telegram Web изменилась или чат пуст.');
    // Прозрачность: показываем КАЖДОЕ просмотренное сообщение и вердикт по нему,
    // чтобы было видно, что расширение действительно работает и что оно нашло.
    if (r.recent && r.recent.length) {
      lines.push('Что разобрали (' + r.recent.length + ' последних):');
      for (const rec of r.recent) lines.push('  ' + verdictLine(rec).split('\n').join('\n  '));
    } else if (r.total) {
      lines.push('Что разобрали: — (в этом проходе сообщения не разбирались)');
    }
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
    explainTabError,
    normalizePeerId,
    whitelistMismatch,
    adoptTopicFromWhitelist,
    chatTitleCandidates,
    topicCandidates,
    walkTargets,
    walkHashFor,
    walkPauseMs,
    walkSwitchesInHour,
    walkIndexForChat,
    walkNextIndex,
    walkTargetMatches,
    walkDecision,
    clientFlavor,
    VERDICT_LABELS,
    REASON_LABELS,
    explainReason,
    verdictLine,
    normalizeWhitelist,
    normalizeWhitelistEntry,
    matchesWhitelist,
    squashTitle,
    chatKeyOf,
    messageLink,
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
