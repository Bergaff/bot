import { aiQuotaLeft, aiQuotaUsed } from './ai.ts';
import {
  cascade,
  ingestMessage,
  type IngestOptions,
  type IngestResult,
} from './ingest.ts';
import { webChatId } from './links.ts';
import { parseMessageDate } from './ingest.ts';
import {
  diagnosePage,
  fetchPreview,
  normalizeUsername,
  sleep,
  TYPICAL_PAGE_SIZE,
  type FetchPreviewOptions,
  type PreviewPage,
} from './preview.ts';
import type { PreviewMessage } from './preview-html.ts';
import {
  dueWatchChats,
  getWatchChat,
  markWatchChecked,
  markWatchError,
  WATCH_MAX_ERRORS,
  type WatchChat,
} from './store.ts';
import { sendTextToAdmins } from './telegram.ts';
import type { Env } from './types.ts';

/**
 * Вариант A — серверный сборщик публичных чатов (ТЗ раздел 3).
 *
 * Cron раз в 1–2 часа читает веб-превью t.me/s/<username> (без логина),
 * берёт только сообщения НОВЕЕ курсора last_message_id и прогоняет каждое
 * через общий конвейер ingestMessage() → очередь модерации.
 *
 * Три принципа:
 *  1. Курсор — оптимизация, а не защита от дублей. Дубли отсекает tg_seen.
 *  2. Ротация: за один запуск обходим порцию чатов (COLLECT_MAX_CHATS) и
 *     строго считаем сетевые запросы — на бесплатном тарифе у воркера
 *     лимит ~50 подзапросов на вызов.
 *  3. Первый запуск по чату НЕ листает историю вглубь: иначе в очередь
 *     модерации выльется год старых сообщений.
 */

/** Итог обхода одного чата. */
export interface CollectChatResult {
  chatId: string;
  username: string;
  /** Сколько сообщений увидели на странице (страницах). */
  fetched: number;
  /** Сколько из них новее курсора и не старше COLLECT_MAX_AGE_DAYS. */
  new: number;
  /** Сколько заявок создали. */
  created: number;
  /** Сколько отсеяли (пассажирские, болтовня, старые, длинные). */
  skipped: number;
  /** Сколько уже было обработано раньше (штатный ответ, не ошибка). */
  duplicate: number;
  /** Битых сообщений (без id/текста) и невалидных результатов. */
  invalid: number;
  pages: number;
  cursorBefore: number | null;
  cursorAfter: number | null;
  /** ok | empty | missing | blocked | markup_changed | http_<code> | network_error | disabled. */
  status: string;
  error?: string;
  /** Чат выключен автоматически (404 или WATCH_MAX_ERRORS ошибок подряд). */
  disabled?: boolean;
  dryRun?: boolean;
}

/** Отчёт одного запуска cron / ручного прогона. */
export interface CollectReport {
  startedAt: string;
  finishedAt: string;
  enabled: boolean;
  dryRun: boolean;
  chats: CollectChatResult[];
  totals: {
    chats: number;
    fetched: number;
    new: number;
    created: number;
    skipped: number;
    duplicate: number;
    invalid: number;
    errors: number;
    disabled: number;
    fetches: number;
  };
  /** Остаток дневной квоты ИИ сборщика на момент окончания прогона. */
  aiQuotaLeft: number;
  config: CollectConfig;
}

export interface CollectOptions {
  /** Обойти только этот чат ('web:<username>' или просто username). */
  onlyChatId?: string;
  /** Только чтение и отчёт: без createListing, без курсора, без квоты ИИ. */
  dryRun?: boolean;
  /** Не смотреть на COLLECT_ENABLED (ручной запуск из админки). */
  force?: boolean;
  maxChats?: number;
  maxPages?: number;
  maxAgeDays?: number;
  maxFetches?: number;
  aiDailyLimit?: number;
  /** Отключить ИИ на весь прогон (например, квота уже выбрана). */
  useAi?: boolean;
  /** Инжект для тестов: fetch, уведомления, конвейер. */
  fetchImpl?: typeof fetch;
  notify?: (text: string) => Promise<void>;
  cascadeImpl?: IngestOptions['cascade'];
  /** Отключить паузы между запросами (в тестах не нужны). */
  delayMs?: number;
  baseUrl?: string;
  userAgent?: string;
  timeoutMs?: number;
  now?: Date;
}

