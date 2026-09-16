#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { collectPublicChats, lastCollectReport } from '../src/collect.ts';
import { fetchPreview } from '../src/preview.ts';
import { parsePreviewHtml } from '../src/preview-html.ts';
import { createApp } from '../src/server.ts';
import {
  addWatchChat,
  listWatchChats,
  patchWatchChat,
  deleteWatchChat,
  getWatchChat,
} from '../src/store.ts';
import { createLocalEnv, envFromProcess } from './sqlite-env.ts';
import type { Env } from '../src/types.ts';

/**
 * Локальный запуск серверной части авто-сбора (вне Cloudflare).
 *
 * D1 и KV здесь заменяет встроенный `node:sqlite` (local/sqlite-env.ts),
 * поэтому весь код из src/ работает как в воркере, так и на вашей машине:
 *
 *   npm run db:local                                  — применить миграции
 *   npm run scan -- durov                             — что видит парсер на t.me/s/durov
 *   npm run scan -- durov --before 528 --html out.html
 *   npm run watch -- add drivers_pl_by --kind supergroup
 *   npm run watch -- list
 *   npm run watch -- collect --dry                    — прогон без записи в базу
 *   npm run watch -- collect                          — боевой прогон
 *   npm run watch -- daemon --every 900               — обход каждые 15 минут
 *   npm run watch -- report                           — последний отчёт
 *   npm run server                                    — HTTP API (ingest + админка)
 *
 * Переменные — из окружения или .env-файла (см. .dev.vars.example).
 */

const ROOT = resolve(import.meta.dirname ?? '.', '..');
const DB_PATH = process.env.COLLECT_DB ?? resolve(ROOT, '.data/collector.db');

// Пайп может закрыться раньше, чем мы допечатаем (`… | head -2`, `… | grep -q`):
// EPIPE не должен ронять CLI с «Unhandled 'error' event» — просто перестаём писать.
let stdoutOpen = true;
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') stdoutOpen = false;
  });
}

/* ------------------------------------------------------------------ */
/* Мелочи CLI                                                           */
/* ------------------------------------------------------------------ */

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  return { positional, flags };
}

function env(args: Args): Env & { close: () => void } {
  const vars = envFromProcess();
  if (typeof args.flags['no-ai'] === 'boolean' && args.flags['no-ai']) delete vars.AI_API_KEY;
  return createLocalEnv({ dbPath: args.flags.db ? String(args.flags.db) : DB_PATH, vars });
}

function line(s = ''): void { if (stdoutOpen) process.stdout.write(s + '\n'); }

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

/* ------------------------------------------------------------------ */
/* Команды                                                              */
/* ------------------------------------------------------------------ */

/** scan <username> — прочитать превью и показать, что разобрал парсер. БД не нужна. */
async function cmdScan(args: Args): Promise<number> {
  const username = args.positional[0];
  if (!username) {
    line('Использование: npm run scan -- <username> [--before <id>] [--html <file>] [--json] [--limit N]');
    return 2;
  }
  const before = args.flags.before ? Number(args.flags.before) : null;
  const started = Date.now();
  const page = await fetchPreview(username, {
    before,
    timeoutMs: Number(args.flags.timeout ?? 20000),
    baseUrl: typeof args.flags['base-url'] === 'string' ? args.flags['base-url'] : undefined,
    userAgent: typeof args.flags['user-agent'] === 'string' ? args.flags['user-agent'] : undefined,
  });

  if (args.flags.html) {
    mkdirSync(resolve(ROOT, '.data'), { recursive: true });
    const path = resolve(ROOT, String(args.flags.html));
    writeFileSync(path, page.html);
    line(`HTML сохранён: ${path} (${page.html.length} байт)`);
  }

  line(`URL:     ${page.url}`);
  line(`HTTP:    ${page.status} за ${Date.now() - started} мс`);
  line(`Заголовок: ${page.title ?? '—'}`);
  line(`Сообщений: ${page.messages.length}  (ids ${page.messages.map((m) => m.messageId).join(', ') || '—'})`);
  if (page.nextBefore != null) line(`Следующая страница: ?before=${page.nextBefore}`);

  if (page.messages.length === 0) {
    line('\n⚠ Сообщений не найдено. Возможные причины: чат приватный/удалён, у супергруппы нет веб-превью,');
    line('  Telegram показал капчу или поменял разметку. Сохраните HTML (--html page.html) и посмотрите глазами.');
    return 1;
  }

  if (args.flags.json) {
    line(JSON.stringify(page.messages, null, 2));
    return 0;
  }

  const limit = Number(args.flags.limit ?? page.messages.length);
  for (const m of page.messages.slice(-limit)) {
    line('');
    line(`#${m.messageId}  ${m.date ?? 'дата неизвестна'}  ${m.hasMedia ? '[медиа] ' : ''}${m.author ? `— ${m.author}` : ''}`);
    line(`   ${m.url}`);
    for (const l of m.text.split('\n')) line(`   ${truncate(l, 160)}`);
  }
  return 0;
}

