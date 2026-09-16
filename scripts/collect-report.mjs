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

/** Дата из ответа сервера: sqlite пишет «YYYY-MM-DD HH:MM:SS», API может отдать ISO. */
function toDate(raw) {
  if (!raw) return null;
  const text = String(raw);
  const d = new Date(text.includes('T') ? text : text.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Сколько часов назад (или null, если дата не разобрана). */
function ageHours(raw, now) {
  const d = toDate(raw);
  return d ? (now.getTime() - d.getTime()) / 3600000 : null;
}

/** «12 мин», «3 ч», «2 дн» — для строк отчёта. */
function fmtAge(hours) {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} мин`;
  if (hours < 48) return `${Math.round(hours)} ч`;
  return `${Math.round(hours / 24)} дн`;
}

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
  const reportAge = report ? (ageHours(report.finishedAt, now) ?? ageHours(report.startedAt, now)) : null;
  lines.push(report
    ? `последний прогон: ${report.startedAt}${report.dryRun ? ' (dry run)' : ''}` +
      (reportAge !== null ? ` — ${fmtAge(reportAge)} назад` : '')
    : 'последний прогон: ещё не запускался');
  if (totals) {
    lines.push(`итоги прогона: чатов ${totals.chats}, найдено ${totals.fetched}, новых ${totals.new}, ` +
      `заявок ${totals.created}, дублей ${totals.duplicate}, отсеяно ${totals.skipped}, ошибок ${totals.errors}`);
  }

  /* Если ответа сервера нет вовсе (status пуст), выдумывать проблемы не нужно:
     про нули квот и отсутствие токена мы ничего не знаем. */
  if (status && typeof status === 'object') {
    if (!s.ingestTokenSet) problems.push({ kind: 'token', text: 'INGEST_TOKEN не задан: расширение получает 503, приём выключен' });
    if ((ai.collectLeft ?? 0) <= 0) warnings.push({ kind: 'quota', text: `Дневная квота ИИ сборщика выбрана (${ai.collectUsedToday ?? 0}/${ai.collectLimit ?? 0}) — разбираем только правилами` });
    if ((ai.ingestLeft ?? 0) <= 0) warnings.push({ kind: 'quota', text: 'Дневная квота ИИ расширения выбрана — расширение разбирает только правилами' });
  }

  /* По чатам */
  let checkedRecently = false;
  for (const c of list) {
    const checked = ageHours(c.lastCheckedAt, now);
    if (c.enabled && checked !== null && checked <= staleHours) checkedRecently = true;
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
    if (c.enabled && checked !== null && checked > staleHours) {
      problems.push({ kind: 'stale', text: `${c.username}: не проверяли ${Math.round(checked)} ч (порог ${staleHours} ч) — cron не запускается?` });
      flags.push(`не проверяли ${Math.round(checked)} ч`);
    }
    if (c.enabled && checked === null) flags.push('ещё не проверялся');

    lines.push(`  ${c.username} [${c.kind}] ${c.enabled ? 'вкл' : 'выкл'} · курсор ${c.lastMessageId ?? '—'} · ` +
      `найдено ${c.statsFound ?? 0} / заявок ${c.statsCreated ?? 0} / отсеяно ${c.statsSkipped ?? 0}` +
      (flags.length ? ` · ${flags.join(', ')}` : ''));
  }

  if (totals && totals.chats > 0 && totals.created === 0 && totals.duplicate === 0) {
    warnings.push({ kind: 'empty', text: `Прогон прошёл по ${totals.chats} чатам, но не создал ни одной заявки (найдено ${totals.fetched}, отсеяно ${totals.skipped})` });
  }

  /* Ошибки последнего прогона: состояние чатов могли уже сбросить, а прогон — нет.
     Проблемой это не делаем (иначе чиненный чат «фонил» бы до следующего обхода). */
  if (totals && ((totals.errors ?? 0) > 0 || (totals.disabled ?? 0) > 0)) {
    warnings.push({
      kind: 'errors',
      text: `В последнем прогоне ошибок: ${totals.errors ?? 0}, авто-отключений: ${totals.disabled ?? 0}` +
        ((totals.disabled ?? 0) > 0 ? ' — выключенные чаты нужно включить обратно после починки' : ''),
    });
  }

  /* Обход включён, а прогона давно не было (или не было вовсе) и ни один чат не проверен —
     типичный признак мертвого cron. Отдельные «stale» по чатам уже могли об этом сказать. */
  const perChatStale = problems.some((pr) => pr.kind === 'stale');
  const hasEnabled = list.some((c) => c.enabled);
  if (s.enabled && hasEnabled && !perChatStale && !checkedRecently && (reportAge === null || reportAge > staleHours)) {
    problems.push({
      kind: 'stale',
      text: reportAge === null
        ? `cron-сборщик включён, но прогона ещё не было, а ${list.length} ${plural(list.length, 'чат', 'чата', 'чатов')} в обходе ни разу не проверено`
        : `cron-сборщик включён, но прогона не было ${fmtAge(reportAge)} (порог ${staleHours} ч) и ни один чат не проверен — cron не запускается?`,
    });
  }

  /* Чатов нет вовсе — авто-сбор фактически не работает. */
  if (status && typeof status === 'object' && (wc.total ?? 0) === 0) {
    warnings.push({ kind: 'empty', text: 'В обходе нет ни одного чата: добавьте через админку или POST /api/admin/watch-chats' });
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
  const chatsWord = `${summary.chats} ${plural(summary.chats, 'чат', 'чата', 'чатов')} в обходе`;
  if (!summary.ok) {
    out.push(`Нужно вмешательство: ${summary.failing.length} ${plural(summary.failing.length, 'проблема', 'проблемы', 'проблем')} ` +
      `из списка --fail-on ${summary.failOn.join(',')}.`);
  } else if (summary.problems.length || summary.warnings.length) {
    // код возврата 0, но смотреть на отчёт нужно: проблемы вне --fail-on и/или предупреждения
    const parts = [];
    if (summary.problems.length) parts.push(`проблем вне --fail-on: ${summary.problems.length}`);
    if (summary.warnings.length) parts.push(`предупреждений: ${summary.warnings.length}`);
    out.push(`Сбор работает (${chatsWord}), но ${parts.join(', ')} — смотрите списки выше.`);
  } else {
    out.push(`Всё в порядке (${chatsWord}).`);
  }
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
