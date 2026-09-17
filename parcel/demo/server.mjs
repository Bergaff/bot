/**
 * Демо-сервер админ-панели (этап 6) — один процесс, три роли:
 *
 *   1. статика демо: index.html, styles.css и /demo-bundle.js — склейка
 *      demo/helpers.js + ../app-auto-collect.js + demo/demo.js. Это ровно то,
 *      что в проде получится внутри public/app.js (он загружается как
 *      type="module", поэтому блок вставляется в файл, а не подключается отдельно);
 *   2. НАСТОЯЩИЙ API из src/server.ts (watch-chats, collect, collect/status,
 *      ingest) на локальном sqlite вместо D1 — те же роуты, что поедут в воркер;
 *   3. зеркало t.me/s/ на фикстурах (local/mock-tme.mjs) — сборщик переключается
 *      на него переменной COLLECT_PREVIEW_BASE, поэтому «проверить сейчас»
 *      работает без интернета.
 *
 * Плюс заглушки тех ручек parcel, которые уже существуют в проде, но не входят
 * в этот репозиторий: /api/admin/listings, /source-chats, /chat-links.
 *
 * Запуск:  node parcel/demo/server.mjs [port]     (по умолчанию 8790)
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../../src/server.ts';
import { createLocalEnv } from '../../local/sqlite-env.ts';
import { handlePreviewRequest } from '../../local/mock-tme.mjs';
import {
  addWatchChat,
  createListing,
  deleteListing,
  ensureChatLinksTable,
  listAdminBoard,
  listPending,
  listSourceChats,
  upsertChatLink,
  updateListingStatus,
} from '../../src/store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const parcelDir = resolve(here, '..');
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8790);
const HOST = '0.0.0.0';
const ADMIN_TOKEN = 'demo-admin-token';
const INGEST_TOKEN = 'demo-ingest-token';
const DB_PATH = resolve(here, '..', '..', '.data', 'demo.db');

const env = createLocalEnv({
  dbPath: DB_PATH,
  vars: {
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    INGEST_TOKEN,
    COLLECT_ENABLED: '1',
    COLLECT_MAX_CHATS: '10',
    COLLECT_MAX_PAGES: '2',
    // фикстуры датированы июнем–сентябрём 2026: берём с запасом, чтобы демо
    // показывало и созданные заявки, и отсев по возрасту
    COLLECT_MAX_AGE_DAYS: '200',
    COLLECT_AI_DAILY_LIMIT: '20',
    COLLECT_PREVIEW_BASE: `http://127.0.0.1:${PORT}/mirror/s`,
  },
});
const app = createApp();

/* ------------------------------------------------------------------ */
/* Демо-данные                                                         */
/* ------------------------------------------------------------------ */

const SEED_CHATS = [
  { username: 'durov', kind: 'channel', title: 'Durov’s Channel' },
  { username: 'drivers_pl_by', kind: 'supergroup', title: 'Водители Польша–Беларусь' },
  { username: 'broken_channel', kind: 'channel', title: 'Чат с изменившейся разметкой' },
];

const SEED_LISTINGS = [
  {
    type: 'offer', fromCity: 'Варшава', toCity: 'Брест', departureDate: isoDateIn(3),
    weightKg: 20, price: '40 BYN', description: 'Еду в пятницу вечером, возьму посылку до 20 кг, заберу у метро Centrum.',
    phone: '+48 579 264 254', status: 'pending', source: 'telegram',
    sourceChat: 'Переслано от Ивана', sourceChatId: '-1001234567890', sourceMessageId: 4211,
    origin: 'bot',
  },
  {
    type: 'offer', fromCity: 'Брест', toCity: 'Варшава', departureDate: isoDateIn(5),
    weightKg: 15, description: 'Возьму посылку до 15 кг, выезд утром, терминал Варшава-Заходня.',
    telegram: '@sergei_i', status: 'pending', source: 'parser',
    sourceChat: 'Водители Польша–Беларусь', sourceChatId: 'web:drivers_pl_by', sourceMessageId: 1234,
    origin: 'collector',
  },
  {
    type: 'request', fromCity: 'Краков', toCity: 'Минск', departureDate: isoDateIn(2),
    weightKg: 2, description: 'Нужно передать документы, до 2 кг, срочно.',
    telegram: '@anna_k', status: 'pending', source: 'parser',
    sourceChat: 'Посылки Польша–Беларусь', sourceChatId: 'web:posylki_pl_by', sourceMessageId: 528,
    origin: 'extension',
  },
  {
    type: 'request', fromCity: 'Гродно', toCity: 'Минск', departureDate: isoDateIn(1),
    weightKg: 5, description: 'Передам коробку с вещами, 5 кг.',
    phone: '+375 29 123 45 67', status: 'pending', source: 'telegram',
    sourceChat: 'Переслано от Ольги', sourceChatId: '-1009876543210', sourceMessageId: 88,
    origin: 'bot',
  },
  {
    type: 'offer', fromCity: 'Минск', toCity: 'Вильнюс', departureDate: isoDateIn(-1),
    weightKg: 10, description: 'Опубликованная заявка для вкладки «доска».',
    telegram: '@driver_vno', status: 'published', source: 'parser',
    sourceChat: 'Водители Польша–Беларусь', sourceChatId: 'web:drivers_pl_by', sourceMessageId: 1200,
    origin: 'collector',
  },
];

