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
    if (!settings.serverUrl) { show('err', 'Укажите базовый URL сервера (например https://pop-utka.app).'); return; }
    if (!/^https:\/\//.test(settings.serverUrl)) { show('err', 'URL сервера должен начинаться с https://'); return; }
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

  /** Спросить content script в активной вкладке Telegram Web. */
  async function notifyTab(message) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return null;
    if (!/^https:\/\/web\.telegram\.org\//.test(tab.url || '')) {
      return { error: 'Активная вкладка — не Telegram Web. Откройте web.telegram.org и войдите в чат.' };
    }
    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (e) {
      return { error: 'Вкладка не отвечает: обновите web.telegram.org (расширение подключается при загрузке страницы).' };
    }
  }

  async function checkServer() {
    const settings = readForm();
    if (!settings.serverUrl) { show('err', 'Сначала укажите URL сервера.'); return; }
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
  $('check').addEventListener('click', checkServer);
  $('diagnose').addEventListener('click', diagnose);
  $('send').addEventListener('click', sendNow);
  $('reset').addEventListener('click', reset);

  load();
})();
