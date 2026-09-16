#!/usr/bin/env node
/**
 * Разведка публичных чатов ПЕРЕД добавлением в обход (ТЗ п. 3.7, этап 7).
 *
 * Зачем: сборщик умеет читать только те чаты, у которых открывается веб-превью
 * t.me/s/<username>. Половина кандидатов отваливается ещё до старта — приватные,
 * удалённые, под капчей, «мёртвые» (последнее сообщение год назад) или вообще
 * про пассажирские попутки. Этот скрипт проверяет чат за один запрос и говорит,
 * стоит ли его добавлять и с каким типом (канал / супергруппа).
 *
 * Запуск:
 *   node scripts/probe-chats.mjs durov drivers_pl_by posylki_pl_by
 *   node scripts/probe-chats.mjs --file chats.txt --delay 2000
 *   node scripts/probe-chats.mjs durov --deep            # проверить и пагинацию ?before=
 *   node scripts/probe-chats.mjs durov --base-url http://127.0.0.1:8899/s   # локальное зеркало
 *   node scripts/probe-chats.mjs durov --json
 *
 * Код возврата: 0 — все чаты пригодны, 1 — есть непригодные (удобно в CI/cron).
 * Скрипт только ЧИТАЕТ t.me: ничего не публикует и не требует токенов.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { fetchPreview, diagnosePage, normalizeUsername } from '../src/preview.ts';
import { looksLikeListing, isPassengerOnly, worthAiCheck, parseTelegramMessage } from '../src/parser.ts';

/** «3 объявления», «21 объявление», «5 объявлений». */
function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/** Сколько дней без сообщений считаем «чат мёртвый». */
const STALE_DAYS = 30;
/** Доля сообщений с автором, выше которой это супергруппа, а не канал. */
const SUPERGROUP_AUTHOR_SHARE = 0.3;

/**
 * Проверить один чат.
 *
 * @param {string} raw юзернейм, @username или ссылка t.me/…
 * @param {object} opts { baseUrl, fetchImpl, timeoutMs, deep, delayMs, now }
 * @returns {Promise<object>} разбор: вердикт, тип, свежесть, ожидаемый выход заявок
 */
export async function probeChat(raw, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const username = normalizeUsername(raw);
  const result = {
    input: String(raw ?? ''),
    username,
    url: username ? `https://t.me/s/${username}` : null,
    status: 0,
    verdict: 'bad_username',
    title: null,
    kind: null,
    kindHint: null,
    messages: 0,
    maxId: null,
    nextBefore: null,
    newestDate: null,
    newestAgeDays: null,
    withAuthors: 0,
    authorShare: 0,
    listings: 0,
    passenger: 0,
    worthAi: 0,
    chatter: 0,
    pagination: null,
    recommendation: 'не добавлять',
    notes: [],
  };

  if (!username) {
    result.notes.push('Не похоже на публичный юзернейм Telegram (5–32 знака, латиница, начинается с буквы).');
    return result;
  }

  const page = await fetchPreview(username, {
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });

  result.status = page.status;
  result.verdict = page.status === 0 ? 'network' : diagnosePage(page);
  result.title = page.title;
  result.messages = page.messages.length;
  result.maxId = page.maxId;
  result.nextBefore = page.nextBefore;

  if (page.messages.length > 0) {
    const dates = page.messages.map((m) => m.date).filter(Boolean).map((d) => Date.parse(d)).filter(Number.isFinite);
    const newest = dates.length ? Math.max(...dates) : null;
    result.newestDate = newest ? new Date(newest).toISOString() : null;
    result.newestAgeDays = newest ? Math.round((now.getTime() - newest) / 86400000) : null;
    result.withAuthors = page.messages.filter((m) => m.author || m.forwardedFrom).length;
    result.authorShare = Math.round((result.withAuthors / page.messages.length) * 100) / 100;
    result.kindHint = result.authorShare >= SUPERGROUP_AUTHOR_SHARE ? 'supergroup' : 'channel';

    for (const m of page.messages) {
      const text = m.text || '';
      if (isPassengerOnly(text)) result.passenger++;
      else if (looksLikeListing(text, now)) result.listings++;
      else if (worthAiCheck(text)) result.worthAi++;
      else result.chatter++;
    }
  }

  /* Пагинация вглубь истории: нужна, чтобы добрать хвост при первом прогоне. */
  if (opts.deep && page.nextBefore !== null) {
    const deeper = await fetchPreview(username, {
      before: page.nextBefore,
      baseUrl: opts.baseUrl,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
    });
    result.pagination = {
      before: page.nextBefore,
      status: deeper.status,
      messages: deeper.messages.length,
      verdict: deeper.status === 0 ? 'network' : diagnosePage(deeper),
    };
  }

  Object.assign(result, recommend(result));
  return result;
}

