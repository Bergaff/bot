/**
 * Попап настроек и счётчиков. Хранит всё в chrome.storage.local:
 * токен и настройки в репозиторий не попадают (ТЗ п. 4.5).
 */
(function () {
  'use strict';

  const core = PoputkaCore;
  const NS = 'poputchka';
  const $ = (id) => document.getElementById(id);

  const FIELDS = ['serverUrl', 'token', 'intervalSec', 'batchSize', 'maxPerChat', 'maxAgeHours'];
  const CHECKS = ['confirmMode', 'requireContact', 'paused'];

  function show(kind, text) {
    const box = $('msg');
    box.className = 'msg ' + kind;
    box.textContent = text;
  }

  function clearMsg() { $('msg').className = ''; $('msg').textContent = ''; }

  async function load() {
    const saved = await chrome.storage.local.get(NS);
    const s = core.withDefaults((saved[NS] || {}).settings);
    $('serverUrl').value = s.serverUrl;
    $('token').value = s.token;
    $('whitelist').value = (s.whitelist || []).join('\n');
    $('intervalSec').value = s.intervalSec;
    $('batchSize').value = s.batchSize;
    $('maxPerChat').value = s.maxPerChat;
    $('maxAgeHours').value = s.maxAgeHours;
    for (const c of CHECKS) $(c).checked = Boolean(s[c]);
    renderStats((saved[NS] || {}).counters || {});
  }

  function renderStats(c) {
    const rows = [
      ['найдено', c.found], ['отправлено', c.sent], ['заявок создано', c.created],
      ['дублей', c.duplicate], ['отсеяно сервером', c.skipped], ['битых', c.invalid],
      ['прогонов', c.runs], ['ошибок разметки', c.errors],
    ];
    $('stats').replaceChildren(...rows.map(([k, v]) => {
      const row = document.createElement('div');
      row.append(document.createElement('span'));
      row.firstChild.textContent = k;
      const val = document.createElement('span');
      val.textContent = String(v || 0);
      row.append(val);
      return row;
    }));
    if (c.lastRunAt) {
      const p = document.createElement('div');
      p.append(document.createElement('span'), document.createElement('span'));
      p.firstChild.textContent = 'последний прогон';
      p.lastChild.textContent = new Date(c.lastRunAt).toLocaleString('ru-RU', { hour12: false });
      $('stats').append(p);
    }
  }

  function readForm() {
    const settings = {
      whitelist: $('whitelist').value.split('\n').map((x) => x.trim()).filter(Boolean),
    };
    for (const f of FIELDS) settings[f] = $(f).value;
    for (const c of CHECKS) settings[c] = $(c).checked;
    return core.withDefaults(settings);
  }

  async function saveSettings() {
    const settings = readForm();
    const urlProblem = core.serverUrlProblem(settings.serverUrl);
    if (urlProblem) { show('err', urlProblem); return; }
    if (!settings.token) { show('warn', 'Токен пустой: сервер ответит 401, сбор не пойдёт.'); }
    if (settings.whitelist.length === 0) { show('warn', 'Белый список пуст — сообщения не будут читаться вовсе.'); }

    const saved = await chrome.storage.local.get(NS);
    await chrome.storage.local.set({
      [NS]: Object.assign({}, saved[NS] || {}, { settings }),
    });
    await notifyTab({ type: 'pk:reload' });
    if (!settings.token || settings.whitelist.length === 0) return;
    show('ok', 'Сохранено. Вкладка перечитала настройки.');
  }

  /** Последняя отметка контент-скрипта («я жив в этой вкладке») из storage. */
  async function readAlive() {
    try {
      const saved = await chrome.storage.local.get(NS);
      return (saved[NS] || {}).alive || null;
    } catch (e) {
      return null;
    }
  }

  /** Файлы контент-скрипта — те же и в том же порядке, что в manifest.json. */
  const CONTENT_FILES = ['vendor/parser.js', 'core.cjs', 'dom.cjs', 'content.js'];

  /** Активная вкладка Telegram Web: { tab } или { error }. */
  async function telegramTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return { error: 'Не нашёл активную вкладку.' };
    if (!/^https:\/\/web\.telegram\.org\//.test(tab.url || '')) {
      return { error: 'Активная вкладка — не Telegram Web (' + (tab.url || 'пусто') +
        '). Откройте web.telegram.org, войдите в аккаунт и зайдите в чат.' };
    }
    return { tab };
  }

  /** Спросить контент-скрипт; попытки нужны, потому что после внедрения он поднимается не мгновенно. */
  async function pingTab(tabId, attempts) {
    const n = attempts || 1;
    let last = null;
    for (let i = 0; i < n; i++) {
      try {
        const res = await chrome.tabs.sendMessage(tabId, { type: 'pk:ping' });
        if (res && res.boot) return res;
        last = res || { error: 'пустой ответ вкладки' };
      } catch (e) {
        last = { error: core.explainTabError(e && e.message ? e.message : e, await readAlive()) };
      }
      if (i < n - 1) await new Promise((r) => setTimeout(r, 250));
    }
    return last;
  }

  /** Спросить content script в активной вкладке Telegram Web. */
  async function notifyTab(message) {
    const found = await telegramTab();
    if (found.error) return { error: found.error };
    try {
      const res = await chrome.tabs.sendMessage(found.tab.id, message);
      if (res && res.ok === false && res.error) return { error: res.error, res };
      return res;
    } catch (e) {
      return { error: core.explainTabError(e && e.message ? e.message : e, await readAlive()) };
    }
  }

  /**
   * Подключить контент-скрипт к уже открытой вкладке — БЕЗ перезагрузки.
   *
   * Chrome внедряет скрипт сам при загрузке страницы, но внедрения не будет, если
   * вкладка открыта раньше установки расширения, восстановлена из кэша, открыта в
   * другом профиле или расширению урезали доступ к сайту («При клике»). Просить F5
   * в этих случаях бесполезно, поэтому внедряем скрипт сами (chrome.scripting).
   */
  async function connectTab() {
    const found = await telegramTab();
    if (found.error) return { ok: false, error: found.error };
    const tab = found.tab;

    const first = await pingTab(tab.id, 1);
    if (first && first.boot) return { ok: true, ping: first, already: true };

    if (!chrome.scripting || !chrome.scripting.executeScript) {
      return {
        ok: false,
        error: 'Внедрить скрипт нечем: у расширения нет разрешения «scripting».',
        hint: 'Так бывает на старой копии папки. Обновите расширение: chrome://extensions → «попутка.» → «Обновить» (↻), ' +
          'потом нажмите «Подключить к вкладке» ещё раз.',
      };
    }

    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
    } catch (e) {
      const text = String((e && e.message) || e);
      return {
        ok: false,
        error: 'Браузер не дал внедрить скрипт: ' + text,
        hint: /permission|access|cannot be scripted|not allowed/i.test(text)
          ? 'Проверьте доступ к сайту: chrome://extensions → «попутка.» → «Доступ к сайту» → «На всех сайтах», ' +
            'и что расширение включено. Затем нажмите ещё раз.'
          : 'Закройте вкладку Telegram Web, откройте её заново и нажмите «Подключить к вкладке».',
      };
    }

    const second = await pingTab(tab.id, 4);
    if (second && second.boot) {
      return { ok: true, ping: second, injected: true };
    }
    return {
      ok: false,
      error: 'Скрипт внедрён, но не отвечает' + (second && second.error ? ': ' + second.error : ''),
      hint: 'Посмотрите ошибки расширения: chrome://extensions → «попутка.» → «Ошибки». ' +
        'Если там пусто — закройте вкладку и откройте её заново.',
    };
  }

  /** Кнопка «Подключить к вкладке»: внедрить скрипт и показать, что получилось. */
  async function connectNow() {
    show('warn', 'Подключаюсь к вкладке…');
    const res = await connectTab();
    if (res.ok) {
      const b = res.ping.boot || {};
      await load();
      show(b.ok ? 'ok' : 'err',
        (res.already ? 'Контент-скрипт уже работал' : 'Подключили к вкладке без перезагрузки') +
        ': версия ' + (b.version || '?') +
        (b.ok ? ', инициализирован' : ', но не инициализирован: ' + (b.error || 'неизвестная ошибка')) +
        '. Нажмите «Самопроверка», чтобы увидеть всю цепочку.');
      return;
    }
    show('err', res.error + (res.hint ? ' ' + res.hint : ''));
  }

  /**
   * Самопроверка: по шагам показывает, что работает, а что нет — без отправки данных.
   * Именно её стоит нажать, когда «вкладка не отвечает».
   */
  async function selfCheck() {
    const lines = [];
    const settings = readForm();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const alive = await readAlive();

    lines.push('1. Вкладка: ' + (tab && tab.url ? tab.url : 'не определена'));
    lines.push(tab && /^https:\/\/web\.telegram\.org\//.test(tab.url || '')
      ? '   ✓ это Telegram Web'
      : '   ✗ нужна вкладка https://web.telegram.org/… — остальные расширением не читаются');

    let ping = await notifyTab({ type: 'pk:ping' });
    let connectNote = null;
    if (!(ping && ping.boot)) {
      // не отвечаем «нажмите F5», а пробуем внедрить скрипт сами
      const conn = await connectTab();
      if (conn.ok) {
        ping = conn.ping;
        connectNote = conn.already ? null : 'внедрили сами, перезагрузка не понадобилась';
      } else {
        connectNote = conn.error + (conn.hint ? ' ' + conn.hint : '');
      }
    }

    if (ping && ping.boot) {
      lines.push('2. Контент-скрипт: ' +
        (ping.boot.ok ? '✓ загружен и инициализирован' : '✗ загружен, но не инициализирован') +
        (connectNote ? ' — ' + connectNote : ''));
      lines.push('   версия ' + (ping.boot.version || '?') + ', запущен ' +
        new Date(ping.boot.startedAt).toLocaleTimeString('ru-RU', { hour12: false }) +
        (ping.boot.reinjected ? ' (повторное внедрение вместо умершего экземпляра)' : ''));
      if (ping.boot.error) lines.push('   ошибка: ' + ping.boot.error);
    } else if (alive) {
      lines.push('2. Контент-скрипт: ✗ не отвечает, хотя отметка «жив» есть от ' +
        new Date(alive.at).toLocaleString('ru-RU', { hour12: false }));
      lines.push('   → ' + (connectNote || 'нажмите «Подключить к вкладке» или обновите её (F5)'));
    } else {
      lines.push('2. Контент-скрипт: ✗ не подключён к вкладке');
      lines.push('   → ' + (connectNote || 'нажмите «Подключить к вкладке»'));
    }

    const urlProblem = core.serverUrlProblem(settings.serverUrl);
    lines.push('3. Сервер: ' + (urlProblem ? '✗ ' + urlProblem : '✓ ' + settings.serverUrl));
    lines.push('4. Токен: ' + (settings.token ? '✓ задан (' + settings.token.length + ' зн.)' : '✗ пустой — сервер ответит 401'));
    lines.push('5. Белый список: ' + (settings.whitelist.length
      ? '✓ ' + settings.whitelist.length + ' записей: ' + settings.whitelist.join(', ')
      : '✗ пуст — сообщения не читаются вовсе'));
    lines.push('6. Пауза: ' + (settings.paused ? '⚠ включена — ничего не читается' : 'выключена'));

    if (!urlProblem) {
      try {
        const res = await fetch(settings.serverUrl + '/api/ingest/status', { cache: 'no-store' });
        const body = await res.json().catch(() => null);
        lines.push('7. Доступность сервера: ' + (res.ok
          ? '✓ отвечает; принято сегодня ' + ((body && body.today && body.today.messages) || 0) +
            ' сообщений, создано заявок ' + ((body && body.today && body.today.created) || 0)
          : '✗ HTTP ' + res.status + (res.status === 404 ? ' (роут /api/ingest/status не найден — на сервере старая версия)' : '')));
      } catch (e) {
        lines.push('7. Доступность сервера: ✗ ' + (e && e.message ? e.message : e));
      }
    } else {
      lines.push('7. Доступность сервера: — (не проверяли, адрес не годится)');
    }

    const st = ping && ping.state;
    if (st) {
      lines.push('8. Панель сервера: ' + (st.configFromServer
        ? '✓ настройки приходят из панели (белый список там приоритетнее)'
        : 'настройки локальные (панель их не присылает или сервер без этих ручек)'));
      lines.push('   clientId: ' + (st.clientId || '—') + ', последний чат: ' +
        ((st.chat && (st.chat.title || st.chat.chatKey)) || 'не определён') +
        ((st.chat && st.chat.topicTitle) ? ', рум «' + st.chat.topicTitle + '»' : '') +
        ((st.chat && st.chat.topicId != null) ? ' (id ' + st.chat.topicId + ')' : ''));
    }

    const box = $('diag');
    box.hidden = false;
    box.textContent = lines.join('\n');
    clearMsg();
  }

  /** Забрать настройки из панели сервера (белый список чатов и румов, пауза). */
  async function syncFromPanel() {
    const res = await notifyTab({ type: 'pk:sync' });
    if (!res) { show('warn', 'Вкладка Telegram Web не отвечает.'); return; }
    if (res.error) { show('err', res.error); return; }
    if (!res.config) {
      show('warn', 'Панель настроек не прислала: на сервере нет ручек /api/extension/config ' +
        '(старая версия) или не заданы сервер/токен. Работаем на локальных настройках.');
      return;
    }
    await load();
    show('ok', 'Настройки из панели применены: ' + (res.config.whitelist || []).length +
      ' записей в белом списке' + (res.config.paused ? ', пауза включена' : '') + '.');
  }

  async function checkServer() {
    const settings = readForm();
    const urlProblem = core.serverUrlProblem(settings.serverUrl);
    if (urlProblem) { show('err', urlProblem); return; }
    try {
      const res = await fetch(settings.serverUrl + '/api/ingest/status', { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (res.status === 404) { show('err', '404: роут /api/ingest/status не найден — на сервере старая версия.'); return; }
      if (body && body.enabled === false) {
        show('err', 'Сервер жив, но приём выключен: на воркере не задан INGEST_TOKEN (wrangler secret put INGEST_TOKEN).');
        return;
      }
      show('ok', `Сервер отвечает. Принято сегодня: ${body && body.today ? body.today.messages : 0} сообщений, ` +
        `создано заявок: ${body && body.today ? body.today.created : 0}. Остаток квоты ИИ: ${body ? body.aiQuotaLeft : '—'}.`);
    } catch (e) {
      show('err', 'Не достучались до сервера: ' + (e && e.message ? e.message : e) +
        '. Проверьте URL и что домен добавлен в host_permissions манифеста.');
    }
  }

  async function diagnose() {
    const res = await notifyTab({ type: 'pk:diagnostic' });
    const box = $('diag');
    box.hidden = false;
    if (!res) { box.textContent = 'Вкладка Telegram Web не отвечает.'; return; }
    if (res.error) { show('warn', res.error); box.textContent = res.error; return; }
    box.textContent = res.diagnostic || JSON.stringify(res.state || {}, null, 2);
    clearMsg();
  }

  async function sendNow() {
    const res = await notifyTab({ type: 'pk:send' });
    if (!res) { show('warn', 'Вкладка Telegram Web не отвечает.'); return; }
    if (res.error) { show('warn', res.error); return; }
    const c = (res.state && res.state.counters) || {};
    renderStats(c);
    show(res.state && res.state.error ? 'err' : 'ok',
      (res.state && res.state.status) || 'отправлено');
  }

  async function reset() {
    await notifyTab({ type: 'pk:reset' });
    renderStats({});
    show('ok', 'Счётчики и лог отправленного очищены. Сервер продолжит отсеивать дубли сам (tg_seen).');
  }

  $('save').addEventListener('click', saveSettings);
  $('selfcheck').addEventListener('click', selfCheck);
  $('connect').addEventListener('click', connectNow);
  $('sync').addEventListener('click', syncFromPanel);
  $('check').addEventListener('click', checkServer);
  $('diagnose').addEventListener('click', diagnose);
  $('send').addEventListener('click', sendNow);
  $('reset').addEventListener('click', reset);

  load();
})();
