/**
 * Чтение DOM Telegram Web — ТОЛЬКО ЧТЕНИЕ (ТЗ п. 4.5).
 *
 * Никаких кликов, отправок, реакций и пересылок: мы лишь смотрим, что уже
 * отрисовано в открытой вкладке на аккаунте заказчика.
 *
 * Telegram Web существует в двух клиентах (/k/ — «K», /a/ — «A»), и разметка
 * у них разная и периодически меняется. Поэтому:
 *   1. каждое поле ищем по СПИСКУ кандидатов-селекторов (стратегии), а не по
 *      одному признаку;
 *   2. если сообщения не находятся вовсе — честно сообщаем «не могу прочитать
 *      сообщения», а не молча работаем вхолостую;
 *   3. messageId берём из атрибутов/ссылок, а если клиент их не отдаёт —
 *      синтезируем устойчивый id (core.syntheticMessageId): серверная
 *      дедупликация по (chatId, messageId) при этом продолжает работать.
 *
 * Формат UMD — как у core.js: подключается обычным <script> и тестируется
 * без браузера (tests/extension-dom.test.ts). Расширение .js обязательно:
 * .cjs Chrome не считает JavaScript и не внедряет контент-скрипт вовсе.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PoputkaDom = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- */
  /* Селекторы: кандидаты в порядке убывания надёжности                */
  /* ---------------------------------------------------------------- */

  /** Контейнеры одного сообщения (K: .bubble, A: .message-list-item, …). */
  const MESSAGE_CONTAINERS = [
    '.bubbles .bubble',
    '.bubble[data-mid]',
    '[data-mid]',
    '.message-list-item',
    '.messages .msg',
    '.im-message',
    '[class*="bubble"]',
  ];

  /** Текст сообщения внутри контейнера. */
  const TEXT_SELECTORS = [
    '.text-content',
    '.message-text',
    '.text-message-content',
    '.bubble-text',
    '.msg-content',
    '[dir="auto"]',
  ];

  /** Имя автора (в группах) внутри контейнера. */
  const AUTHOR_SELECTORS = [
    '.peer-title',
    '.author-name',
    '.user-title',
    '.message-author',
    '.from-name',
    '.sender-name',
  ];

  /** Дата/время сообщения. */
  const DATE_SELECTORS = [
    '.date-text',
    '.MessageDate',
    '.message-date',
    '.date',
    'time',
    '[title]',
  ];

  /** Атрибуты, где клиент может держать числовой id сообщения. */
  const ID_ATTRS = ['data-mid', 'data-message-id', 'data-msg-id', 'data-id', 'data-mes-id', 'data-msgid'];

  /** Заголовок текущего чата. */
  const CHAT_TITLE_SELECTORS = [
    '.chat-info .peer-title',
    '.chat-info .user-title',
    '.chat-info-title',
    '.conversation-title',
    'header .peer-title',
    '.sidebar-header .peer-title',
    '#chat-info-title',
  ];

  /** Юзернейм/ссылка чата (если клиент их показывает). */
  /**
   * Рум (топик) форум-супергруппы: в Telegram Web внутри темы шапка показывает
   * ИМЯ ТЕМЫ, а имя группы — в отдельном элементе (или не показывается вовсе).
   * Поэтому читаем оба варианта и отдаём наружу как topicTitle/groupTitle.
   */
  const TOPIC_TITLE_SELECTORS = [
    '.chat-info .topic-title',
    '[class*="topic-title"]',
    '.topics-container .peer-title',
    '.chat-info [data-topic-id]',
  ];

  /** Имя группы, когда открыт рум (кандидаты — сверху вниз). */
  const GROUP_TITLE_SELECTORS = [
    '.chat-info .group-title',
    '[class*="forum"] .peer-title',
    '.chat-info .status',
    '.sidebar-header .peer-title',
  ];

  const CHAT_USERNAME_SELECTORS = [
    '.chat-info .username',
    '.chat-info-username',
    '.user-status',
    '.peer-status',
  ];

  /* ---------------------------------------------------------------- */
  /* Утилиты по узлам (duck-typed — тестируются на простых объектах)    */
  /* ---------------------------------------------------------------- */

  /** textContent/innerText узла, нормализованный (переносы строк сохраняем). */
  function textOf(node) {
    if (!node) return '';
    const raw = typeof node.innerText === 'string' && node.innerText
      ? node.innerText
      : (typeof node.textContent === 'string' ? node.textContent : '');
    return String(raw).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** Значение первого найденного атрибута из списка. */
  function attrOf(node, names) {
    if (!node || typeof node.getAttribute !== 'function') return null;
    for (const name of names) {
      const v = node.getAttribute(name);
      if (v !== null && v !== undefined && String(v).trim() !== '') return String(v).trim();
    }
    return null;
  }

  /** Первый потомок, подходящий под один из селекторов. */
  function pickFirst(node, selectors) {
    if (!node || typeof node.querySelector !== 'function') return null;
    for (const sel of selectors) {
      let found = null;
      try { found = node.querySelector(sel); } catch { found = null; }
      if (found) return found;
    }
    return null;
  }

  /** Все потомки по списку селекторов (первый непустой результат). */
  function pickAll(root, selectors) {
    for (const sel of selectors) {
      let nodes = [];
      try { nodes = Array.from(root.querySelectorAll(sel)); } catch { nodes = []; }
      if (nodes.length) return { selector: sel, nodes };
    }
    return { selector: null, nodes: [] };
  }

  /* ---------------------------------------------------------------- */
  /* messageId: атрибут → ссылка → null (дальше синтезирует core)       */
  /* ---------------------------------------------------------------- */

  /** Числовой id сообщения из атрибутов или ссылок внутри контейнера. */
  function messageIdFromNode(node) {
    const fromAttr = attrOf(node, ID_ATTRS);
    const fromAttrId = toMessageId(fromAttr);
    if (fromAttrId !== null) return { id: fromAttrId, source: 'attr' };

    // ссылка на сообщение: t.me/<chat>/<id> или #<id> внутри контейнера
    if (node && typeof node.querySelectorAll === 'function') {
      let links = [];
      try { links = Array.from(node.querySelectorAll('a[href]')); } catch { links = []; }
      for (const a of links) {
        const href = (typeof a.getAttribute === 'function' && a.getAttribute('href')) || a.href || '';
        const m = /t\.me\/(?:s\/)?[A-Za-z][A-Za-z0-9_]*\/(\d+)/i.exec(String(href)) ||
          /^#(\d{2,}$)/.exec(String(href));
        const id = m ? toMessageId(m[1]) : null;
        if (id !== null) return { id, source: 'link' };
      }
    }
    return { id: null, source: 'none' };
  }

  /**
   * Клиент может хранить id как есть («12345»), как «12345_67890»
   * (peerId_messageId) или с префиксом («mid:12345»). Берём подходящее
   * положительное целое, а в составных форматах — ПОСЛЕДНЮЮ группу цифр:
   * первой там обычно идёт peerId, одинаковый у всех сообщений чата.
   */
  function toMessageId(raw) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    if (!s) return null;
    if (/^-\d+$/.test(s)) return null; // отрицательные — это peerId, не номер сообщения
    if (/^\d{1,15}$/.test(s)) {
      const n = Number(s);
      return n > 0 ? n : null;
    }
    const groups = s.match(/\d{1,15}/g);
    if (!groups || !groups.length) return null;
    const n = Number(groups[groups.length - 1]);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  /* ---------------------------------------------------------------- */
  /* Дата сообщения из подписи вида «14:32», «вчера», «12.09»           */
  /* ---------------------------------------------------------------- */

  const MONTHS = {
    'янв': 1, 'фев': 2, 'мар': 3, 'апр': 4, 'мая': 5, 'май': 5, 'июн': 6, 'июл': 7,
    'авг': 8, 'сен': 9, 'окт': 10, 'ноя': 11, 'дек': 12,
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
    'январ': 1, 'феврал': 2, 'март': 3, 'апрел': 4, 'июн': 6, 'июл': 7, 'август': 8,
    'сентябр': 9, 'октябр': 10, 'ноябр': 11, 'декабр': 12,
  };

  /**
   * Название месяца по любому его началу: «сентября» → 9, «мая» → 5,
   * «sept» → 9. Таблица выше хранит основы, а в разметке встречаются падежи.
   */
  function monthOf(word) {
    const w = String(word || '').toLowerCase().replace(/[^а-яёa-z]/g, '');
    for (let len = Math.min(w.length, 9); len >= 3; len--) {
      const m = MONTHS[w.slice(0, len)];
      if (m) return m;
    }
    return null;
  }

  /**
   * Подпись даты → миллисекунды. Понимает:
   *   ISO («2026-09-12T14:32:00Z» и без пояса), «14:32» (сегодня/вчера),
   *   «вчера»/«yesterday»/«позавчера», «12.09», «12.09.26», «12 сентября»,
   *   «Sep 12».
   * Не разобрал → null: тогда возраст проверит сервер (INGEST_MAX_AGE_DAYS),
   * а не «на глаз».
   */
  function parseDomDate(raw, now) {
    const s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    // в подписи даты всегда есть цифры (или слово «вчера»/«позавчера»)
    if (!/\d/.test(s) && !/(вчера|позавчера|yesterday)/i.test(s)) return null;
    const ref = now ? new Date(now) : new Date();

    /* 1. Полная ISO-дата (атрибут time[datetime]) — разбирается без догадок. */
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) {
      const direct = Date.parse(s); // с Z или ±HH:MM — абсолютное время
      if (Number.isFinite(direct)) return direct;
      const m = /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(s);
      if (m) {
        const local = Date.parse(`${m[1]}T${m[2]}:00`); // без пояса — локальное
        if (Number.isFinite(local)) return local;
      }
    }

    const lower = s.toLowerCase();
    let dayOffset = 0;
    if (/позавчера/.test(lower)) dayOffset = -2;
    else if (/(вчера|yesterday)/.test(lower)) dayOffset = -1;

    const time = /(\d{1,2}):(\d{2})/.exec(s);
    const numeric = /(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?/.exec(s);
    // «12 сентября» / «12 сен.» и английский порядок «Sep 12»
    const namedRu = /(\d{1,2})\s*([а-яёa-z]{3,9})\.?/.exec(lower);
    const namedEn = /([a-z]{3,9})\.?\s+(\d{1,2})/.exec(lower);
    let namedMonth = null;
    let namedDay = null;
    if (namedRu) {
      const m = monthOf(namedRu[2]);
      if (m) { namedMonth = m; namedDay = Number(namedRu[1]); }
    }
    if (!namedMonth && namedEn) {
      const m = monthOf(namedEn[1]);
      if (m) { namedMonth = m; namedDay = Number(namedEn[2]); }
    }

    let year = ref.getFullYear();
    let month = ref.getMonth(); // 0-based
    let day = ref.getDate();
    let explicitYear = false;

    if (numeric) {
      day = Number(numeric[1]);
      month = Number(numeric[2]) - 1;
      if (numeric[3]) {
        year = Number(numeric[3]);
        if (year < 100) year += 2000;
        explicitYear = true;
      }
    } else if (namedMonth && namedDay) {
      day = namedDay;
      month = namedMonth - 1;
    }
    const hasOwnDate = Boolean(numeric) || Boolean(namedMonth && namedDay);

    /* 2. «вчера 18:20» — своя дата важнее слова не бывает, слово и есть дата. */
    if (dayOffset && !hasOwnDate) {
      return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + dayOffset,
        time ? Number(time[1]) : 0, time ? Number(time[2]) : 0, 0, 0).getTime();
    }

    const hour = time ? Number(time[1]) : 0;
    const minute = time ? Number(time[2]) : 0;
    let result = new Date(year, month, day, hour, minute, 0, 0);
    if (Number.isNaN(result.getTime())) return null;

    if (!hasOwnDate && !dayOffset) {
      // «14:32» без даты: если время ещё не наступило — это вчера (ночные чаты)
      if (result.getTime() > ref.getTime() + 3600 * 1000) {
        return new Date(year, month, day - 1, hour, minute, 0, 0).getTime();
      }
      return result.getTime();
    }

    // «31.12» в январской ленте — это прошлый год: сообщения из будущего не приходят
    if (!explicitYear && result.getTime() > ref.getTime() + 12 * 3600 * 1000) {
      result = new Date(year - 1, month, day, hour, minute, 0, 0);
    }
    return result.getTime();
  }

  /* ---------------------------------------------------------------- */
  /* Текущий чат                                                       */
  /* ---------------------------------------------------------------- */

  /** Заголовок вкладки → название чата: «(2) Водители — Telegram Web» → «Водители». */
  function cleanDocTitle(raw) {
    return String(raw || '')
      .replace(/^\(\d+\)\s*/, '')                 // счётчик непрочитанных
      .replace(/\s*[—–|]\s*Telegram.*$/i, '')     // «… — Telegram Web»
      .replace(/\s*[-|]\s*Telegram Web.*$/i, '')
      .replace(/^Telegram Web(?:\s*\w+)?\s*[—–|:]\s*/i, '') // «Telegram Web K: …»
      .trim();
  }

  /**
   * Что за чат открыт: название, юзернейм (если виден), числовой peer-id.
   *
   * Юзернейм важен: по нему core.chatKeyOf() даёт ключ 'web:<username>' — тот же,
   * что у серверного сборщика, поэтому одно сообщение из двух источников
   * не превратится в две заявки. Ищем его в URL (#@username, t.me/…) и в шапке чата.
   *
   * `doc` — document (или его подобие в тестах), `location` — для hash/href.
   */
  function readChatInfo(doc, location) {
    const titleNode = pickFirst(doc, CHAT_TITLE_SELECTORS);
    const title = textOf(titleNode) ||
      (doc && typeof doc.title === 'string' ? cleanDocTitle(doc.title) : '');

    const usernameNode = pickFirst(doc, CHAT_USERNAME_SELECTORS);
    const fromNode = /@([A-Za-z][A-Za-z0-9_]{3,31})/.exec(textOf(usernameNode) || '');

    // Рум и группа — дополнительно к заголовку (см. TOPIC_TITLE_SELECTORS)
    const topicFromDom = cleanDocTitle(textOf(pickFirst(doc, TOPIC_TITLE_SELECTORS)) || '');
    const groupFromDom = cleanDocTitle(textOf(pickFirst(doc, GROUP_TITLE_SELECTORS)) || '');

    // URL клиента: /k/#@username, /k/#-1001234567890, /a/#/im?p=g1234567890,
    // /a/#/im?p=u123456, ?p=c123456, /a/#/im?p-1001234567890
    const hash = String((location && location.hash) || '');
    const href = String((location && location.href) || '');
    const loc = hash + ' ' + href;
    const linkUser = /t\.me\/(?:s\/)?@?([A-Za-z][A-Za-z0-9_]{3,31})(?!\/?\d)/i.exec(loc);
    const hashUser = /#@([A-Za-z][A-Za-z0-9_]{3,31})(?![A-Za-z0-9_])/.exec(loc) ||
      /#\/(?:im\/)?@([A-Za-z][A-Za-z0-9_]{3,31})(?![A-Za-z0-9_])/.exec(loc);
    const peerRaw = /[?&/#]p=([guc]-?\d{4,})/.exec(loc) ||
      /[#/]p([guc]?-?\d{4,})(?!\d)/.exec(loc) ||
      /#([guc]-?\d{4,})(?![A-Za-z0-9_])/.exec(loc) ||
      /#(-?\d{5,})(?!\d)/.exec(loc);
    const peer = normalizePeer(peerRaw && peerRaw[1]);

    // Рум по URL: ?topic=12, &thread=12, p=g123_12, #/im/p-100123_12, #-100123_12
    const topicRaw = /[?&]topic=(\d{1,12})/.exec(loc) || /[?&]thread=(\d{1,12})/.exec(loc) ||
      /p=[guc]-?\d{4,}_(\d{1,12})/.exec(loc) ||
      /[#/]p[guc]?-?\d{4,}_(\d{1,12})(?!\d)/.exec(loc) ||
      /#-?\d{5,}_(\d{1,12})(?!\d)/.exec(loc);

    // Если в шапке тема, а группа прочиталась отдельно — заголовок это имя рума
    const groupTitle = groupFromDom || null;
    const topicTitle = topicFromDom || (groupTitle && title ? title : null);

    return {
      title: title || null,
      username: (linkUser && linkUser[1]) || (hashUser && hashUser[1]) || (fromNode && fromNode[1]) || null,
      id: peer ? peer.id : null,
      kind: peer ? peer.kind : null,
      groupTitle: groupTitle,
      topicTitle: topicTitle && topicTitle !== groupTitle ? topicTitle : null,
      topicId: topicRaw ? Number(topicRaw[1]) : null,
    };
  }

  /**
   * peer-id из URL Telegram Web → канонический вид (тот же, что core.normalizePeerId).
   * Здесь своя копия: dom.js должен работать и без ядра (юзерскрипт грузит их вместе,
   * но порядок не гарантирован во всех сборках).
   */
  function normalizePeer(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    let m = /^[gG](\d{4,})$/.exec(s);
    if (m) return { id: '-100' + m[1], kind: 'supergroup' };
    m = /^[cC](\d{4,})$/.exec(s);
    if (m) return { id: '-' + m[1], kind: 'group' };
    m = /^[uU](\d{4,})$/.exec(s);
    if (m) return { id: m[1], kind: 'user' };
    if (/^-100\d{4,}$/.test(s)) return { id: s, kind: 'supergroup' };
    if (/^-\d{4,}$/.test(s)) return { id: s, kind: 'group' };
    if (/^\d{4,}$/.test(s)) return { id: s, kind: 'user' };
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* Сбор сообщений                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Прочитать сообщения открытого чата.
   * Возвращает сырые сообщения (без chatId — его добавляет core.toPayloadMessage)
   * и диагностику: какой стратегией нашли и нашли ли вообще.
   */
  function harvest(doc, opts) {
    const options = opts || {};
    const root = options.root || doc;
    const { selector, nodes } = pickAll(root, MESSAGE_CONTAINERS);
    if (!nodes.length) {
      return { messages: [], strategy: null, total: 0, unreadable: true, counts: {} };
    }

    const messages = [];
    const counts = { no_text: 0, dup: 0, service: 0, ok: 0, syntheticId: 0, idCollision: 0 };
    const seenTexts = new Set();
    const limit = Math.max(1, options.limit || 30);

    // идём с конца: в Telegram Web новые сообщения внизу списка
    for (let i = nodes.length - 1; i >= 0 && messages.length < limit; i--) {
      const node = nodes[i];
      const textNode = pickFirst(node, TEXT_SELECTORS) || node;
      const text = textOf(textNode);
      if (!text || text.length < 2) { counts.no_text++; continue; }

      // сервисные и системные строки объявлениями не являются
      const cls = String((node.className && node.className.baseVal !== undefined
        ? node.className.baseVal
        : node.className) || '');
      if (/service|date-divider|message-date-separator|empty|placeholder/i.test(cls)) { counts.service++; continue; }
      if (/joined the group|присоединил|создал канал|created the channel|изменил(?:а)? (?:название|фото)|закрепил/i.test(text)) {
        counts.service++;
        continue;
      }

      const signature = text.replace(/\s+/g, ' ').slice(0, 300);
      if (seenTexts.has(signature)) { counts.dup++; continue; }
      seenTexts.add(signature);

      const idInfo = messageIdFromNode(node);
      if (idInfo.id === null) counts.syntheticId++;

      const dateNode = pickFirst(node, DATE_SELECTORS);
      const dateRaw = (dateNode && (attrOf(dateNode, ['datetime', 'title', 'aria-label']) || textOf(dateNode))) || '';

      const authorNode = pickFirst(node, AUTHOR_SELECTORS);
      const authorName = textOf(authorNode) || null;
      const at = authorName ? /@([A-Za-z][A-Za-z0-9_]{3,31})/.exec(authorName) : null;

      messages.push({
        text,
        messageId: idInfo.id,
        idSource: idInfo.source,
        dateMs: parseDomDate(dateRaw, options.now),
        dateRaw: dateRaw || null,
        authorName: at ? null : authorName,
        authorUsername: at ? '@' + at[1] : null,
      });
      counts.ok++;
    }

    /*
     * Защита от «схлопывания» id. Если клиент отдаёт составной id и мы взяли
     * не ту его часть (например peerId вместо номера сообщения), все сообщения
     * чата получат один и тот же messageId — серверная дедупликация по паре
     * (chatId, messageId) посчитает их дублями, и сбор встанет молча.
     * Видим повтор id в пределах прочитанного окна → обнуляем его, и core
     * синтезирует устойчивый id из (chatId, текст, дата).
     */
    const idCounts = new Map();
    for (const m of messages) {
      if (m.messageId === null) continue;
      idCounts.set(m.messageId, (idCounts.get(m.messageId) || 0) + 1);
    }
    for (const m of messages) {
      if (m.messageId !== null && (idCounts.get(m.messageId) || 0) > 1) {
        m.messageId = null;
        m.idSource = 'collision';
        counts.idCollision++;
        counts.syntheticId++;
      }
    }

    // в ответе — по возрастанию времени/id, как требует контракт
    messages.reverse();
    return { messages, strategy: selector, total: nodes.length, unreadable: false, counts };
  }

  /** Жив ли клиент: видно ли хоть что-то похожее на список сообщений. */
  function isReadable(doc) {
    const { nodes } = pickAll(doc, MESSAGE_CONTAINERS);
    return nodes.length > 0;
  }

  return {
    MESSAGE_CONTAINERS,
    TEXT_SELECTORS,
    AUTHOR_SELECTORS,
    DATE_SELECTORS,
    ID_ATTRS,
    CHAT_TITLE_SELECTORS,
    CHAT_USERNAME_SELECTORS,
    textOf,
    attrOf,
    pickFirst,
    pickAll,
    messageIdFromNode,
    toMessageId,
    monthOf,
    parseDomDate,
    cleanDocTitle,
    readChatInfo,
    harvest,
    isReadable,
  };
});