/** Вывод по результатам разведки: добавлять или нет, и почему. */
export function recommend(r) {
  const notes = [];

  if (r.verdict === 'bad_username') {
    return { kind: null, recommendation: 'не добавлять', notes };
  }
  if (r.verdict === 'network') {
    notes.push('До t.me не достучаться (таймаут/DNS/блокировка). Проверьте сеть или прокси и повторите.');
    return { kind: null, recommendation: 'проверить вручную', notes };
  }
  if (r.verdict === 'missing') {
    notes.push('Превью не открылось: чат приватный, удалён или переименован. Сборщик такое не читает.');
    return { kind: null, recommendation: 'не добавлять', notes };
  }
  if (r.verdict === 'blocked') {
    notes.push('Telegram отдал капчу/бан-стену. Часто лечится паузой и сменой User-Agent, но в обход такой чат брать рано.');
    return { kind: null, recommendation: 'проверить вручную', notes };
  }
  if (r.verdict === 'markup_changed') {
    notes.push('Страница открылась, но знакомых контейнеров сообщений нет: Telegram поменял разметку. Нужна правка src/preview-html.ts.');
    return { kind: null, recommendation: 'не добавлять', notes };
  }
  if (r.verdict.startsWith('http_')) {
    notes.push(`Ответ ${r.verdict.slice(5)} от t.me.`);
    return { kind: null, recommendation: 'не добавлять', notes };
  }
  if (r.verdict === 'empty') {
    notes.push('Страница пустая: в чате нет видимых сообщений (или они скрыты настройками канала).');
    return { kind: null, recommendation: 'не добавлять', notes };
  }

  /* verdict === 'ok' */
  const kind = r.kindHint || 'channel';
  if (r.newestAgeDays !== null && r.newestAgeDays > STALE_DAYS) {
    notes.push(`Чат мёртвый: последнее сообщение ${r.newestAgeDays} дн. назад (порог ${STALE_DAYS} дн.).`);
    return { kind, recommendation: 'не добавлять', notes };
  }
  if (r.listings === 0 && r.passenger > 0 && r.worthAi === 0) {
    notes.push(`Похоже на пассажирские попутки (${r.passenger} из ${r.messages}). Доска такое не публикует: isPassengerOnly отсечёт всё.`);
    return { kind, recommendation: 'не добавлять', notes };
  }
  if (r.listings === 0 && r.worthAi === 0) {
    notes.push(`Объявлений на последней странице нет (${r.chatter} из ${r.messages} — болтовня).`);
    return { kind, recommendation: 'проверить вручную', notes };
  }

  notes.push(`С последней страницы: ${r.listings} ${plural(r.listings, 'объявление', 'объявления', 'объявлений')} правилами` +
    (r.worthAi ? `, ${r.worthAi} уйдёт в ИИ` : '') +
    (r.passenger ? `, ${r.passenger} пассажирских (отсеятся)` : '') +
    (r.chatter ? `, ${r.chatter} болтовни (отсеется)` : '') + '.');
  notes.push(`Авторов видно в ${Math.round(r.authorShare * 100)}% сообщений → тип «${kind === 'supergroup' ? 'супергруппа' : 'канал'}».`);
  if (r.newestAgeDays !== null) notes.push(`Свежесть: последнее сообщение ${r.newestAgeDays} дн. назад.`);
  if (r.pagination) {
    notes.push(r.pagination.verdict === 'ok'
      ? `Пагинация ?before=${r.pagination.before} работает: ещё ${r.pagination.messages} ${plural(r.pagination.messages, 'сообщение', 'сообщения', 'сообщений')}.`
      : `Пагинация ?before=${r.pagination.before} вернула ${r.pagination.verdict}.`);
  }

  const recommendation = r.listings > 0 || r.worthAi > 0 ? 'добавлять' : 'проверить вручную';
  if (recommendation === 'добавлять' && r.listings === 0) {
    notes.push('Правила не нашли ни одного объявления — весь выход пойдёт через ИИ. Проверьте дневную квоту COLLECT_AI_DAILY_LIMIT.');
  }
  return { kind, recommendation, notes };
}

