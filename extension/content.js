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
    version: '1.0.4',
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
    recent: [],           // журнал разбора: КАЖДОЕ просмотренное сообщение и вердикт
    ui: { showRecent: true, showWalk: true },
    // автообход: расширение само открывает чаты и румы из белого списка
    walk: {
      index: 0,             // какую цель плана читаем сейчас
      reads: 0,             // сколько проходов прочитали в этом чате
      nextAt: 0,            // когда переходить дальше (мс)
      switching: null,      // цель, которую сейчас открываем
      triedClick: false,    // адрес не сработал — пробовали ли клик по списку чатов
      beforeFp: '',         // отпечаток чата ДО перехода: чтобы понять, что он правда сменился
      switches: [],         // отметки переходов (лимит в час)
      failed: [],           // цели, которые в этом круге не открылись
      prevHash: '',         // адрес вкладки ДО перехода: возвращаемся, если не вышло
      lastUserActivity: 0,  // пользователь печатает/кликает — чат не вырываем
      ourAction: false,     // это наш клик, а не пользовательский
      log: [],              // последние переходы
      note: '',
    },
    error: null,
    status: 'инициализация…',
    attempt: 0,
    backoffUntil: 0,
    timer: null,
    lastDiagnostic: null,
    unreadable: false,
    clientId: null,       // метка этого браузера для панели (heartbeat)
    lastChat: null,       // какой чат/рум видели последним
    topicNote: null,      // если id рума пришлось взять из белого списка
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
    state.recent = Array.isArray(saved.recent) ? saved.recent : [];
    const w = saved.walk && typeof saved.walk === 'object' ? saved.walk : {};
    state.walk.index = Number(w.index) || 0;
    state.walk.reads = Number(w.reads) || 0;
    state.walk.nextAt = Number(w.nextAt) || 0;
    state.walk.switches = Array.isArray(w.switches) ? w.switches.map(Number).filter(Boolean) : [];
    state.walk.log = Array.isArray(w.log) ? w.log : [];
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
      // журнал разбора храним урезанным: он для наглядности, а не для истории
      recent: state.recent.slice(0, 40),
      // обход: где мы в плане и какие переходы уже сделали (лимит в час и журнал
      // переживают перезагрузку вкладки — иначе обход начинался бы заново и бодро)
      walk: {
        index: state.walk.index,
        reads: state.walk.reads,
        nextAt: state.walk.nextAt,
        switches: core.walkSwitchesInHour(state.walk.switches, Date.now()),
        log: state.walk.log.slice(0, 12),
      },
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
        // batch передаём, чтобы повторная отправка была исключена даже тогда,
        // когда сервер не прислал разбора по сообщениям (results)
        const sum = core.summarizeResponse(body, batch);
        state.counters = core.mergeCounters(state.counters, {
          sent: batch.length, received: sum.received, created: sum.created,
          duplicate: sum.duplicate, skipped: sum.skipped, invalid: sum.invalid,
          listings: sum.listings, runs: 1, lastRunAt: new Date().toISOString(),
        });
        for (const key of sum.sentKeys) if (!state.sentKeys.includes(key)) state.sentKeys.push(key);
        markSent(batch);
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
  /* Журнал разбора: видно каждое сообщение, которое посмотрело расширение
  /* ---------------------------------------------------------------- */

  /** Сколько записей журнала держать (новые вытесняют старые). */
  const RECENT_MAX = 60;

  /**
   * Записать вердикт по одному сообщению. Пользователь должен видеть не только
   * «найдено N», но и КАЖДОЕ сообщение, которое расширение прочитало и отвергло,
   * с причиной и ссылкой на первоисточник (чтобы открыть и переслать вручную).
   */
  function rememberExamined(m, verdict, reason) {
    const rec = {
      at: new Date().toISOString(),
      chatId: m.chatId,
      messageId: m.messageId,
      // чат и рум пишем в каждую запись: журнал переживает смену чата, и должно быть
      // видно, откуда сообщение (пользователь открывает чаты руками)
      chat: m.chatTitle || m.chatId || '',
      topicId: m.topicId || null,
      // юзернейм из DOM уже приходит с «@» — второй не добавляем
      author: m.authorName ||
        (m.authorUsername ? '@' + String(m.authorUsername).replace(/^@+/, '') : ''),
      text: String(m.text || '').replace(/\s+/g, ' ').slice(0, 140),
      verdict,
      reason: reason || null,
      // ссылка t.me/<чат>[/<рум>]/<сообщение>; null, если id сообщения синтетический
      link: m.link || null,
      sent: false,
    };
    const same = (r) => r.chatId === rec.chatId && r.messageId === rec.messageId;
    state.recent = [rec].concat(state.recent.filter((r) => !same(r)));
    if (state.recent.length > RECENT_MAX) state.recent = state.recent.slice(0, RECENT_MAX);
    return rec;
  }

  /** Состояние обхода наружу (попап и панель сервера): без внутренних таймеров. */
  function walkPublic() {
    const plan = state.walk.plan || core.walkTargets(state.settings.whitelist);
    const target = plan[state.walk.index] || null;
    const next = plan.length ? plan[(state.walk.index + 1) % plan.length] : null;
    return {
      on: state.settings.autoWalk === true,
      plan: plan.length,
      current: target ? target.label : null,
      next: next ? next.label : null,
      reads: state.walk.reads,
      readsPerChat: state.settings.walkReadsPerChat,
      nextInSec: state.walk.nextAt ? Math.max(0, Math.ceil((state.walk.nextAt - Date.now()) / 1000)) : 0,
      switchesHour: core.walkSwitchesInHour(state.walk.switches, Date.now()).length,
      switchesLimit: state.settings.walkMaxPerHour,
      switching: state.walk.switching ? state.walk.switching.label : null,
      note: state.walk.note || '',
      log: state.walk.log.slice(0, 12),
    };
  }

  /** Отметить в журнале, какие сообщения ушли на сервер. */
  function markSent(batch) {
    const keys = new Set((batch || []).map((m) => core.sentKey(m.chatId, m.messageId)));
    for (const rec of state.recent) {
      if (keys.has(core.sentKey(rec.chatId, rec.messageId))) rec.sent = true;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Автообход чатов и румов                                           */
  /*                                                                    */
  /* Расширение открывает чаты из белого списка само: адресом вкладки     */
  /* (как если бы пользователь вставил ссылку) или кликом по строке в     */
  /* списке чатов. Ничего не отправляет, не публикует и не печатает —     */
  /* только читает. Темп человеческий: случайная пауза перед каждым       */
  /* переходом, несколько проходов на чат, предел переходов в час и       */
  /* запрет переключать чат, пока пользователь сам работает во вкладке.   */
  /* ---------------------------------------------------------------- */

  /** Сколько записей журнала обхода держать. */
  const WALK_LOG_MAX = 25;
  /** Сколько ждём, пока клиент дорисует чат после перехода. */
  const WALK_LOAD_TIMEOUT_MS = 15000;
  /**
   * И сколько раз при этом опрашиваем вкладку. Ограничение по числу опросов
   * страхует от вечного ожидания, если часы вкладки стоят (фон, заморозка
   * вкладки, отладка) — обход обязан когда-нибудь пойти дальше.
   */
  const WALK_LOAD_POLLS = 30;

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /** Пользователь что-то делает во вкладке — обход подождёт и не вырвет чат. */
  function markUserActivity() {
    if (state.walk.ourAction) return;   // это наш собственный клик по списку чатов
    state.walk.lastUserActivity = Date.now();
  }

  function watchUserActivity() {
    if (typeof document.addEventListener !== 'function') return;
    for (const type of ['keydown', 'mousedown', 'wheel', 'touchstart']) {
      try { document.addEventListener(type, markUserActivity, { passive: true, capture: true }); } catch { /* не важно */ }
    }
  }

  function clickRow(node) {
    if (!node) return false;
    if (typeof node.click === 'function') { node.click(); return true; }
    if (typeof node.dispatch === 'function') { node.dispatch('click'); return true; }
    return false;
  }

  function walkLog(target, ok, note) {
    const rec = {
      at: new Date().toISOString(),
      label: target ? target.label : '—',
      ok: ok === true ? true : (ok === false ? false : null),
      note: note || '',
    };
    state.walk.log = [rec].concat(state.walk.log).slice(0, WALK_LOG_MAX);
    return rec;
  }

  /**
   * Открыть цель: сначала адресом (не трогает разметку и работает в Web K/A/Z),
   * клик по списку чатов — запасной путь (цель задана названием, либо клиент не
   * понимает рум в адресе).
   */
  function walkNavigate(target) {
    if (!target) return { ok: false, how: null, error: 'нет цели' };
    state.walk.prevHash = String((typeof location !== 'undefined' && location.hash) || '');
    const hash = core.walkHashFor(target, typeof location !== 'undefined' ? location : null);
    state.walk.beforeFp = chatFingerprint();
    state.walk.ourAction = true;
    // снимаем флаг не сразу: клиент дорисовывает чат асинхронно, и его внутренние
    // клики/скроллы не должны считаться «пользователь работает»
    setTimeout(() => { state.walk.ourAction = false; }, 1500);

    if (hash) {
      if (String((typeof location !== 'undefined' && location.hash) || '') === hash) {
        return { ok: true, how: 'already' };
      }
      location.hash = hash;
      return { ok: true, how: 'address', hash };
    }
    const row = dom.findChatRow(document, [target.topic, target.value, target.label]);
    if (!row) return { ok: false, how: null, error: 'нет ни адреса, ни строки «' + target.label + '» в списке чатов' };
    if (!clickRow(row.node)) return { ok: false, how: null, error: 'строка «' + row.title + '» не кликабельна' };
    return { ok: true, how: 'click', title: row.title };
  }

  /**
   * Отпечаток открытого чата. Нужен, чтобы отличить «клиент правда открыл другой
   * чат» от «мы подставили адрес, а разметка осталась прежней» (нет доступа к
   * чату, клиент не понял рум, страница зависла) — иначе обход молча перечитывал
   * бы один и тот же чат, думая, что идёт по плану.
   */
  function chatFingerprint() {
    return typeof dom.contentFingerprint === 'function' ? dom.contentFingerprint(document) : '';
  }

  /** Дождаться, пока клиент дорисует чат после перехода. */
  async function walkWaitLoaded(target) {
    const startedAt = Date.now();
    let last = null;
    let polls = 0;
    while (Date.now() - startedAt < WALK_LOAD_TIMEOUT_MS && polls < WALK_LOAD_POLLS) {
      polls++;
      const chat = dom.readChatInfo(document, typeof window !== 'undefined' ? window.location : location);
      last = chat;
      if (core.walkTargetMatches(target, chat)
        && (!state.walk.beforeFp || chatFingerprint() !== state.walk.beforeFp)) {
        state.walk.beforeFp = '';
        const topicId = chat.topicId != null && chat.topicId !== '' ? Number(chat.topicId) : null;
        return { ok: true, chat, topicUnknown: target.topicId != null && topicId !== target.topicId };
      }
      await sleep(500);
    }
    return { ok: false, chat: last };
  }

  /**
   * Один такт обхода: 'read' — читать текущий чат, 'skip' — сейчас не читаем
   * (пауза, переход, ждём загрузки, лимит или пользователь работает).
   */
  async function walkStep() {
    const plan = core.walkTargets(state.settings.whitelist);
    state.walk.plan = plan;
    if (!plan.length) {
      state.walk.note = 'Белый список пуст — обходить нечего.';
      return 'skip';
    }

    // переход сделан — ждём, пока чат дорисуется
    if (state.walk.switching) {
      const target = state.walk.switching;
      const res = await walkWaitLoaded(target);
      state.walk.switching = null;
      state.walk.reads = 0;

      if (res.ok) {
        const i = core.walkIndexForChat(plan, res.chat);
        if (i >= 0) state.walk.index = i;
        state.walk.triedClick = false;
        state.walk.failed = [];   // цель открылась — провалы этого круга забыты
        walkLog(target, true, res.topicUnknown ? 'открыт (id рума клиент не отдал — беру из белого списка)' : 'открыт');
        state.walk.note = 'Читаю «' + target.label + '».';
        return 'read';
      }
      // адресом не вышло — один раз пробуем кликом по строке в списке чатов
      if (!state.walk.triedClick) {
        const row = dom.findChatRow(document, [target.topic, target.value, target.label]);
        if (row) {
          state.walk.triedClick = true;
          state.walk.ourAction = true;
          setTimeout(() => { state.walk.ourAction = false; }, 1500);
          clickRow(row.node);
          state.walk.switching = target;
          walkLog(target, null, 'адрес не сработал — пробую кликом по «' + row.title + '»');
          state.walk.note = 'Открываю «' + target.label + '» кликом по списку чатов…';
          return 'skip';
        }
      }
      state.walk.triedClick = false;
      state.walk.beforeFp = '';
      walkLog(target, false, 'не открылся за ' + Math.round(WALK_LOAD_TIMEOUT_MS / 1000) + ' с — пропускаю');
      /*
       * Клиент не переключился, а адрес вкладки мы уже поменяли: дальше читать
       * нельзя — сообщения прежнего чата ушли бы на сервер под именем цели,
       * которую мы не открыли (неверный chatId и неверные ссылки). Возвращаем
       * прежний адрес и исключаем цель до конца круга.
       */
      const back = state.walk.prevHash;
      if (back && String(location.hash || '') !== back) location.hash = back;
      state.walk.failed = state.walk.failed.concat([target.label]);
      if (state.walk.failed.length >= plan.length) state.walk.failed = [];
      state.walk.index = core.walkNextIndex(plan, state.walk.index, state.walk.failed);
      state.walk.reads = 0;
      state.walk.nextAt = Date.now() + core.walkPauseMs(state.settings.walkMinSec, state.settings.walkMaxSec);
      state.walk.note = '«' + target.label + '» не открылся — пропускаю, дальше по плану.';
      return 'skip';
    }

    // пользователь сам открыл чат из плана — продолжаем обход с него, а не «с начала»
    const chatNow = dom.readChatInfo(document, typeof window !== 'undefined' ? window.location : location);
    const idxNow = core.walkIndexForChat(plan, chatNow);
    if (idxNow >= 0 && idxNow !== state.walk.index) {
      // пользователь сам открыл чат из плана — читаем его сразу, остаток паузы
      // от предыдущего чата ждать не нужно
      state.walk.index = idxNow;
      state.walk.reads = 0;
      state.walk.nextAt = 0;
      state.walk.note = 'Вы открыли «' + plan[idxNow].label + '» — продолжаю обход с него.';
    }

    const decision = core.walkDecision({
      plan,
      index: state.walk.index,
      reads: state.walk.reads,
      nextAt: state.walk.nextAt,
      switching: false,
      switches: state.walk.switches,
      lastUserActivity: state.walk.lastUserActivity,
      now: Date.now(),
    }, state.settings);
    state.walk.note = decision.note || '';

    if (decision.action === 'wait') {
      // лимит переходов в час: откладываем на минуту и проверяем снова
      if (decision.reason === 'limit') state.walk.nextAt = Date.now() + 60000;
      return 'skip';
    }
    if (decision.action === 'navigate') {
      const index = core.walkNextIndex(plan, state.walk.index, state.walk.failed);
      const target = plan[index];
      state.walk.triedClick = false;
      const nav = walkNavigate(target);
      state.walk.switches = core.walkSwitchesInHour(state.walk.switches, Date.now()).concat([Date.now()]);
      state.walk.index = index;
      state.walk.reads = 0;
      state.walk.nextAt = 0;
      if (nav.ok) {
        state.walk.switching = target;
        walkLog(target, null, 'перехожу (' + (nav.how === 'address' ? 'по адресу' : nav.how === 'click' ? 'клик по списку' : 'уже открыт') + ')');
        state.walk.note = 'Открываю «' + target.label + '»…';
      } else {
        walkLog(target, false, nav.error);
        state.walk.nextAt = Date.now() + core.walkPauseMs(state.settings.walkMinSec, state.settings.walkMaxSec);
        state.walk.note = 'Не смог открыть «' + target.label + '»: ' + nav.error;
      }
      return 'skip';
    }
    return 'read';
  }

  /** Проход прочитан — считаем его и планируем паузу перед следующим переходом. */
  function walkCountRead() {
    if (!state.settings.autoWalk) return;
    state.walk.reads++;
    if (state.walk.reads >= state.settings.walkReadsPerChat) {
      state.walk.nextAt = Date.now() + core.walkPauseMs(state.settings.walkMinSec, state.settings.walkMaxSec);
    }
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

    // автообход: сам открывает следующий чат/рум из белого списка
    if (state.settings.autoWalk) {
      const step = await walkStep();
      if (step !== 'read') {
        state.status = state.walk.note || 'обход';
        state.unreadable = false;
        await persist();
        render();
        await postHeartbeat();
        return;
      }
    }

    const chat = dom.readChatInfo(document, window.location);
    // форум-чат: если клиент не отдал id рума в адресе, а белый список закрепляет
    // за этим чатом ровно один рум — берём его и честно пишем об этом в статусе
    const adoptedTopic = core.adoptTopicFromWhitelist(chat, state.settings.whitelist);
    if (adoptedTopic) {
      chat.topicId = adoptedTopic.topicId;
      chat.topicIdSource = 'whitelist';
    }
    state.topicNote = adoptedTopic ? adoptedTopic.note : null;
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
      if (!verdict.send) {
        reasons[verdict.reason] = (reasons[verdict.reason] || 0) + 1;
        rememberExamined(m, 'rejected', verdict.reason);
        continue;
      }
      if (!core.withinAge(m.dateMs, state.settings.maxAgeHours, Date.now())) {
        reasons.old = (reasons.old || 0) + 1;
        rememberExamined(m, 'old', 'old');
        continue;
      }
      if (state.sentKeys.includes(core.sentKey(m.chatId, m.messageId))) {
        alreadySent++;
        rememberExamined(m, 'duplicate', 'duplicate');
        continue;
      }
      if (state.pending.some((p) => p.chatId === m.chatId && p.messageId === m.messageId)) {
        alreadySent++;
        rememberExamined(m, 'duplicate', 'duplicate');
        continue;
      }
      candidates.push(m);
      rememberExamined(m, 'listing', verdict.reason);
    }

    const fresh = core.filterUnsent(candidates, state.sentKeys);
    state.counters = core.mergeCounters(state.counters, { found: harvested.messages.length });
    state.lastDiagnostic = {
      url: location.href, chat, chatKey, whitelisted: true,
      topicNote: state.topicNote,
      total: harvested.messages.length, strategy: harvested.strategy,
      toSend: fresh.length, alreadySent, filtered: harvested.messages.length - fresh.length - alreadySent,
      reasons, counts: harvested.counts,
      // последние разобранные сообщения с вердиктами и ссылками (для диагностики и панели)
      recent: state.recent.slice(0, 12),
    };

    walkCountRead();

    if (!fresh.length) {
      state.status = `чат «${chat.title}»${chat.topicId != null ? ', рум ' + chat.topicId : ''}: ` +
        `прочитано ${harvested.messages.length}, нового нет`;
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
    // автообход: панель может включить/выключить и задать темп переходов
    if (typeof cfg.autoWalk === 'boolean') state.settings.autoWalk = cfg.autoWalk;
    const walkLimits = {
      walkReadsPerChat: [1, 20], walkMinSec: [10, 3600], walkMaxSec: [10, 7200],
      walkMaxPerHour: [1, 600], walkIdleGuardSec: [0, 1800],
    };
    for (const key in walkLimits) {
      if (cfg[key] == null) continue;
      const range = walkLimits[key];
      state.settings[key] = core.clamp(Math.round(Number(cfg[key]) || range[0]), range[0], range[1]);
    }
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
          // автообход: где сейчас, куда дальше, сколько переходов в час
          walk: walkPublic(),
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
    '.pk-sec{display:flex;justify-content:space-between;gap:8px;margin-top:10px;cursor:pointer;color:#475569;font-weight:600}',
    '.pk-rec{border-top:1px solid #f1f5f9;padding:5px 0}',
    '.pk-rec-top{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}',
    '.pk-badge{font-size:11px;padding:1px 6px;border-radius:999px;border:1px solid #e2e8f0;color:#475569;background:#f8fafc;white-space:nowrap}',
    '.pk-badge.ok{background:#f0fdf4;border-color:#bbf7d0;color:#166534}',
    '.pk-badge.sent{background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8}',
    '.pk-rec-text{color:#0f172a}',
    '.pk-rec-meta{color:#94a3b8;font-size:11px}',
    '.pk-rec a{color:#2563eb;text-decoration:none;font-size:11px}',
    '.pk-rec a:hover{text-decoration:underline}',
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
      state.topicNote ? el('div', { class: 'pk-warn', text: state.topicNote }) : null,
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
              m.link ? el('a', { href: m.link, target: '_blank', rel: 'noreferrer', style: 'color:#2563eb;font-size:11px', text: m.link.replace(/^https:\/\//, '') }) : null,
            ]),
          ]),
        ]));
      }
    }

    // Автообход: где сейчас, куда дальше, сколько переходов и чем они кончились
    const walk = walkPublic();
    if (walk.on || walk.log.length) {
      body.append(el('div', {
        class: 'pk-sec',
        onclick: () => { state.ui.showWalk = !state.ui.showWalk; render(); },
      }, [
        el('span', { text: 'Обход чатов: ' + (walk.on ? 'включён' : 'выключен') }),
        el('span', { class: 'pk-muted', text: state.ui.showWalk ? 'скрыть' : 'показать' }),
      ]));
      if (state.ui.showWalk) {
        if (walk.on) {
          body.append(el('div', { class: 'pk-row' }, [
            el('span', { class: 'pk-muted', text: 'сейчас' }),
            el('span', { text: walk.switching ? 'открываю ' + walk.switching : (walk.current || '—') }),
          ]));
          body.append(el('div', { class: 'pk-row' }, [
            el('span', { class: 'pk-muted', text: 'дальше' }), el('span', { text: walk.next || '—' }),
          ]));
          body.append(el('div', { class: 'pk-row' }, [
            el('span', { class: 'pk-muted', text: 'переход через' }),
            el('span', { text: walk.nextInSec ? walk.nextInSec + ' с' : 'как дочитаю чат' }),
          ]));
          body.append(el('div', { class: 'pk-row' }, [
            el('span', { class: 'pk-muted', text: 'переходов за час' }),
            el('span', { text: walk.switchesHour + ' из ' + walk.switchesLimit }),
          ]));
        }
        if (walk.note) body.append(el('div', { class: 'pk-muted', style: 'padding:2px 0', text: walk.note }));
        for (const rec of walk.log.slice(0, 8)) {
          const cls = rec.ok === false ? 'pk-badge' : (rec.ok ? 'pk-badge ok' : 'pk-badge sent');
          const label = rec.ok === false ? '✖ не открылся' : (rec.ok ? '✔ открыт' : '→ переход');
          body.append(el('div', { class: 'pk-rec' }, [
            el('div', { class: 'pk-rec-top' }, [
              el('span', { class: cls, text: label }),
              el('span', { class: 'pk-rec-text', text: rec.label }),
            ]),
            rec.note ? el('div', { class: 'pk-rec-meta', text: rec.note }) : null,
          ]));
        }
        if (!walk.log.length) {
          body.append(el('div', { class: 'pk-muted', style: 'padding:4px 0', text: 'Переходов ещё не было.' }));
        }
      }
    }

    // Журнал разбора: видно каждое сообщение, которое расширение прочитало,
    // вердикт, причину и ссылку на первоисточник (чтобы открыть и переслать).
    body.append(el('div', {
      class: 'pk-sec',
      onclick: () => { state.ui.showRecent = !state.ui.showRecent; render(); },
    }, [
      el('span', { text: 'Что нашлось (' + state.recent.length + ')' }),
      el('span', { class: 'pk-muted', text: state.ui.showRecent ? 'скрыть' : 'показать' }),
    ]));
    if (state.ui.showRecent) {
      if (!state.recent.length) {
        body.append(el('div', { class: 'pk-muted', style: 'padding:4px 0', text: 'Пока ни одного сообщения не разобрали. Откройте чат из белого списка и дождитесь прохода.' }));
      }
      for (const rec of state.recent.slice(0, 12)) {
        const badgeClass = rec.verdict === 'listing' ? (rec.sent ? 'pk-badge sent' : 'pk-badge ok') : 'pk-badge';
        body.append(el('div', { class: 'pk-rec' }, [
          el('div', { class: 'pk-rec-top' }, [
            el('span', { class: badgeClass, text: core.VERDICT_LABELS[rec.verdict] || rec.verdict }),
            el('span', { class: 'pk-rec-meta', text: rec.sent ? 'отправлено на сервер' : (rec.reason ? core.explainReason(rec.reason) : '') }),
          ]),
          el('div', {
            class: 'pk-rec-meta',
            text: (rec.chat || rec.chatId || '') + (rec.topicId ? ' · рум ' + rec.topicId : ''),
          }),
          el('div', { class: 'pk-rec-text', text: (rec.author ? rec.author + ': ' : '') + rec.text }),
          rec.link
            ? el('a', { href: rec.link, target: '_blank', rel: 'noreferrer', text: rec.link.replace(/^https:\/\//, '') })
            : el('div', { class: 'pk-rec-meta', text: 'ссылки нет: id сообщения не прочитался в разметке' }),
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
      el('button', {
        class: 'pk-btn',
        text: state.settings.autoWalk ? 'Обход: выключить' : 'Обход: включить',
        title: 'Расширение само открывает чаты и румы из белого списка со случайными паузами',
        onclick: async () => {
          state.settings.autoWalk = !state.settings.autoWalk;
          if (state.settings.autoWalk) {
            // стартуем с того чата, который открыт сейчас (если он в плане)
            const plan = core.walkTargets(state.settings.whitelist);
            const here = core.walkIndexForChat(plan, dom.readChatInfo(document, window.location));
            state.walk.index = here >= 0 ? here : 0;
            state.walk.reads = 0;
            state.walk.nextAt = 0;
          }
          state.status = state.settings.autoWalk ? 'обход включён' : 'обход выключен';
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
      recent: state.recent.slice(0, 40),
      walk: walkPublic(),
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
    watchUserActivity();
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