function isoDateIn(days) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

/** Создать демо-данные (чаты обхода + заявки трёх источников). */
async function seed() {
  for (const chat of SEED_CHATS) {
    await addWatchChat(env, chat).catch(() => undefined);
  }
  for (const l of SEED_LISTINGS) {
    await createListing(env, l).catch((e) => console.error('seed listing failed:', String(e)));
  }
  // ссылка на приватный супер-чат: делает подпись источника кликабельной
  await ensureChatLinksTable(env);
  await upsertChatLink(env, '-1001234567890', 'https://t.me/drivers_pl_by');
}

/** Полный сброс демо: очистить заявки и лог «уже видел», засеять заново. */
async function resetDemo() {
  env.db.exec('DELETE FROM listings');
  env.db.exec('DELETE FROM tg_seen');
  env.db.exec("UPDATE watch_chats SET last_message_id = NULL, last_error = NULL, error_count = 0, stats_found = 0, stats_created = 0, stats_skipped = 0");
  await seed();
}

/* ------------------------------------------------------------------ */
/* Статика и склейка бандла                                            */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** helpers + блок авто-сбора + демо-обвязка = «app.js в миниатюре». */
function demoBundle() {
  const parts = [
    [join(here, 'helpers.js'), 'public/app.js (помощники)'],
    [join(parcelDir, 'app-auto-collect.js'), 'parcel/app-auto-collect.js (блок этапа 6)'],
    [join(here, 'demo.js'), 'demo/demo.js (обвязка)'],
  ];
  return parts
    .map(([file, label]) => `/* ---- ${label} ---- */\n${readFileSync(file, 'utf8')}`)
    .join('\n\n');
}

