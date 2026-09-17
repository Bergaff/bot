/**
 * Content script сборщика для Telegram Web (ТЗ п. 4.5).
 *
 * Работает в открытой вкладке на аккаунте заказчика и ТОЛЬКО ЧИТАЕТ DOM:
 * ни кликов, ни отправки сообщений, ни реакций, ни пересылок.
 *
 * Порядок прохода:
 *   1. настройки (chrome.storage/localStorage) — нет сервера или токена → стоим;
 *   2. какой чат открыт; не входит в белый список → сообщения не читаем вовсе;
 *   3. читаем последние N сообщений (PoputkaDom.harvest);
 *   4. клиентский детект на бандле src/parser.ts: пассажирские и болтовня
 *      отсеиваются здесь, на сервер идёт только похожее на объявление;
 *   5. локальная дедупликация (лог отправленного) → батчи ≤ batchSize;
 *   6. POST /api/ingest с Bearer INGEST_TOKEN; дубли от сервера — штатный ответ;
 *   7. счётчики и ошибки — в панель; 401/503 → стоим и показываем ошибку,
 *      429/5xx → backoff, разметка не читается → «не могу прочитать сообщения».
 */
(function () {
  'use strict';

  /* Повторное внедрение не должно плодить второй слушатель и второй таймер:
   * манифест внедряет скрипт при загрузке страницы, а попап умеет подключить его
   * к уже открытой вкладке сам (chrome.scripting.executeScript). Живой экземпляр
   * есть — выходим; экземпляр мёртв (расширение обновили, контекст инвалидирован) —
   * останавливаем его таймер и запускаемся заново. */
  const scope = (typeof window !== 'undefined' && window) ? window : globalThis;
  const extId = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) || 'unknown';
  const prev = scope.__poputchkaBoot;
  if (prev && prev.extId === extId) {
    let alive = false;
    try { alive = Boolean(prev.live && prev.live()); } catch { alive = false; }
    if (alive) return;
    try { prev.stop && prev.stop(); } catch { /* старый экземпляр уже не остановить */ }
  }

  /* Слушатель сообщений регистрируется ПЕРВЫМ делом: даже если что-то ниже
   * упадёт, попап получит ответ с текстом ошибки, а не «вкладка не отвечает». */
  const boot = {
    version: '1.0.2',
    startedAt: Date.now(),
    ok: false,
    error: null,
    // true, если это повторное внедрение вместо умершего экземпляра
    reinjected: Boolean(prev),
  };

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      (async () => {
        try {
          sendResponse(await handleMessage(msg));
        } catch (e) {
          try { sendResponse({ ok: false, boot, error: String(e && e.message || e) }); } catch { /* канал закрыт */ }
        }
      })();
      return true; // ответ асинхронный
    });
  }

  let core = null;
  let dom = null;
  let parser = null;
  let store = null;

  const NS = 'poputchka';

  const state = {
    settings: { whitelist: [], intervalSec: 120, batchSize: 20, maxPerChat: 30, confirmMode: true, paused: false, maxAgeHours: 72, requireContact: false, serverUrl: '', token: '' },
    counters: {},
    sentKeys: [],
    pending: [],          // найдено, но ждёт подтверждения (confirmMode)
    error: null,
    status: 'инициализация…',
    attempt: 0,
    backoffUntil: 0,
    timer: null,
    lastDiagnostic: null,
    unreadable: false,
    clientId: null,       // метка этого браузера для панели (heartbeat)
    lastChat: null,       // какой чат/рум видели последним
    configFromServer: false,
    configError: null,
  };

  /* Метка живого экземпляра: по ней повторное внедрение понимает, что работать уже не надо. */
  scope.__poputchkaBoot = {
    extId,
    boot,
    live: () => {
      try {
        // вне расширения (юзерскрипт) chrome может не быть вовсе — экземпляр при этом жив
        if (typeof chrome === 'undefined' || !chrome.runtime) return true;
        return Boolean(chrome.runtime.id);
      } catch {
        return false; // «Extension context invalidated» — экземпляр мёртв
      }
    },
    stop: () => {
      try {
        if (state.timer) clearInterval(state.timer);
        state.timer = null;
      } catch { /* таймер мог не завестись */ }
    },
  };

  try {
    core = (typeof PoputkaCore !== 'undefined') ? PoputkaCore : require('./core.js');
    dom = (typeof PoputkaDom !== 'undefined') ? PoputkaDom : require('./dom.js');
    parser = (typeof PoputkaParser !== 'undefined') ? PoputkaParser : null;
    store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
      ? core.chromeStore(NS)
      : core.localStore(NS);
    state.settings = core.withDefaults({});
  } catch (e) {
    boot.error = 'не удалось загрузить ядро сборщика: ' + String(e && e.message || e) +
      ' (переустановите расширение: chrome://extensions → «Обновить», затем F5 на web.telegram.org)';
  }

  /** Состояние для попапа — даже если часть модулей не загрузилась. */
  function safeState() {
    try { return publicState(); } catch (e) { return { error: String(e && e.message || e) }; }
  }

  /* ---------------------------------------------------------------- */
  /* Хранилище                                                         */
  /* ---------------------------------------------------------------- */

  async function loadState() {
    const saved = await store.read();
    state.settings = core.withDefaults(saved.settings);
    state.counters = saved.counters || {};
    state.sentKeys = Array.isArray(saved.sentKeys) ? saved.sentKeys : [];
    state.clientId = saved.clientId || newClientId();
  }

  /** Метка этого браузера: панель показывает, какие аккаунты подключены. */
  function newClientId() {
    const rnd = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
    return String(rnd).slice(0, 36);
  }

  async function persist() {
    await store.write({
      settings: state.settings,
      counters: state.counters,
      sentKeys: core.pruneSentLog(state.sentKeys),
      clientId: state.clientId,
      // отметка «я жив» — по ней попап объясняет «вкладка не отвечает»
      alive: {
        at: Date.now(), ok: boot.ok, error: boot.error, version: boot.version,
        url: (typeof location !== 'undefined' && location.href) || null,
        status: state.status,
      },
    });
  }

  /* ---------------------------------------------------------------- */
  /* Отправка                                                          */
  /* ---------------------------------------------------------------- */

  async function postBatch(messages) {
    const url = state.settings.serverUrl + '/api/ingest';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.settings.token },
      body: JSON.stringify(core.buildPayload(messages, { collector: core.COLLECTOR })),
      // читающий режим: кэшировать нечего
      cache: 'no-store',
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: res.status, ok: res.ok, body, retryAfter: Number(res.headers.get('Retry-After')) || null };
  }

  /** Отправить всё, что накопилось (батчами). */
  async function sendPending(opts) {
    const options = opts || {};
    if (!state.settings.serverUrl || !state.settings.token) {
      state.error = 'Не заданы сервер или INGEST_TOKEN — откройте попап расширения.';
      render();
      return;
    }
    const queue = options.messages || state.pending;
    if (!queue.length) { state.status = 'нет новых сообщений'; render(); return; }

    const batches = core.chunk(queue, state.settings.batchSize);
    for (const batch of batches) {
      try {
        const { status, ok, body, retryAfter } = await postBatch(batch);
        if (!ok) {
          const kind = core.classifyStatus(status);
          state.attempt++;
          if (kind === 'backoff') {
            const wait = retryAfter ? retryAfter * 1000 : core.backoffMs(state.attempt);
            state.backoffUntil = Date.now() + wait;
            state.error = `Сервер ответил ${status}. Подождём ${Math.round(wait / 1000)} с и повторим.`;
          } else if (kind === 'stop_auth') {
            state.backoffUntil = Infinity;
            state.error = 'Токен не принят (401). Проверьте INGEST_TOKEN в настройках — сбор остановлен.';
          } else if (kind === 'stop_disabled') {
            state.backoffUntil = Infinity;
            state.error = 'Приём выключен на сервере (503): не задан INGEST_TOKEN. Сбор остановлен.';
          } else if (kind === 'stop_payload') {
            state.backoffUntil = Infinity;
            state.error = `Сервер отклонил запрос (${status}): ${body && body.error ? body.error : 'проверьте контракт'}.`;
          } else {
            state.error = `Неожиданный ответ сервера: ${status}`;
          }
          render();
          return;
        }

        // успех: счётчики, лог отправленного, сброс backoff
        state.attempt = 0;
        state.backoffUntil = 0;
        state.error = null;
        const sum = core.summarizeResponse(body);
        state.counters = core.mergeCounters(state.counters, {
          sent: batch.length, received: sum.received, created: sum.created,
          duplicate: sum.duplicate, skipped: sum.skipped, invalid: sum.invalid,
          listings: sum.listings, runs: 1, lastRunAt: new Date().toISOString(),
        });
        for (const key of sum.sentKeys) if (!state.sentKeys.includes(key)) state.sentKeys.push(key);
        state.sentKeys = core.pruneSentLog(state.sentKeys);
        state.status = `отправлено ${batch.length}, заявок ${sum.created}, дублей ${sum.duplicate}`;
      } catch (e) {
        state.attempt++;
        const wait = core.backoffMs(state.attempt);
        state.backoffUntil = Date.now() + wait;
        state.error = 'Нет связи с сервером: ' + (e && e.message ? e.message : e) +
          `. Повтор через ${Math.round(wait / 1000)} с.`;
        render();
        return;
      }
    }

    // отправленные убираем из очереди подтверждения
    const sentIds = new Set(queue.map((m) => core.sentKey(m.chatId, m.messageId)));
    state.pending = state.pending.filter((m) => !sentIds.has(core.sentKey(m.chatId, m.messageId)));
    await persist();
    render();
  }

  /* ---------------------------------------------------------------- */
  /* Один проход чтения                                                */
  /* ---------------------------------------------------------------- */

  async function tick() {
    if (!core || !dom) { state.error = boot.error; render(); return; }

    // настройки может задавать панель (белый список чатов и румов, интервал, пауза)
    await syncConfig();

    if (state.settings.paused) { state.status = 'пауза'; render(); await postHeartbeat(); return; }
    if (Date.now() < state.backoffUntil) {
      state.status = 'ждем: ' + (state.backoffUntil === Infinity ? 'остановлено' : Math.ceil((state.backoffUntil - Date.now()) / 1000) + ' с');
      render();
      await postHeartbeat();
      return;
    }

    const chat = dom.readChatInfo(document, window.location);
    const chatKey = core.chatKeyOf(chat);
    const whitelisted = core.matchesWhitelist(chat, state.settings.whitelist);
    state.lastChat = {
      chatKey: chatKey, title: chat.title, username: chat.username, kind: chat.kind,
      groupTitle: chat.groupTitle, topicTitle: chat.topicTitle, topicId: chat.topicId,
      whitelisted: whitelisted, at: new Date().toISOString(),
    };

    if (!chatKey || !whitelisted) {
      // всё, что не в белом списке, игнорируется ПОЛНОСТЬЮ — сообщения не читаем
      const note = chatKey ? core.whitelistMismatch(chat, state.settings.whitelist) : null;
      state.unreadable = false;
      state.status = !chatKey
        ? 'чат не определён (откройте диалог)'
        : (note || `чат «${chat.title || chatKey}» не в белом списке — пропускаем`);
      state.lastDiagnostic = {
        url: location.href, chat, chatKey, whitelisted, whitelistNote: note, total: 0, toSend: 0,
      };
      render();
      await persist();
      await postHeartbeat();
      return;
    }

    const harvested = dom.harvest(document, { limit: state.settings.maxPerChat, now: Date.now() });
    if (harvested.unreadable || harvested.messages.length === 0) {
      state.unreadable = true;
      state.error = 'Не могу прочитать сообщения: Telegram Web изменил разметку или чат пуст. ' +
        'Сбор paused, пока не починим селекторы (см. extension/dom.js).';
      state.counters = core.mergeCounters(state.counters, { errors: 1 });
      state.lastDiagnostic = {
        url: location.href, chat, chatKey, whitelisted: true,
        total: harvested.total, unreadable: true, strategy: harvested.strategy,
      };
      await persist();
      render();
      return;
    }
    state.unreadable = false;

    const reasons = {};
    const candidates = [];
    let alreadySent = 0;
    for (const raw of harvested.messages) {
      const m = core.toPayloadMessage(Object.assign({}, raw, { chat: Object.assign({ chatId: chatKey }, chat) }), state.settings);
      const verdict = core.detect(m.text, parser, state.settings);
      if (!verdict.send) { reasons[verdict.reason] = (reasons[verdict.reason] || 0) + 1; continue; }
      if (!core.withinAge(m.dateMs, state.settings.maxAgeHours, Date.now())) { reasons.old = (reasons.old || 0) + 1; continue; }
      if (state.sentKeys.includes(core.sentKey(m.chatId, m.messageId))) { alreadySent++; continue; }
      if (state.pending.some((p) => p.chatId === m.chatId && p.messageId === m.messageId)) { alreadySent++; continue; }
      candidates.push(m);
    }

    const fresh = core.filterUnsent(candidates, state.sentKeys);
    state.counters = core.mergeCounters(state.counters, { found: harvested.messages.length });
    state.lastDiagnostic = {
      url: location.href, chat, chatKey, whitelisted: true,
      total: harvested.messages.length, strategy: harvested.strategy,
      toSend: fresh.length, alreadySent, filtered: harvested.messages.length - fresh.length - alreadySent,
      reasons, counts: harvested.counts,
    };

    if (!fresh.length) {
      state.status = `чат «${chat.title}»: прочитано ${harvested.messages.length}, нового нет`;
      await persist();
      render();
      await postHeartbeat();
      return;
    }

    if (state.settings.confirmMode) {
      // режим «спрашивать подтверждение» (по умолчанию включён)
      state.pending = state.pending.concat(fresh);
      state.status = `найдено ${fresh.length} — подтвердите отправку`;
      await persist();
      render();
      await postHeartbeat();
      return;
    }

    state.status = `найдено ${fresh.length} — отправляю`;
    render();
    await sendPending({ messages: fresh });
    await postHeartbeat();
  }

  /* ---------------------------------------------------------------- */
  /* Связь с панелью: настройки оттуда и отметка «аккаунт подключён»    */
  /* ---------------------------------------------------------------- */

  /**
   * Забрать настройки из панели (белый список чатов и румов, интервал, пауза).
   * Сервер без этих ручек отвечает 404 — тогда работаем на локальных настройках.
   */
  async function syncConfig() {
    if (!state.settings.serverUrl || !state.settings.token) return null;
    try {
      const res = await fetch(state.settings.serverUrl + '/api/extension/config', {
        headers: { Authorization: 'Bearer ' + state.settings.token },
        cache: 'no-store',
      });
      if (!res.ok) { state.configFromServer = false; return null; }
      const body = await res.json().catch(() => null);
      const cfg = body && body.config;
      if (!cfg) { state.configFromServer = false; return null; }
      return await applyConfig(cfg);
    } catch (e) {
      state.configError = 'Настройки из панели не получены: ' + String(e && e.message || e);
      return null;
    }
  }

  /** Применить настройки, присланные панелью (белый список чатов и румов, интервал, пауза). */
  async function applyConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') { state.configFromServer = false; return null; }
    const before = JSON.stringify(state.settings);
    if (Array.isArray(cfg.whitelist) || typeof cfg.whitelist === 'string') {
      const list = typeof cfg.whitelist === 'string' ? cfg.whitelist.split(/[\n,;]+/) : cfg.whitelist;
      state.settings.whitelist = list.map((x) => String(x).trim()).filter(Boolean);
    }
    if (cfg.intervalSec != null) {
      state.settings.intervalSec = core.clamp(Number(cfg.intervalSec) || 120, 60, 600);
      restartTimer(); // интервал мог измениться
    }
    if (typeof cfg.paused === 'boolean') state.settings.paused = cfg.paused;
    state.configFromServer = true;
    state.configError = null;
    if (JSON.stringify(state.settings) !== before) { await persist(); render(); }
    return cfg;
  }

  /** Отметка для панели: аккаунт подключён, такой-то чат/рум, такие-то счётчики. */
  async function postHeartbeat() {
    if (!state.settings.serverUrl || !state.settings.token) return;
    try {
      const res = await fetch(state.settings.serverUrl + '/api/extension/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.settings.token },
        body: JSON.stringify({
          clientId: state.clientId || newClientId(),
          collector: core.COLLECTOR,
          at: new Date().toISOString(),
          url: location.href,
          chat: state.lastChat,
          counters: state.counters,
          status: state.status,
          error: state.error,
          pending: state.pending.length,
          unreadable: state.unreadable,
          whitelist: state.settings.whitelist,
          intervalSec: state.settings.intervalSec,
          paused: state.settings.paused,
          confirmMode: state.settings.confirmMode,
        }),
        cache: 'no-store',
      });
      // настройки панель отдаёт вместе с ответом на отметку — одним запросом
      if (res && res.ok) {
        const body = await res.json().catch(() => null);
        if (body && body.config) await applyConfig(body.config);
      }
    } catch {
      // панель не увидит отметку — это не повод останавливать сбор
    }
  }

  /* ---------------------------------------------------------------- */
  /* Панель (своя, в страницу ничего не пишет)                         */
  /* ---------------------------------------------------------------- */

  const STYLE = [
    '#pk-panel{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:320px;max-height:70vh;overflow:auto;',
    'background:#fff;border:1px solid #d7dde3;border-radius:12px;box-shadow:0 8px 28px rgba(15,23,42,.18);',
    'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#0f172a}',
    '#pk-panel *{box-sizing:border-box}',
    '#pk-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #eef1f4;cursor:pointer}',
    '#pk-head b{font-size:13px}',
    '#pk-body{padding:10px 12px}',
    '.pk-row{display:flex;justify-content:space-between;gap:8px;padding:2px 0}',
    '.pk-muted{color:#64748b}',
    '.pk-err{background:#fff1f2;color:#9f1239;border:1px solid #fecdd3;border-radius:8px;padding:6px 8px;margin:6px 0}',
    '.pk-warn{background:#fffbeb;color:#92400e;border:1px solid #fde68a;border-radius:8px;padding:6px 8px;margin:6px 0}',
    '.pk-ok{background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;border-radius:8px;padding:6px 8px;margin:6px 0}',
    '.pk-btn{border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:5px 9px;cursor:pointer;font-size:12px}',
    '.pk-btn:hover{background:#f8fafc}',
    '.pk-btn.primary{background:#0f172a;border-color:#0f172a;color:#fff}',
    '.pk-item{border-top:1px solid #f1f5f9;padding:6px 0;display:flex;gap:8px}',
    '.pk-item label{flex:1;display:flex;gap:6px;align-items:flex-start}',
    '.pk-item small{color:#64748b;display:block}',
    '.pk-btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
    '#pk-panel.pk-collapsed #pk-body{display:none}',
  ].join('\n');

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const k in (attrs || {})) {
      const v = attrs[k];
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of (children || [])) if (c) node.append(c);
    return node;
  }

  function ensurePanel() {
    if (document.getElementById('pk-panel')) return document.getElementById('pk-panel');
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.documentElement.append(style);
    const panel = el('div', { id: 'pk-panel' });
    document.documentElement.append(panel);
    return panel;
  }

  function render() {
    const panel = ensurePanel();
    const c = state.counters || {};
    panel.replaceChildren();

    const head = el('div', {
      id: 'pk-head',
      onclick: () => { panel.classList.toggle('pk-collapsed'); },
    }, [
      el('b', { text: 'попутка. сбор' }),
      el('span', { class: 'pk-muted', text: state.settings.paused ? '⏸ пауза' : (state.unreadable ? '⚠ разметка' : '● работает') }),
      el('span', { class: 'pk-muted', style: 'margin-left:auto', text: 'свернуть' }),
    ]);

    const body = el('div', { id: 'pk-body' }, [
      el('div', { class: 'pk-row' }, [el('span', { class: 'pk-muted', text: 'статус' }), el('span', { text: state.status })]),
      el('div', { class: 'pk-row' }, [el('span', { class: 'pk-muted', text: 'найдено' }), el('span', { text: String(c.found || 0) })]),
      el('div', { class: 'pk-row' }, [el('span', { class: 'pk-muted', text: 'отправлено' }), el('span', { text: String(c.sent || 0) })]),
      el('div', { class: 'pk-row' }, [el('span', { class: 'pk-muted', text: 'заявок создано' }), el('span', { text: String(c.created || 0) })]),
      el('div', { class: 'pk-row' }, [el('span', { class: 'pk-muted', text: 'дублей' }), el('span', { text: String(c.duplicate || 0) })]),
      el('div', { class: 'pk-row' }, [el('span', { class: 'pk-muted', text: 'отсеяно детектом' }), el('span', { text: String(c.skipped || 0) })]),
      state.error
        ? el('div', { class: state.unreadable ? 'pk-warn' : 'pk-err', text: state.error })
        : (c.created ? el('div', { class: 'pk-ok', text: 'Последние заявки ушли в очередь модерации.' }) : null),
    ]);

    if (state.pending.length) {
      body.append(el('div', { class: 'pk-muted', style: 'margin-top:6px', text: 'Ждут подтверждения: ' + state.pending.length }));
      for (const m of state.pending.slice(0, 8)) {
        body.append(el('div', { class: 'pk-item' }, [
          el('label', {}, [
            el('input', { type: 'checkbox', checked: 'checked', 'data-key': core.sentKey(m.chatId, m.messageId) }),
            el('span', {}, [
              el('span', { text: m.text.replace(/\s+/g, ' ').slice(0, 110) + (m.text.length > 110 ? '…' : '') }),
              el('small', { text: m.chatId + ' · #' + m.messageId + (m.idSource === 'synthetic' ? ' · id синтетический' : '') }),
            ]),
          ]),
        ]));
      }
    }

    body.append(el('div', { class: 'pk-btns' }, [
      el('button', {
        class: 'pk-btn primary',
        text: state.pending.length ? `Отправить найденные (${state.pending.length})` : 'Отправить все найденные',
        onclick: () => {
          const boxes = panel.querySelectorAll('.pk-item input[type=checkbox]');
          const chosen = boxes.length
            ? state.pending.filter((m) => {
                const box = panel.querySelector(`.pk-item input[data-key="${CSS.escape(core.sentKey(m.chatId, m.messageId))}"]`);
                return !box || box.checked;
              })
            : state.pending;
          if (!chosen.length) { state.status = 'ничего не выбрано'; render(); return; }
          sendPending({ messages: chosen });
        },
      }),
      el('button', {
        class: 'pk-btn',
        text: state.settings.paused ? 'Продолжить' : 'Пауза',
        onclick: async () => {
          state.settings.paused = !state.settings.paused;
          await persist();
          render();
        },
      }),
      el('button', { class: 'pk-btn', text: 'Диагностика', onclick: () => { showDiagnostic(); } }),
      el('button', {
        class: 'pk-btn', text: 'Настройки', onclick: () => {
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
            // открыть попап из content script нельзя — подсказываем, где он
            state.status = 'Настройки — в попапе расширения (иконка на панели браузера)';
            render();
          } else {
            state.status = 'Юзерскрипт: настройки в localStorage["poputchka"]';
            render();
          }
        },
      }),
    ]));

    panel.append(head, body);
  }

  function showDiagnostic() {
    const text = core.diagnostic(state.lastDiagnostic);
    const panel = ensurePanel();
    const pre = el('pre', {
      style: 'white-space:pre-wrap;background:#0f172a;color:#e2e8f0;padding:8px;border-radius:8px;font-size:11px;margin-top:8px',
      text,
    });
    panel.querySelector('#pk-body').append(pre);
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => undefined);
  }

  /* ---------------------------------------------------------------- */
  /* Запуск                                                            */
  /* ---------------------------------------------------------------- */

  function restartTimer() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => { tick().catch((e) => { state.error = String(e && e.message || e); render(); }); },
      state.settings.intervalSec * 1000);
  }

  /** Перечитать настройки (вызывает попап после сохранения). */
  async function reloadSettings() {
    await loadState();
    restartTimer();
    render();
  }

  /** Команды попапа. Отвечаем даже когда инициализация не удалась (boot.ok === false). */
  async function handleMessage(msg) {
    if (!msg || !msg.type) return { ok: false, boot };
    if (msg.type === 'pk:ping') return { ok: boot.ok, boot, state: safeState() };
    if (!boot.ok || !core) {
      return { ok: false, boot, error: boot.error || 'контент-скрипт не инициализирован' };
    }
    if (msg.type === 'pk:reload') { await reloadSettings(); return { ok: true, boot, state: publicState() }; }
    if (msg.type === 'pk:state') return { ok: true, boot, state: publicState() };
    if (msg.type === 'pk:diagnostic') {
      await tick();
      return { ok: true, boot, diagnostic: core.diagnostic(state.lastDiagnostic), raw: state.lastDiagnostic, state: publicState() };
    }
    if (msg.type === 'pk:pause') {
      state.settings.paused = !state.settings.paused;
      await persist(); render(); await postHeartbeat();
      return { ok: true, boot, state: publicState() };
    }
    if (msg.type === 'pk:send') { await sendPending(); await postHeartbeat(); return { ok: true, boot, state: publicState() }; }
    if (msg.type === 'pk:sync') { const cfg = await syncConfig(); return { ok: true, boot, config: cfg, state: publicState() }; }
    if (msg.type === 'pk:reset') {
      state.counters = {}; state.sentKeys = []; state.pending = []; state.error = null;
      await persist(); render();
      return { ok: true, boot, state: publicState() };
    }
    return { ok: false, boot, error: 'неизвестная команда: ' + msg.type };
  }

  function publicState() {
    return {
      settings: Object.assign({}, state.settings, { token: state.settings.token ? '***' : '' }),
      counters: state.counters,
      pending: state.pending.length,
      status: state.status,
      error: state.error,
      diagnostic: state.lastDiagnostic,
      clientId: state.clientId,
      chat: state.lastChat,
      configFromServer: state.configFromServer,
      configError: state.configError,
      unreadable: state.unreadable,
      version: boot.version,
    };
  }

  (async function init() {
    if (!core || !dom) { boot.ok = false; try { render(); } catch { /* панель не важна */ } return; }
    boot.ok = true;
    await loadState();
    render();
    restartTimer();
    await persist();          // отметка «расширение живо в этой вкладке»
    await syncConfig();
    await postHeartbeat();
    // первый проход — не сразу: даём клиенту дорисовать список сообщений
    setTimeout(() => { tick().catch(() => undefined); }, 4000);
    console.info('[попутка.] сборщик запущен: интервал', state.settings.intervalSec + 'с',
      parser ? '(детект на правилах parser.ts)' : '(детект по ключевым словам — бандл парсера не подключён)');
  })();
})();
