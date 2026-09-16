#!/usr/bin/env node
/**
 * Мониторинг авто-сбора (этап 7): один запрос к серверу — понятный отчёт
 * «всё ли здорово» и ненулевой код возврата, если нет (удобно вешать в cron
 * или в проверку деплоя).
 *
 *   node scripts/collect-report.mjs --url https://pop-utka.app --token $ADMIN_API_TOKEN
 *   node scripts/collect-report.mjs --json
 *   node scripts/collect-report.mjs --stale-hours 6 --fail-on errors,disabled,stale
 *
 * Что считает проблемой:
 *   errors   — чаты с ошибками за последний прогон (markup_changed, blocked, network);
 *   disabled — чаты, которые сборщик выключил сам (3 ошибки подряд или 404);
 *   quota    — дневная квота ИИ выбрана (сбор продолжается, но только правилами);
 *   stale    — включённый чат не проверяли дольше N часов (cron не работает?);
 *   token    — INGEST_TOKEN не задан: приём от расширения выключен (503);
 *   empty    — за последний прогон не создано ни одной заявки при живых чатах.
 */

import { resolve } from 'node:path';

/** «1 проблема», «2 проблемы», «5 проблем». */
function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/** Порог «чат давно не проверяли» в часах. */
export const DEFAULT_STALE_HOURS = 6;

/**
 * Разбор ответа сервера в список проблем и строк отчёта — чистая функция,
 * чтобы её можно было проверить тестами без сети.
 *
 * @param {object} status  ответ GET /api/admin/collect/status
 * @param {Array}  chats   ответ GET /api/admin/watch-chats ({chats: [...]})
 * @param {object} opts    { staleHours, failOn, now }
 */
export function summarize(status, chats, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const staleHours = opts.staleHours ?? DEFAULT_STALE_HOURS;
  const failOn = new Set(String(opts.failOn ?? 'errors,disabled').split(',').map((s) => s.trim()).filter(Boolean));
  const list = Array.isArray(chats) ? chats : [];
  const problems = [];
  const warnings = [];
  const lines = [];

  const s = status && typeof status === 'object' ? status : {};
  const ai = s.ai || {};
  const origins = s.listingsByOrigin || {};
  const wc = s.watchChats || {};
  const report = s.lastReport || null;
  const totals = report ? report.totals : null;

  lines.push(`cron-сборщик: ${s.enabled ? 'включён' : 'ВЫКЛЮЧЕН (COLLECT_ENABLED != 1)'}`);
  lines.push(`приём от расширения: ${s.ingestTokenSet ? 'включён' : 'ВЫКЛЮЧЕН (нет INGEST_TOKEN)'}`);
  lines.push(`чатов в обходе: ${wc.enabled ?? 0} включено из ${wc.total ?? 0}, с ошибками ${wc.withErrors ?? 0}`);
  lines.push(`ИИ сборщика сегодня: ${ai.collectUsedToday ?? 0}/${ai.collectLimit ?? 0} (осталось ${ai.collectLeft ?? 0})`);
  lines.push(`ИИ расширения сегодня: осталось ${ai.ingestLeft ?? 0}`);
  lines.push(`заявок по источникам: бот ${origins.bot ?? 0}, сборщик ${origins.collector ?? 0}, расширение ${origins.extension ?? 0}`);
  if (s.extensionToday) {
    lines.push(`расширение за сутки: принято ${s.extensionToday.messages ?? 0} сообщений, создано ${s.extensionToday.created ?? 0} заявок`);
  }
  lines.push(report
    ? `последний прогон: ${report.startedAt}${report.dryRun ? ' (dry run)' : ''}`
    : 'последний прогон: ещё не запускался');
  if (totals) {
    lines.push(`итоги прогона: чатов ${totals.chats}, найдено ${totals.fetched}, новых ${totals.new}, ` +
      `заявок ${totals.created}, дублей ${totals.duplicate}, отсеяно ${totals.skipped}, ошибок ${totals.errors}`);
  }

  if (!s.ingestTokenSet) problems.push({ kind: 'token', text: 'INGEST_TOKEN не задан: расширение получает 503, приём выключен' });
  if ((ai.collectLeft ?? 0) <= 0) warnings.push({ kind: 'quota', text: `Дневная квота ИИ сборщика выбрана (${ai.collectUsedToday ?? 0}/${ai.collectLimit ?? 0}) — разбираем только правилами` });
  if ((ai.ingestLeft ?? 0) <= 0) warnings.push({ kind: 'quota', text: 'Дневная квота ИИ расширения выбрана — расширение разбирает только правилами' });

  /* По чатам */
  for (const c of list) {
    const lastChecked = c.lastCheckedAt ? new Date(String(c.lastCheckedAt).includes('T') ? c.lastCheckedAt : String(c.lastCheckedAt).replace(' ', 'T') + 'Z') : null;
    const ageHours = lastChecked ? (now.getTime() - lastChecked.getTime()) / 3600000 : null;
    const flags = [];

    if (!c.enabled) flags.push('выключен');
    if (c.lastError) flags.push(`ошибка: ${c.lastError}`);
    if (c.errorCount >= 3 || (!c.enabled && c.lastError)) {
      problems.push({
        kind: 'disabled',
        text: `${c.username}: сборщик выключил чат (${c.lastError || 'ошибки подряд'}) — проверьте, жив ли чат, и включите обратно`,
      });
    } else if (c.lastError) {
      problems.push({ kind: 'errors', text: `${c.username}: ${c.lastError} (попыток подряд: ${c.errorCount ?? 0})` });
    }
    if (c.enabled && ageHours !== null && ageHours > staleHours) {
      problems.push({ kind: 'stale', text: `${c.username}: не проверяли ${Math.round(ageHours)} ч (порог ${staleHours} ч) — cron не запускается?` });
      flags.push(`не проверяли ${Math.round(ageHours)} ч`);
    }
    if (c.enabled && ageHours === null) flags.push('ещё не проверялся');

    lines.push(`  ${c.username} [${c.kind}] ${c.enabled ? 'вкл' : 'выкл'} · курсор ${c.lastMessageId ?? '—'} · ` +
      `найдено ${c.statsFound ?? 0} / заявок ${c.statsCreated ?? 0} / отсеяно ${c.statsSkipped ?? 0}` +
      (flags.length ? ` · ${flags.join(', ')}` : ''));
  }

  if (totals && totals.chats > 0 && totals.created === 0 && totals.duplicate === 0) {
    warnings.push({ kind: 'empty', text: `Прогон прошёл по ${totals.chats} чатам, но не создал ни одной заявки (найдено ${totals.fetched}, отсеяно ${totals.skipped})` });
  }

  const failing = problems.filter((p) => failOn.has(p.kind));
  return {
    ok: failing.length === 0,
    problems,
    warnings,
    failing,
    failOn: [...failOn],
    lines,
    chats: list.length,
    generatedAt: now.toISOString(),
  };
}