/** Прогнать список чатов с паузой между запросами (не долбим t.me). */
export async function probeChats(list, opts = {}) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (i > 0 && opts.delayMs !== 0) await new Promise((r) => setTimeout(r, opts.delayMs ?? 1500));
    out.push(await probeChat(list[i], opts));
  }
  return out;
}

/** Человекочитаемый отчёт. */
export function formatProbeReport(results) {
  const lines = [];
  for (const r of results) {
    lines.push('');
    lines.push(`${r.username ?? r.input} — ${r.recommendation.toUpperCase()}`);
    lines.push(`  превью: ${r.url ?? '—'} → ${r.verdict}${r.status ? ` (http ${r.status})` : ''}`);
    if (r.title) lines.push(`  название: ${r.title}`);
    if (r.messages) {
      lines.push(`  сообщений на странице: ${r.messages}, id до ${r.maxId}` +
        (r.newestDate ? `, последнее ${r.newestDate.slice(0, 10)} (${r.newestAgeDays} дн. назад)` : ''));
    }
    for (const n of r.notes) lines.push(`  · ${n}`);
    if (r.recommendation === 'добавлять') {
      lines.push(`  добавить: curl -X POST $URL/api/admin/watch-chats -H "Authorization: Bearer $ADMIN_API_TOKEN" \\`);
      lines.push(`            -H 'Content-Type: application/json' -d '{"username":"${r.username}","kind":"${r.kind}"}'`);
    }
  }
  const ok = results.filter((r) => r.recommendation === 'добавлять').length;
  lines.push('');
  lines.push(`Итог: ${ok} из ${results.length} можно добавлять в обход.`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = { usernames: [], file: null, baseUrl: undefined, delayMs: 1500, deep: false, json: false, timeoutMs: 15000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') opts.file = argv[++i];
    else if (a === '--base-url') opts.baseUrl = argv[++i];
    else if (a === '--delay') opts.delayMs = Number(argv[++i]);
    else if (a === '--timeout') opts.timeoutMs = Number(argv[++i]);
    else if (a === '--deep') opts.deep = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!a.startsWith('--')) opts.usernames.push(a);
  }
  return opts;
}

const HELP = `Разведка публичных чатов перед добавлением в авто-сбор.

  node scripts/probe-chats.mjs <username|t.me/ссылка> [...]
    --file <path>      список юзернеймов по одному в строке (# — комментарий)
    --base-url <url>   зеркало превью вместо https://t.me/s (локальная обкатка)
    --deep             дополнительно проверить пагинацию ?before=
    --delay <ms>       пауза между чатами (по умолчанию 1500)
    --timeout <ms>     таймаут запроса (по умолчанию 15000)
    --json             отчёт в JSON (для скриптов)

Код возврата 1 — хотя бы один чат не пригоден для обхода.`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }

  const list = [...opts.usernames];
  if (opts.file) {
    const text = readFileSync(resolve(opts.file), 'utf8');
    for (const line of text.split('\n')) {
      const v = line.replace(/#.*$/, '').trim();
      if (v) list.push(v);
    }
  }
  if (list.length === 0) { console.log(HELP); return 0; }

  const results = await probeChats(list, opts);
  if (opts.json) console.log(JSON.stringify(results, null, 2));
  else console.log(formatProbeReport(results));

  return results.every((r) => r.recommendation === 'добавлять') ? 0 : 1;
}

const isCli = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isCli) {
  main().then(
    (code) => { process.exitCode = code; },
    (e) => { console.error('Ошибка разведки:', String(e && e.message ? e.message : e)); process.exitCode = 2; },
  );
}