/** parse <file.html> <username> — прогнать парсер по сохранённой странице (фикстуры, отладка). */
async function cmdParse(args: Args): Promise<number> {
  const file = args.positional[0];
  const username = args.positional[1] ?? 'unknown';
  if (!file) { line('Использование: npm run watch -- parse <file.html> [username]'); return 2; }
  const html = readFileSync(resolve(file), 'utf8');
  const { messages, title } = parsePreviewHtml(html, username);
  line(`title: ${title ?? '—'}  messages: ${messages.length}`);
  line(JSON.stringify(messages, null, 2));
  return 0;
}

/** db-init — применить миграции (создать .data/collector.db). */
async function cmdDbInit(args: Args): Promise<number> {
  const e = env(args);
  const tables = (await e.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all()).results as Array<{ name: string }>;
  line(`БД: ${DB_PATH}`);
  line(`Таблицы: ${tables.map((t) => t.name).join(', ')}`);
  const cols = (await e.DB.prepare('PRAGMA table_info(listings)').all()).results as Array<{ name: string }>;
  line(`listings.origin: ${cols.some((c) => c.name === 'origin') ? 'есть (миграция 0006 применена)' : 'НЕТ'}`);
  e.close();
  return 0;
}

/** watch-chats: add / list / rm / enable / disable / cursor */
async function cmdWatchChats(args: Args): Promise<number> {
  const e = env(args);
  const action = args.positional[0] ?? 'list';
  try {
    if (action === 'add') {
      const username = args.positional[1];
      if (!username) { line('Использование: watch-chats add <username> [--kind supergroup] [--title "…"]'); return 2; }
      const chat = await addWatchChat(e, {
        username,
        kind: args.flags.kind === 'supergroup' ? 'supergroup' : 'channel',
        title: typeof args.flags.title === 'string' ? args.flags.title : null,
      });
      line(`Добавлен ${chat.id} (${chat.kind}), курсор: ${chat.lastMessageId ?? 'не установлен'}`);
      line('Первый прогон возьмёт только последнюю страницу — история назад не выкачивается.');
      return 0;
    }

    if (action === 'list') {
      const chats = await listWatchChats(e);
      if (chats.length === 0) { line('Список пуст: watch-chats add <username>'); return 0; }
      line('id                        вкл  тип        курсор    найдено/создано/отсеяно  последняя проверка     ошибка');
      for (const c of chats) {
        line(
          `${c.id.padEnd(26)}${(c.enabled ? 'да' : 'нет').padEnd(5)}${c.kind.padEnd(11)}` +
          `${String(c.lastMessageId ?? '—').padEnd(10)}` +
          `${`${c.statsFound}/${c.statsCreated}/${c.statsSkipped}`.padEnd(25)}` +
          `${(c.lastCheckedAt ?? '—').padEnd(23)}${c.lastError ?? ''}` +
          (c.errorCount ? ` (ошибок подряд: ${c.errorCount})` : '')
        );
      }
      return 0;
    }

    const id = args.positional[1];
    if (!id) { line('Нужен id чата (web:<username>)'); return 2; }
    const full = id.startsWith('web:') ? id : `web:${id}`;

    if (action === 'rm') {
      const ok = await deleteWatchChat(e, full);
      line(ok ? `Удалён ${full} (заявки не тронуты)` : `${full} не найден`);
      return ok ? 0 : 1;
    }
    if (action === 'enable' || action === 'disable') {
      const chat = await patchWatchChat(e, full, { enabled: action === 'enable' });
      line(chat ? `${full}: ${chat.enabled ? 'включён' : 'выключен'}` : `${full} не найден`);
      return chat ? 0 : 1;
    }
    if (action === 'cursor') {
      const raw = args.positional[2];
      const value = raw === undefined || raw === 'reset' ? null : Number(raw);
      if (value !== null && !Number.isInteger(value)) { line('Курсор — целое число или «reset»'); return 2; }
      const chat = await patchWatchChat(e, full, { lastMessageId: value });
      line(chat ? `${full}: курсор ${chat.lastMessageId ?? 'сброшен'}` : `${full} не найден`);
      return chat ? 0 : 1;
    }
    line(`Неизвестное действие: ${action}`);
    return 2;
  } finally {
    e.close();
  }
}

