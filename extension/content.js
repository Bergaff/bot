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

  const core = (typeof PoputkaCore !== 'undefined') ? PoputkaCore : require('./core.cjs');
  const dom = (typeof PoputkaDom !== 'undefined') ? PoputkaDom : require('./dom.cjs');
  const parser = (typeof PoputkaParser !== 'undefined') ? PoputkaParser : null;

  const NS = 'poputchka';
  const store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
    ? core.chromeStore(NS)
    : core.localStore(NS);

  const state = {
    settings: core.withDefaults({}),
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
  };

  /* ---------------------------------------------------------------- */
  /* Хранилище                                                         */
  /* ---------------------------------------------------------------- */

  async function loadState() {
    const saved = await store.read();
    state.settings = core.withDefaults(saved.settings);
    state.counters = saved.counters || {};
    state.sentKeys = Array.isArray(saved.sentKeys) ? saved.sentKeys : [];
  }

  async function persist() {
    await store.write({
      settings: state.settings,
      counters: state.counters,
      sentKeys: core.pruneSentLog(state.sentKeys),
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
    if (state.settings.paused) { state.status = 'пауза'; render(); return; }
    if (Date.now() < state.backoffUntil) {
      state.status = 'ждем: ' + (state.backoffUntil === Infinity ? 'остановлено' : Math.ceil((state.backoffUntil - Date.now()) / 1000) + ' с');
      render();
      return;
    }

    const chat = dom.readChatInfo(document, window.location);
    const chatKey = core.chatKeyOf(chat);
    const whitelisted = core.matchesWhitelist(chat, state.settings.whitelist);

    if (!chatKey || !whitelisted) {
      // всё, что не в белом списке, игнорируется ПОЛНОСТЬЮ — сообщения не читаем
      state.unreadable = false;
      state.status = chat.title
        ? `чат «${chat.title}» не в белом списке — пропускаем`
        : 'чат не определён (откройте диалог)';
      state.lastDiagnostic = { url: location.href, chat, chatKey, whitelisted, total: 0, toSend: 0 };
      render();
      return;
    }

    const harvested = dom.harvest(document, { limit: state.settings.maxPerChat, now: Date.now() });
    if (harvested.unreadable || harvested.messages.length === 0) {
      state.unreadable = true;
      state.error = 'Не могу прочитать сообщения: Telegram Web изменил разметку или чат пуст. ' +
        'Сбор paused, пока не починим селекторы (см. extension/dom.cjs).';
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
      return;
    }

    if (state.settings.confirmMode) {
      // режим «спрашивать подтверждение» (по умолчанию включён)
      state.pending = state.pending.concat(fresh);
      state.status = `найдено ${fresh.length} — подтвердите отправку`;
      await persist();
      render();
      return;
    }

    state.status = `найдено ${fresh.length} — отправляю`;
    render();
    await sendPending({ messages: fresh });
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

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      (async () => {
        if (!msg || !msg.type) return sendResponse({ ok: false });
        if (msg.type === 'pk:reload') { await reloadSettings(); return sendResponse({ ok: true, state: publicState() }); }
        if (msg.type === 'pk:state') return sendResponse({ ok: true, state: publicState() });
        if (msg.type === 'pk:diagnostic') { await tick(); return sendResponse({ ok: true, diagnostic: core.diagnostic(state.lastDiagnostic), raw: state.lastDiagnostic }); }
        if (msg.type === 'pk:pause') { state.settings.paused = !state.settings.paused; await persist(); render(); return sendResponse({ ok: true, state: publicState() }); }
        if (msg.type === 'pk:send') { await sendPending(); return sendResponse({ ok: true, state: publicState() }); }
        if (msg.type === 'pk:reset') {
          state.counters = {}; state.sentKeys = []; state.pending = []; state.error = null;
          await persist(); render(); return sendResponse({ ok: true, state: publicState() });
        }
        return sendResponse({ ok: false });
      })();
      return true; // ответ асинхронный
    });
  }

  function publicState() {
    return {
      settings: Object.assign({}, state.settings, { token: state.settings.token ? '***' : '' }),
      counters: state.counters,
      pending: state.pending.length,
      status: state.status,
      error: state.error,
      diagnostic: state.lastDiagnostic,
    };
  }

  (async function init() {
    await loadState();
    render();
    restartTimer();
    // первый проход — не сразу: даём клиенту дорисовать список сообщений
    setTimeout(() => { tick().catch(() => undefined); }, 4000);
    console.info('[попутка.] сборщик запущен: интервал', state.settings.intervalSec + 'с',
      parser ? '(детект на правилах parser.ts)' : '(детект по ключевым словам — бандл парсера не подключён)');
  })();
})();