function sendStatic(res, file) {
  if (!existsSync(file)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
}

/* ------------------------------------------------------------------ */
/* Заглушки ручек parcel (в проде они уже есть в src/index.ts)          */
/* ------------------------------------------------------------------ */

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  return req.headers.authorization === `Bearer ${ADMIN_TOKEN}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

/** Обработка «чужих» админ-ручек parcel; вернёт true, если запрос обработан. */
async function handleParcelStub(req, res, url) {
  const path = url.pathname;

  if (path === '/api/admin/demo/reset' && req.method === 'POST') {
    if (!authorized(req)) { json(res, 401, { error: 'unauthorized' }); return true; }
    await resetDemo();
    json(res, 200, { ok: true });
    return true;
  }

  if (path === '/api/admin/listings' && req.method === 'GET') {
    if (!authorized(req)) { json(res, 401, { error: 'unauthorized' }); return true; }
    const tab = url.searchParams.get('tab') || 'pending';
    const items = tab === 'board' ? await listAdminBoard(env, 200) : await listPending(env, 100);
    json(res, 200, { items });
    return true;
  }

  const statusMatch = /^\/api\/admin\/listings\/([^/]+)\/(status|delete)$/.exec(path);
  if (statusMatch && req.method === 'POST') {
    if (!authorized(req)) { json(res, 401, { error: 'unauthorized' }); return true; }
    const id = decodeURIComponent(statusMatch[1]);
    if (statusMatch[2] === 'delete') {
      const ok = await deleteListing(env, id);
      json(res, ok ? 200 : 404, { ok });
      return true;
    }
    const body = await readBody(req);
    const status = body ? JSON.parse(body.toString('utf8')).status : null;
    const ok = await updateListingStatus(env, id, status);
    json(res, ok ? 200 : 404, { ok });
    return true;
  }

  if (path === '/api/admin/source-chats' && req.method === 'GET') {
    if (!authorized(req)) { json(res, 401, { error: 'unauthorized' }); return true; }
    try {
      json(res, 200, { chats: await listSourceChats(env) });
    } catch (e) {
      json(res, 200, { chats: [], needsSetup: true, error: String(e) });
    }
    return true;
  }

  if (path === '/api/admin/chat-links' && req.method === 'PUT') {
    if (!authorized(req)) { json(res, 401, { error: 'unauthorized' }); return true; }
    const body = JSON.parse((await readBody(req)).toString('utf8'));
    await ensureChatLinksTable(env);
    await upsertChatLink(env, String(body.chatId), body.url ? String(body.url) : null);
    json(res, 200, { ok: true });
    return true;
  }

  if (path === '/api/admin/ensure-chat-links' && req.method === 'POST') {
    if (!authorized(req)) { json(res, 401, { error: 'unauthorized' }); return true; }
    await ensureChatLinksTable(env);
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}

/* ------------------------------------------------------------------ */
/* Сервер                                                              */
/* ------------------------------------------------------------------ */

let seeded = false;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  try {
    if (!seeded) {
      seeded = true;
      const existing = await listPending(env, 1);
      if (existing.length === 0) {
        console.log('демо: БД пустая — засеваю демо-данные');
        await seed();
      }
    }

    /* зеркало t.me/s/ для сборщика */
    if (path.startsWith('/mirror/s')) {
      handlePreviewRequest(req, res, '/mirror');
      return;
    }

    /* статика демо */
    if (path === '/' || path === '/index.html') { sendStatic(res, join(here, 'index.html')); return; }
    if (path === '/styles.css') { sendStatic(res, join(here, 'styles.css')); return; }
    if (path === '/demo-bundle.js') {
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
      res.end(demoBundle());
      return;
    }
    if (path === '/app-auto-collect.js') { sendStatic(res, join(parcelDir, 'app-auto-collect.js')); return; }
    if (path === '/helpers.js') { sendStatic(res, join(here, 'helpers.js')); return; }
    if (path === '/demo.js') { sendStatic(res, join(here, 'demo.js')); return; }

    /* заглушки ручек parcel, которых нет в этом репозитории */
    if (path.startsWith('/api/') && await handleParcelStub(req, res, url)) return;

    /* всё остальное /api/* — настоящий воркер-код (src/server.ts) */
    if (path.startsWith('/api/')) {
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body,
        duplex: 'half',
      });
      const response = await app.fetch(request, env);
      const headers = {};
      response.headers.forEach((v, k) => { headers[k] = v; });
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (e) {
    console.error('demo server error:', e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`демо админки (этап 6): http://${HOST}:${PORT}/`);
  console.log(`  БД: ${DB_PATH}`);
  console.log(`  ADMIN_API_TOKEN=${ADMIN_TOKEN}  INGEST_TOKEN=${INGEST_TOKEN}`);
  console.log(`  зеркало t.me/s/: http://127.0.0.1:${PORT}/mirror/s/durov`);
  console.log(`  настоящий API: /api/admin/watch-chats, /api/admin/collect, /api/admin/collect/status, /api/ingest`);
  console.log('');
  console.log('  Что вписать в попап расширения (иконка «попутка. — сбор объявлений»):');
  console.log(`    serverUrl : http://127.0.0.1:${PORT}`);
  console.log(`    token     : ${INGEST_TOKEN}`);
  console.log(`    админка   : http://localhost:${PORT}/  → вкладка «очередь», бейдж «расширение»`);
  console.log('  Порядок: chrome://extensions → Режим разработчика → «Загрузить распакованное»');
  console.log('  → папка extension/ → открыть https://web.telegram.org → «Диагностика вкладки».');
  console.log('  Подробно и с таблицей ошибок: docs/try-it.md');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    env.close();
    process.exit(0);
  });
}