/** collect — один прогон сборщика. */
async function cmdCollect(args: Args): Promise<number> {
  const e = env(args);
  try {
    const dryRun = Boolean(args.flags.dry ?? args.flags.dryRun);
    const only = typeof args.flags.chat === 'string' ? args.flags.chat : args.positional[0];
    const report = await collectPublicChats(e, {
      onlyChatId: only,
      dryRun,
      force: true, // локальный запуск — вручную, COLLECT_ENABLED не требуется
      maxChats: args.flags['max-chats'] ? Number(args.flags['max-chats']) : undefined,
      useAi: args.flags['no-ai'] ? false : undefined,
      baseUrl: typeof args.flags['base-url'] === 'string' ? args.flags['base-url'] : undefined,
      delayMs: args.flags['no-delay'] ? 0 : undefined,
    });

    line(`${dryRun ? '[dry run] ' : ''}Чатов: ${report.totals.chats}, запросов: ${report.totals.fetches}, ` +
      `найдено: ${report.totals.fetched}, новых: ${report.totals.new}, создано заявок: ${report.totals.created}, ` +
      `дублей: ${report.totals.duplicate}, отсеяно: ${report.totals.skipped}, ошибок: ${report.totals.errors}`);
    line(`Квота ИИ сборщика на сегодня осталась: ${report.aiQuotaLeft}`);
    for (const c of report.chats) {
      line(`  ${c.username.padEnd(24)} ${c.status.padEnd(14)} курсор ${String(c.cursorBefore ?? '—')} → ${String(c.cursorAfter ?? '—')}  ` +
        `новых ${c.new}, заявок ${c.created}${c.error ? `  ⚠ ${c.error}` : ''}`);
    }
    if (args.flags.json) line(JSON.stringify(report, null, 2));
    return report.totals.errors > 0 ? 1 : 0;
  } finally {
    e.close();
  }
}

/** report — последний отчёт прогона (из KV). */
async function cmdReport(args: Args): Promise<number> {
  const e = env(args);
  try {
    const { report, aiUsedToday, errorCount } = await lastCollectReport(e);
    if (!report) { line('Отчётов ещё нет: сначала запустите collect'); return 1; }
    line(`Последний прогон: ${report.startedAt} → ${report.finishedAt}${report.dryRun ? ' (dry run)' : ''}`);
    line(JSON.stringify(report.totals, null, 2));
    line(`ИИ-вызовов сборщика сегодня: ${aiUsedToday}, чатов с ошибками/выключено: ${errorCount}`);
    return 0;
  } finally {
    e.close();
  }
}

/** daemon — обход по интервалу (локальная замена cron воркера). */
async function cmdDaemon(args: Args): Promise<number> {
  const everySec = Math.max(60, Number(args.flags.every ?? 3600));
  line(`Авто-сбор каждые ${everySec} с. Ctrl-C — остановить. Чаты: watch-chats list`);
  for (;;) {
    const startedAt = new Date().toISOString();
    try {
      await cmdCollect(args);
    } catch (e) {
      line(`Ошибка прогона: ${String(e)}`);
    }
    line(`— следующий обход не раньше ${new Date(Date.now() + everySec * 1000).toISOString()} (начали ${startedAt})`);
    await new Promise((r) => setTimeout(r, everySec * 1000));
  }
}