/** Отчёт текстом — то, что видит дежурный. */
export function formatReport(summary) {
  const out = [];
  out.push('Авто-сбор объявлений: состояние на ' + summary.generatedAt);
  out.push('');
  for (const l of summary.lines) out.push(l);
  if (summary.warnings.length) {
    out.push('');
    out.push('Предупреждения:');
    for (const w of summary.warnings) out.push(`  ! ${w.text}`);
  }
  if (summary.problems.length) {
    out.push('');
    out.push('Проблемы:');
    for (const p of summary.problems) out.push(`  × [${p.kind}] ${p.text}`);
  }
  out.push('');
  out.push(summary.ok
    ? `Всё в порядке (${summary.chats} ${plural(summary.chats, 'чат', 'чата', 'чатов')} в обходе).`
    : `Нужно вмешательство: ${summary.failing.length} ${plural(summary.failing.length, 'проблема', 'проблемы', 'проблем')} ` +
        `из списка --fail-on ${summary.failOn.join(',')}.`);
  return out.join('\n');
}

/** Сходить на сервер за статусом и списком чатов. */
export async function fetchState(url, token, fetchImpl = fetch) {
  const base = String(url || '').replace(/\/+$/, '');
  if (!base) throw new Error('не задан --url');
  const headers = { Authorization: `Bearer ${token || ''}` };
  const [statusRes, chatsRes] = await Promise.all([
    fetchImpl(`${base}/api/admin/collect/status`, { headers, cache: 'no-store' }),
    fetchImpl(`${base}/api/admin/watch-chats`, { headers, cache: 'no-store' }),
  ]);
  if (statusRes.status === 401 || chatsRes.status === 401) throw new Error('401: неверный ADMIN_API_TOKEN');
  if (!statusRes.ok) throw new Error(`collect/status вернул ${statusRes.status}`);
  const status = await statusRes.json();
  const chats = chatsRes.ok ? (await chatsRes.json()).chats || [] : [];
  return { status, chats };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = {
    url: process.env.COLLECT_URL || 'http://127.0.0.1:8787',
    token: process.env.ADMIN_API_TOKEN || 'dev-admin-token',
    staleHours: DEFAULT_STALE_HOURS,
    failOn: 'errors,disabled',
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') opts.url = argv[++i];
    else if (a === '--token') opts.token = argv[++i];
    else if (a === '--stale-hours') opts.staleHours = Number(argv[++i]);
    else if (a === '--fail-on') opts.failOn = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

const HELP = `Отчёт о состоянии авто-сбора (GET /api/admin/collect/status + /api/admin/watch-chats).

  node scripts/collect-report.mjs --url https://pop-utka.app --token $ADMIN_API_TOKEN
    --stale-hours N   порог «чат давно не проверяли» (по умолчанию 6)
    --fail-on список  за что возвращать код 1: errors,disabled,stale,token,quota,empty
    --json            отчёт в JSON

Без --token берётся ADMIN_API_TOKEN из окружения.`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }
  const { status, chats } = await fetchState(opts.url, opts.token);
  const summary = summarize(status, chats, opts);
  console.log(opts.json ? JSON.stringify(summary, null, 2) : formatReport(summary));
  return summary.ok ? 0 : 1;
}

const isCli = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isCli) {
  main().then(
    (code) => { process.exitCode = code; },
    (e) => { console.error('Не получилось снять отчёт:', String(e && e.message ? e.message : e)); process.exitCode = 2; },
  );
}
