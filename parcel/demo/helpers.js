/* ------------------------------------------------------------------ *
 * Демо админ-панели: помощники, СКОПИРОВАННЫЕ из public/app.js проекта
 * Bergaff/parcel (ветка arena/01a0a5c0-parcel). Ничего своего здесь нет —
 * блок parcel/app-auto-collect.js должен работать именно с этими функциями,
 * поэтому в демо они настоящие.
 *
 * В проде этот файл не нужен: app-auto-collect.js вставляется прямо в app.js,
 * где все помощники уже есть (app.js загружается как type="module", поэтому
 * отдельным <script> блок не подключить — см. INTEGRATION.md, шаг 6).
 * ------------------------------------------------------------------ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/* Адрес API: в демо — тот же сервер (пустая строка), в проде задаётся в index.html. */
const API_BASE = (window.POPUTKA_API_BASE || '').replace(/\/+$/, '');

async function api(path, options = {}) {
  return fetch(`${API_BASE}${path}`, options);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function toast(message) {
  const t = $('#toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 3600);
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

function ago(iso) {
  const d = new Date(iso);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400 && d.getDate() === new Date().getDate()) {
    return `сегодня в ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  if (s < 172800) return 'вчера';
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

function contactInfo(l) {
  const values = [l.telegram, l.phone].filter((v) => typeof v === 'string' && v.trim());
  for (const v of values) {
    const t = v.trim();
    const m = /(?:t\.me\/|@)([a-zA-Z0-9_]{4,32})/i.exec(t)
      || (/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(t) ? [t, t] : null);
    if (m) return { kind: 'telegram', href: `https://t.me/${m[1]}`, label: `@${m[1]}` };
  }
  for (const v of values) {
    const m = /\+?\d[\d\s\-()]{7,16}\d/.exec(v);
    if (m && m[0].replace(/\D/g, '').length >= 9) {
      return { kind: 'phone', href: `tel:${m[0].replace(/[^\d+]/g, '')}`, label: m[0].trim() };
    }
  }
  return null;
}

function sourceLabel(l) {
  if (l.sourceChat && l.sourceChat.startsWith('Переслано от ')) {
    return l.source === 'parser' ? `${l.sourceChat} · ИИ-разбор` : l.sourceChat;
  }
  if (l.source === 'parser') return l.sourceChat ? `ИИ-разбор из чата «${l.sourceChat}»` : 'ИИ-разбор';
  if (l.source === 'telegram') return l.sourceChat ? `из чата «${l.sourceChat}»` : 'из Telegram';
  return 'с сайта';
}

let chatLinks = {}; // публичные ссылки на чаты-источники (id чата → t.me/…)

/* ПРАВКА 4 (этап 6): ключи авто-сбора — 'web:<username>' (публичный чат,
   ссылка есть) и 'ext:<peer-id>' (приватный чат из расширения, ссылки нет).
   Без этой правки подпись источника у собранных заявок остаётся некликабельной. */
function sourceLinkUrl(l) {
  if (!l.sourceChatId) return null;
  /* Рум (топик) форум-чата: ссылка на сообщение трёхчастная —
     t.me/<чат>/<рум>/<сообщение> (служебная — t.me/c/<id>/<рум>/<сообщение>). */
  const topic = l.sourceTopicId ? '/' + l.sourceTopicId : '';
  const msg = l.sourceMessageId != null ? '/' + l.sourceMessageId : '';
  /* Ссылку, заданную админом, дополняем сообщением только если это t.me/<username>:
     пригласительные t.me/+AbC… и служебные t.me/c/<id> так не работают. */
  const manual = chatLinks[l.sourceChatId];
  if (manual) {
    return /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]*$/.test(String(manual).replace(/\/$/, ''))
      ? manual.replace(/\/$/, '') + topic + msg
      : manual;
  }
  const web = /^web:([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(l.sourceChatId);
  if (web) return `https://t.me/${web[1]}${topic}${msg}`;
  if (l.sourceChatId.startsWith('ext:')) return null;
  const m = /^-100(\d+)$/.exec(l.sourceChatId);
  if (!m) return null;
  return `https://t.me/c/${m[1]}${topic}${msg}`;
}

function sourceContent(l) {
  const url = sourceLinkUrl(l);
  if (!url) return sourceLabel(l);
  return el('a', { href: url, target: '_blank', rel: 'noopener', text: sourceLabel(l) });
}

const ADMIN_KEY_STORAGE = 'popoutka_admin_key';
let adminTab = 'pending'; // 'pending' | 'board' | 'chats' | 'match'

function adminKey() { return localStorage.getItem(ADMIN_KEY_STORAGE) || ''; }

async function adminApi(path, options = {}) {
  return api(path, {
    ...options,
    headers: { Authorization: `Bearer ${adminKey()}`, ...(options.headers || {}) },
  });
}