/** server — HTTP API: POST /api/ingest + админка авто-сбора. */
async function cmdServer(args: Args): Promise<void> {
  const e = env(args);
  const port = Number(args.flags.port ?? process.env.PORT ?? 8787);
  const host = String(args.flags.host ?? '0.0.0.0');
  const app = createApp();
  // @hono/node-server сам не знает про наши биндинги: передаём локальный Env
  // (sqlite-D1 + KV + переменные) вторым аргументом app.fetch — так же, как
  // это делает Cloudflare Workers в проде.
  const boundFetch = (req: Request): Promise<Response> => app.fetch(req, e) as Promise<Response>;
  line(`БД: ${DB_PATH}`);
  line(`API на http://${host}:${port}`);
  line(`  POST /api/ingest              (Authorization: Bearer $INGEST_TOKEN)`);
  line(`  GET  /api/ingest/status`);
  line(`  GET  /api/admin/watch-chats   (Authorization: Bearer $ADMIN_API_TOKEN)`);
  line(`  POST /api/admin/collect       { "chatId": "…", "dryRun": true }`);
  line(`  GET  /api/admin/collect/status`);
  line(`  GET  /api/health`);
  serve({ fetch: boundFetch, port, hostname: host }, (info) => {
    line(`Слушаю ${info.address}:${info.port}`);
  });
  // держим процесс живым: останавливается по Ctrl-C / SIGTERM
  await new Promise<never>(() => {});
}

/** ingest — отправить батч в /api/ingest (проверка контракта без браузера). */
async function cmdIngest(args: Args): Promise<number> {
  const file = args.positional[0];
  const url = String(args.flags.url ?? 'http://127.0.0.1:8787/api/ingest');
  const token = String(args.flags.token ?? process.env.INGEST_TOKEN ?? 'dev-ingest-token');
  const body = file
    ? readFileSync(resolve(file), 'utf8')
    : JSON.stringify({
        collector: 'cli/1.0.0',
        dryRun: Boolean(args.flags.dry),
        messages: [{
          chatId: 'web:drivers_pl_by',
          chatTitle: 'Водители Польша–Беларусь',
          chatUrl: 'https://t.me/drivers_pl_by',
          messageId: Number(args.flags.id ?? 1),
          date: Math.floor(Date.now() / 1000),
          text: String(args.flags.text ?? '25.09 Варшава — Брест, возьму посылку до 20 кг, +48 579 264 254'),
        }],
      });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body,
  });
  line(`HTTP ${res.status}`);
  line(JSON.stringify(await res.json(), null, 2));
  return res.ok ? 0 : 1;
}

const HELP = `Авто-сбор объявлений из публичных чатов Telegram (t.me/s/<username>).

Команды:
  scan <username> [--before <id>] [--html f.html] [--json] [--limit N]
        [--base-url http://127.0.0.1:8000/s] [--user-agent "…"]
        прочитать веб-превью и показать разобранные сообщения (БД не нужна)
  parse <file.html> [username]
        прогнать парсер по сохранённой странице
  db-init
        применить миграции к локальной базе (${DB_PATH})
  watch-chats add <username> [--kind supergroup] [--title "…"]
  watch-chats list | rm <id> | enable <id> | disable <id> | cursor <id> [<n>|reset]
  collect [--dry] [--chat <id>] [--max-chats N] [--no-ai] [--no-delay] [--json]
        один прогон сборщика (заявки попадают в очередь модерации локальной БД)
  report
        последний отчёт прогона
  daemon [--every <сек>]
        обход по интервалу — локальная замена cron воркера
  server [--port 8787]
        HTTP API: POST /api/ingest и админка авто-сбора
  ingest [file.json] [--url …] [--token …] [--dry]
        отправить батч в /api/ingest (проверка контракта)

Пример:
  npm run db:local
  npm run scan -- durov
  npm run watch -- watch-chats add drivers_pl_by --kind supergroup
  npm run watch -- collect --dry
  npm run watch -- collect
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0];
  // команды watch-chats/collect/… идут и как «npm run watch -- <cmd>», и первым аргументом
  const sub = args.positional[0];
  if (!command || command === 'help' || args.flags.help) { line(HELP); return 0; }

  switch (sub) {
    case 'scan': return cmdScan({ ...args, positional: args.positional.slice(1) });
    case 'parse': return cmdParse({ ...args, positional: args.positional.slice(1) });
    case 'db-init': return cmdDbInit(args);
    case 'watch-chats': return cmdWatchChats({ ...args, positional: args.positional.slice(1) });
    case 'collect': return cmdCollect({ ...args, positional: args.positional.slice(1) });
    case 'report': return cmdReport(args);
    case 'daemon': return cmdDaemon({ ...args, positional: args.positional.slice(1) });
    case 'server':
      await cmdServer({ ...args, positional: args.positional.slice(1) });
      return 0;
    case 'ingest': return cmdIngest({ ...args, positional: args.positional.slice(1) });
    default:
      line(`Неизвестная команда: ${command}\n`);
      line(HELP);
      return 2;
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (e) => { console.error(e); process.exitCode = 1; }
);