export interface CollectConfig {
  enabled: boolean;
  maxChats: number;
  maxPages: number;
  maxAgeDays: number;
  maxFetches: number;
  aiDailyLimit: number;
  delayMs: number;
}

/** Значения по умолчанию — ровно как в таблице переменных ТЗ (п. 2.5). */
export const COLLECT_DEFAULTS = {
  maxChats: 10,
  maxPages: 2,
  maxAgeDays: 7,
  maxFetches: 24,
  aiDailyLimit: 100,
  delayMs: 300,
} as const;

function intOr(raw: string | undefined, fallback: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function collectConfig(env: Env, opts: CollectOptions = {}): CollectConfig {
  return {
    enabled: opts.force === true || env.COLLECT_ENABLED === '1',
    maxChats: opts.maxChats ?? intOr(env.COLLECT_MAX_CHATS, COLLECT_DEFAULTS.maxChats),
    maxPages: opts.maxPages ?? intOr(env.COLLECT_MAX_PAGES, COLLECT_DEFAULTS.maxPages),
    maxAgeDays: opts.maxAgeDays ?? intOr(env.COLLECT_MAX_AGE_DAYS, COLLECT_DEFAULTS.maxAgeDays),
    maxFetches: opts.maxFetches ?? intOr(env.COLLECT_MAX_FETCHES, COLLECT_DEFAULTS.maxFetches),
    aiDailyLimit: opts.aiDailyLimit ?? intOr(env.COLLECT_AI_DAILY_LIMIT, COLLECT_DEFAULTS.aiDailyLimit),
    delayMs: opts.delayMs ?? COLLECT_DEFAULTS.delayMs,
  };
}

/* ------------------------------------------------------------------ */
/* Логика курсора — чистые функции, тестируются без сети и БД           */
/* ------------------------------------------------------------------ */

/** Сообщения, которые стоит обработать: новее курсора и не старше maxAgeDays. */
export function selectNewMessages(
  messages: PreviewMessage[],
  opts: { cursor?: number | null; maxAgeDays?: number | null; now?: Date }
): PreviewMessage[] {
  const now = opts.now ?? new Date();
  const cursor = opts.cursor ?? null;
  const maxAgeMs = opts.maxAgeDays != null && opts.maxAgeDays > 0
    ? opts.maxAgeDays * 86400_000
    : null;
  return messages
    .filter((m) => Number.isInteger(m.messageId) && m.messageId > 0)
    .filter((m) => (cursor == null ? true : m.messageId > cursor))
    .filter((m) => {
      if (maxAgeMs == null) return true;
      const date = parseMessageDate(m.date);
      if (!date) return true; // дату не разобрать — возраст проверит конвейер
      return now.getTime() - date.getTime() <= maxAgeMs;
    })
    .sort((a, b) => a.messageId - b.messageId); // обрабатываем по возрастанию id
}

export interface CollectPlan {
  /** Что обрабатываем с этой страницы (по возрастанию id). */
  toProcess: PreviewMessage[];
  /** Новый курсор (максимум из обработанных) — null, если двигаться некуда. */
  cursor: number | null;
  /** Нужно ли запросить следующую страницу ?before=. */
  fetchNext: boolean;
  /** Значение before для следующей страницы. */
  nextBefore: number | null;
  /** Первый запуск по чату: историю вглубь не листаем. */
  firstRun: boolean;
}

/**
 * План на одну страницу превью (ТЗ п. 3.4.b–f).
 *
 * Первый запуск (курсора нет): берём ТОЛЬКО первую страницу и ставим курсор
 * на максимум — иначе при включении чата в очередь выльется вся история.
 * Дальнейшие запуски: листаем вглубь, пока страница полна и всё на ней новое,
 * но не больше COLLECT_MAX_PAGES страниц.
 */
export function planCollectPage(
  messages: PreviewMessage[],
  opts: {
    cursor?: number | null;
    maxAgeDays?: number | null;
    now?: Date;
    firstRun?: boolean;
    page?: number;
    maxPages?: number;
    pageSize?: number;
  }
): CollectPlan {
  const firstRun = opts.firstRun ?? opts.cursor == null;
  const page = Math.max(1, opts.page ?? 1);
  const maxPages = Math.max(1, opts.maxPages ?? COLLECT_DEFAULTS.maxPages);
  const pageSize = Math.max(1, opts.pageSize ?? TYPICAL_PAGE_SIZE);
  const fresh = selectNewMessages(messages, {
    cursor: opts.cursor,
    maxAgeDays: opts.maxAgeDays,
    now: opts.now,
  });

  const maxId = messages.length
    ? messages.reduce((max, m) => (m.messageId > max ? m.messageId : max), messages[0]!.messageId)
    : null;
  const minId = messages.length
    ? messages.reduce((min, m) => (m.messageId < min ? m.messageId : min), messages[0]!.messageId)
    : null;

  // Страница «полна» — значит, за ней есть ещё история
  const pageFull = messages.length >= pageSize;

  if (firstRun) {
    // курсор на максимум: всё, что лежит на этой странице, считаем уже увиденным,
    // но в обработку берём только то, что прошло отсев по возрасту
    return {
      toProcess: fresh,
      cursor: maxId,
      fetchNext: false,
      nextBefore: null,
      firstRun: true,
    };
  }

  const allNew = messages.length > 0 && fresh.length === messages.length;
  return {
    toProcess: fresh,
    cursor: maxId,
    fetchNext: allNew && pageFull && page < maxPages && minId != null,
    nextBefore: minId,
    firstRun: false,
  };
}

/* ------------------------------------------------------------------ */
/* Прогон                                                               */
/* ------------------------------------------------------------------ */

interface RunState {
  fetches: number;
  maxFetches: number;
  pages: number;
  cfg: CollectConfig;
  opts: CollectOptions;
  env: Env;
  useAi: boolean;
  quotaLeft: number;
  now: Date;
}

async function fetchPage(state: RunState, username: string, before: number | null): Promise<PreviewPage> {
  state.fetches++;
  const fetchOpts: FetchPreviewOptions = {
    before,
    fetchImpl: state.opts.fetchImpl,
    baseUrl: state.opts.baseUrl,
    userAgent: state.opts.userAgent,
    timeoutMs: state.opts.timeoutMs,
  };
  return fetchPreview(username, fetchOpts);
}

/** Обойти один чат: страницы → курсор → ingestMessage на каждое сообщение. */
async function collectOneChat(state: RunState, chat: WatchChat): Promise<CollectChatResult> {
  const { env, cfg, opts } = state;
  const username = chat.username;
  const chatId = chat.id || webChatId(username);
  const result: CollectChatResult = {
    chatId,
    username,
    fetched: 0,
    new: 0,
    created: 0,
    skipped: 0,
    duplicate: 0,
    invalid: 0,
    pages: 0,
    cursorBefore: chat.lastMessageId,
    cursorAfter: chat.lastMessageId,
    status: 'ok',
    dryRun: opts.dryRun === true,
  };

  const fail = async (status: string, error: string, disableNow = false): Promise<CollectChatResult> => {
    result.status = status;
    result.error = error;
    if (opts.dryRun) return result; // в dryRun базу не трогаем вообще
    const { errorCount, disabled } = await markWatchError(env, chatId, error, { disableNow });
    // disabled пишем только когда чат действительно выключен: в отчёте видно
    // «обычная ошибка» vs «чат остановлен»
    if (disabled) result.disabled = true;
    if (disabled) {
      const text = `Сборщик остановлен по чату ${username}: ${error}. Проверьте разметку t.me/s/.`;
      await (opts.notify ?? ((t: string) => sendTextToAdmins(env, t).then(() => undefined)))(text)
        .catch((e) => console.error('collect: notify failed', e));
      result.error = `${error} (ошибок подряд: ${errorCount}, чат выключен)`;
    }
    return result;
  };

  if (!chat.enabled && opts.onlyChatId === undefined) {
    result.status = 'disabled';
    return result;
  }

  const processedIds = new Set<number>();
  let cursor = chat.lastMessageId;
  let before: number | null = null;
  let firstRun = cursor == null;
  let title = chat.title;

  for (let page = 1; page <= Math.max(1, cfg.maxPages); page++) {
    if (state.fetches >= state.maxFetches) {
      result.status = page === 1 ? 'budget_exceeded' : result.status;
      break;
    }
    const preview = await fetchPage(state, username, before);
    result.pages = page;

    if (preview.status === 0) return fail('network_error', 'fetch failed (timeout/network)');
    if (preview.status === 404) return fail('missing', 'chat not found (404)', true);
    if (preview.status === 429) return fail('blocked', 'http_429: слишком частые запросы к t.me');
    if (preview.status !== 200) return fail(`http_${preview.status}`, `t.me ответил ${preview.status}`);

    const diagnosis = diagnosePage(preview);
    if (diagnosis === 'missing') return fail('missing', 'чат удалён/переименован или превью недоступно', true);
    if (diagnosis === 'blocked') return fail('blocked', 'капча/бан-стена вместо страницы превью');
    if (diagnosis === 'markup_changed') {
      return fail('markup_changed', 'markup_changed? (страница 200, но контейнеров сообщений нет)');
    }

    result.fetched += preview.messages.length;
    if (preview.title) title = preview.title;

    const plan = planCollectPage(preview.messages, {
      cursor,
      maxAgeDays: cfg.maxAgeDays,
      now: state.now,
      firstRun,
      page,
      maxPages: cfg.maxPages,
      pageSize: Math.max(preview.messages.length, TYPICAL_PAGE_SIZE),
    });
    result.new += plan.toProcess.length;
    if (plan.cursor != null) cursor = plan.cursor;

    // сообщения — по возрастанию id (planCollectPage уже отсортировал)
    for (const message of plan.toProcess) {
      if (processedIds.has(message.messageId)) continue;
      processedIds.add(message.messageId);

      // квота ИИ сборщика своя (ai:collect:day:*): бюджет бота не трогаем
      const messageUseAi = state.useAi && (opts.dryRun === true || state.quotaLeft > 0);
      let res: IngestResult;
      try {
        res = await ingestMessage(
          env,
          message.text,
          {
            chatId,
            chatTitle: title ?? username,
            messageId: message.messageId,
            chatUrl: `https://t.me/${username}`,
            authorName: message.author,
            origin: 'collector',
          },
          {
            maxAgeDays: cfg.maxAgeDays,
            date: message.date,
            useAi: messageUseAi,
            dryRun: opts.dryRun === true,
            aiScope: 'collect',
            cascade: opts.cascadeImpl ?? cascade,
            now: state.now,
          }
        );
      } catch (e) {
        result.invalid++;
        console.error('collect: ingest failed', username, message.messageId, e);
        continue;
      }

      if (res.status === 'created') {
        result.created += res.listings.length || (opts.dryRun ? (res.fields?.length ?? 0) : 0);
        if (messageUseAi && opts.dryRun !== true) state.quotaLeft = Math.max(0, state.quotaLeft - 1);
      } else if (res.status === 'duplicate') result.duplicate++;
      else if (res.status === 'invalid') result.invalid++;
      else result.skipped++;
    }

    firstRun = false;
    if (!plan.fetchNext || state.fetches >= state.maxFetches) break;
    before = plan.nextBefore;
    if (cfg.delayMs > 0) await sleep(cfg.delayMs);
  }

  result.cursorAfter = cursor;
  if (result.fetched === 0) {
    result.status = 'empty';
    // сообщений нет, но и ошибок страницы нет: курсор не двигаем
    if (!opts.dryRun) {
      await markWatchChecked(env, chatId, { found: 0, created: 0, skipped: 0, duplicate: 0, title });
    }
    return result;
  }
  result.status = 'ok';
  if (!opts.dryRun) {
    await markWatchChecked(env, chatId, {
      lastMessageId: cursor,
      found: result.fetched,
      created: result.created,
      skipped: result.skipped,
      duplicate: result.duplicate,
      title,
    });
  }
  return result;
}

/**
 * Обойти публичные чаты из watch_chats.
 * Запускается из scheduled() (ветка COLLECT_CRON) и вручную — POST /api/admin/collect.
 */
export async function collectPublicChats(env: Env, opts: CollectOptions = {}): Promise<CollectReport> {
  const cfg = collectConfig(env, opts);
  const startedAt = new Date().toISOString();
  const now = opts.now ?? new Date();
  const emptyReport = (chats: CollectChatResult[], enabled: boolean): CollectReport => ({
    startedAt,
    finishedAt: new Date().toISOString(),
    enabled,
    dryRun: opts.dryRun === true,
    chats,
    totals: chats.reduce(
      (acc, c) => ({
        chats: acc.chats + 1,
        fetched: acc.fetched + c.fetched,
        new: acc.new + c.new,
        created: acc.created + c.created,
        skipped: acc.skipped + c.skipped,
        duplicate: acc.duplicate + c.duplicate,
        invalid: acc.invalid + c.invalid,
        errors: acc.errors + (c.status === 'ok' ? 0 : 1),
        disabled: acc.disabled + (c.disabled ? 1 : 0),
        fetches: acc.fetches + c.pages,
      }),
      { chats: 0, fetched: 0, new: 0, created: 0, skipped: 0, duplicate: 0, invalid: 0, errors: 0, disabled: 0, fetches: 0 }
    ),
    aiQuotaLeft: 0,
    config: cfg,
  });

  // 1. Выключено — выходим (ручной запуск из админки идёт с force: true)
  if (!cfg.enabled) {
    console.log('collect: COLLECT_ENABLED != 1, пропуск');
    const report = emptyReport([], false);
    report.aiQuotaLeft = await aiQuotaLeft(env, 'collect').catch(() => 0);
    await saveReport(env, report);
    return report;
  }

  // 2. Дневная квота ИИ сборщика: exceeded → собираем только правилами
  const quotaLeft = opts.useAi === false ? 0 : await aiQuotaLeft(env, 'collect').catch(() => cfg.aiDailyLimit);
  const useAi = opts.useAi !== false && quotaLeft > 0;
  if (!useAi && opts.useAi !== false) {
    console.log(`collect: дневная квота ИИ сборщика исчерпана (${cfg.aiDailyLimit}/день) — работаем только правилами`);
  }

  // 3. Какие чаты обходим: порция, давно не проверенные первыми (ротация)
  let chats: WatchChat[] = [];
  if (opts.onlyChatId) {
    const id = opts.onlyChatId.startsWith('web:') ? opts.onlyChatId : webChatId(opts.onlyChatId);
    const one = await getWatchChat(env, id);
    chats = one ? [one] : [];
  } else {
    chats = await dueWatchChats(env, cfg.maxChats);
  }

  const state: RunState = {
    fetches: 0,
    // жёсткий потолок сетевых запросов на весь прогон (лимит подзапросов воркера)
    maxFetches: Math.max(1, Math.min(cfg.maxFetches, opts.maxFetches ?? cfg.maxFetches)),
    pages: 0,
    cfg,
    opts,
    env,
    useAi,
    quotaLeft,
    now,
  };

  const results: CollectChatResult[] = [];
  for (const chat of chats) {
    // 5. Пауза между чатами: не долбим t.me подряд
    if (results.length > 0 && cfg.delayMs > 0) await sleep(cfg.delayMs);
    if (state.fetches >= state.maxFetches) {
      results.push({
        chatId: chat.id,
        username: chat.username,
        fetched: 0, new: 0, created: 0, skipped: 0, duplicate: 0, invalid: 0, pages: 0,
        cursorBefore: chat.lastMessageId,
        cursorAfter: chat.lastMessageId,
        status: 'budget_exceeded',
        error: 'исчерпан лимит запросов на этот прогон',
      });
      continue;
    }
    try {
      results.push(await collectOneChat(state, chat));
    } catch (e) {
      // ошибка одного чата не должна ронять весь прогон
      console.error('collect: chat failed', chat.id, e);
      results.push({
        chatId: chat.id,
        username: chat.username,
        fetched: 0, new: 0, created: 0, skipped: 0, duplicate: 0, invalid: 0, pages: 0,
        cursorBefore: chat.lastMessageId,
        cursorAfter: chat.lastMessageId,
        status: 'error',
        error: String(e),
      });
    }
  }

  // 6. Отчёт — в лог и в KV (админка показывает его по GET /api/admin/collect/status)
  const report = emptyReport(results, true);
  report.aiQuotaLeft = await aiQuotaLeft(env, 'collect').catch(() => state.quotaLeft);
  report.finishedAt = new Date().toISOString();
  console.log('collect:', JSON.stringify(report.totals));
  await saveReport(env, report);
  return report;
}

/** Ключ KV с последним отчётом прогона (TTL 7 дней). */
export const COLLECT_REPORT_KEY = 'collect:last-report';

async function saveReport(env: Env, report: CollectReport): Promise<void> {
  try {
    await env.KV.put(COLLECT_REPORT_KEY, JSON.stringify(report), { expirationTtl: 7 * 86400 });
  } catch (e) {
    console.error('collect: save report failed', e);
  }
}

/** Последний отчёт прогона из KV (+ сколько ИИ-вызовов потрачено сегодня). */
export async function lastCollectReport(env: Env): Promise<{
  report: CollectReport | null;
  aiUsedToday: number;
  errorCount: number;
}> {
  let report: CollectReport | null = null;
  try {
    const raw = await env.KV.get(COLLECT_REPORT_KEY);
    if (raw) report = JSON.parse(String(raw)) as CollectReport;
  } catch {
    report = null;
  }
  const [aiUsedToday, disabled] = await Promise.all([
    aiQuotaUsed(env, 'collect').catch(() => 0),
    countProblemChats(env),
  ]);
  return { report, aiUsedToday, errorCount: disabled };
}

/** Сколько чатов сейчас с ошибками/выключено — для статуса в админке. */
export async function countProblemChats(env: Env): Promise<number> {
  try {
    const row = (await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM watch_chats WHERE error_count > 0 OR enabled = 0'
    ).first()) as { n?: number } | null;
    return Number(row?.n ?? 0);
  } catch {
    return 0; // таблицы watch_chats ещё нет (миграция 0004 не применена)
  }
}

/** Сколько ИИ-вызовов сборщик может сделать до конца суток. */
export async function collectAiBudget(env: Env): Promise<number> {
  return aiQuotaLeft(env, 'collect');
}

/** Прожать юзернейм к каноническому виду (для админ-API). */
export { normalizeUsername };
export { WATCH_MAX_ERRORS };
