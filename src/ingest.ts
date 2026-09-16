import type { AiQuotaScope } from './ai.ts';
import { aiExtractListing, aiQuotaAvailable, type AiFields } from './ai.ts';
import { chatUrlOf, usernameOfChatId } from './links.ts';
import { isMultiRoute, isPassengerOnly, parseTelegramMessage, worthAiCheck } from './parser.ts';
import {
  createListing,
  findDuplicate,
  getSeenListing,
  markSeen,
  setSeenListing,
  touchListing,
  unmarkSeen,
  upsertChatLink,
} from './store.ts';
import { notifyAdmins as defaultNotifyAdmins } from './telegram.ts';
import type { DuplicateHit } from './dedupe.ts';
import type { Env, Listing, ListingInput, ListingOrigin, ListingSource, ParsedMessage } from './types.ts';
import { dedupeDescription, normalizeContacts } from './util.ts';

/**
 * Общий конвейер разбора (ТЗ п. 2.1).
 *
 * Один и тот же путь проходят все три источника объявлений:
 *   bot       — бот в чате / пересылка боту (было раньше, теперь через ingestMessage);
 *   collector — серверный cron-обход публичных чатов t.me/s/<username> (вариант A);
 *   extension — браузерное расширение, POST /api/ingest (вариант B).
 *
 * Порядок операций внутри ingestMessage() фиксирован ТЗ:
 *   1. длина текста → 2. возраст → 3. пассажирское → 4. markSeen (защита от дублей,
 *   ДО любых вызовов ИИ) → 5. cascade (правила → ИИ) → 6. дубль по смыслу
 *   (src/dedupe.ts: та же заявка другим сообщением → не создаём, освежаем) →
 *   6.1 createListing (всегда pending) → 7. notifyAdmins → 8. откат tg_seen при
 *   ошибке создания.
 *
 * Правила разбора и ИИ не переписываются: cascade() здесь — дословный перенос
 * приватной cascade() из src/telegram.ts проекта Bergaff/parcel.
 */

/** Текст длиннее этого не обрабатываем (как в боте). */
export const MAX_TEXT_LENGTH = 4000;

/** Короткие сообщения («ок», «+», «спасибо») разбору не интересны. */
export const MIN_TEXT_LENGTH = 10;

/** Откуда пришло сообщение — ключ дедупликации и подписи источника. */
export interface IngestSource {
  /** Ключ чата для tg_seen и source_chat_id: '-100…' | 'web:<username>' | 'ext:<id>'. */
  chatId: string;
  chatTitle: string | null;
  messageId: number | null;
  /** Публичная ссылка на чат (t.me/<username>) — сохранится в chat_links. */
  chatUrl?: string | null;
  authorName?: string | null;
  authorUsername?: string | null;
  origin: ListingOrigin;
}

/** Почему сообщение не стало заявкой. */
export type IngestReason =
  | 'passenger'
  | 'no_intent'
  | 'ai_empty'
  | 'too_old'
  | 'too_long'
  | 'too_short'
  | 'no_date'
  | 'bad_payload';

export interface IngestResult {
  status: 'created' | 'duplicate' | 'skipped' | 'invalid';
  reason?: IngestReason;
  /** Созданные заявки (0..3). В dryRun — пустые, поля разбора лежат в fields. */
  listings: Listing[];
  /** Для duplicate: какая заявка уже была создана по этому сообщению. */
  existingListingId?: string | null;
  /** Дубль по смыслу (src/dedupe.ts): ids заявок, которые уже были на доске/в очереди. */
  duplicateOf?: string[];
  /** Почему решено, что это дубль — для логов и диагностики. */
  duplicateWhy?: string;
  /** Похожая, но не та же заявка: создана, модератору стоит взглянуть (kind='similar'). */
  similarTo?: { id: string; why: string } | null;
  /** Что насобирал каскад (dryRun-предпросмотр и диагностика). */
  fields?: AiFields[];
  /** 'telegram' — правила, 'parser' — ИИ (так же, как source у заявки). */
  source?: ListingSource;
  /** Разбор правилами — для предпросмотра в расширении. */
  parsed?: ParsedMessage;
  /** Текст ошибки создания (если заявка не создалась). */
  error?: string;
}

export interface IngestOptions {
  /** Сообщения старше N дней не берём (вариант A: 7, вариант B: 3). */
  maxAgeDays?: number;
  /** Дата сообщения: unix-секунды, миллисекунды или ISO-строка. */
  date?: number | string | null;
  /** false — только правила, ИИ не вызываем и квоту не тратим. */
  useAi?: boolean;
  /** dryRun — разобрать и вернуть результат, ничего не записывая в БД. */
  dryRun?: boolean;
  /** Чей дневной бюджет ИИ тратим (по умолчанию — по origin источника). */
  aiScope?: AiQuotaScope;
  /** Точки расширения: в parcel сюда подключаются существующие cascade()/notifyAdmins(). */
  cascade?: typeof cascade;
  notifyAdmins?: (env: Env, listing: Listing) => Promise<void>;
  createListing?: typeof createListing;
  /**
   * Проверка дубля по смыслу (src/dedupe.ts): то же объявление, присланное другим
   * сообщением. По умолчанию включена; отключается, если подменили createListing
   * (тесты) или передали null.
   */
  findDuplicate?: ((env: Env, input: ListingInput) => Promise<DuplicateHit<Listing> | null>) | null;
  /** Освежить существующую заявку вместо создания дубля (published поднимается наверх доски). */
  touchListing?: typeof touchListing;
  /** Минимальная длина текста (как в групповых сообщениях бота: < 10 — молча мимо). */
  minTextLength?: number;
  /** 'now' — для тестов с фиксированным временем. */
  now?: Date;
}

/* ------------------------------------------------------------------ */
/* Каскад: правила (confidence ≥ 0.7) → иначе ИИ                       */
/* ------------------------------------------------------------------ */

/** Поля заявки из правил парсера (дословно rulesFields() из telegram.ts). */
export function rulesFields(parsed: ParsedMessage, text: string): AiFields {
  // Один и тот же контакт не должен лежать в двух полях (дубль строки «Контакты:»)
  const { telegram, phone } = normalizeContacts(parsed.telegram, parsed.phone);
  return {
    type: parsed.intent ?? 'offer',
    fromCity: parsed.fromCity ?? 'не указано',
    toCity: parsed.toCity ?? 'не указано',
    departureDate: parsed.departureDate,
    weightKg: parsed.weightKg,
    price: parsed.price,
    telegram,
    phone,
    // Исходный текст модератору нужен дословно — убираем из него только контакты,
    // которые карточка и так показывает отдельной строкой
    description: dedupeDescription(text.slice(0, 2000), { telegram, phone, stripFields: false }),
  };
}

export interface CascadeOptions {
  /** false — не вызывать ИИ даже при низкой уверенности правил. */
  useAi?: boolean;
  /** Чей счётчик дневной квоты ИИ тратим. */
  scope?: AiQuotaScope;
  /** dryRun: проверить квоту, но не инкрементировать счётчик. */
  consumeQuota?: boolean;
  /** Свой ИИ-клиент (в parcel — aiExtractListing из src/ai.ts). */
  extract?: typeof aiExtractListing;
}

/**
 * Разобрать текст объявления: уверенно правилами, иначе ИИ (DeepSeek).
 * Одно сообщение может дать НЕСКОЛЬКО заявок (туда-обратно, два рейса) —
 * такие сообщения всегда уходят ИИ. Пустой список — не объявление.
 */
export async function cascade(
  env: Env,
  text: string,
  opts: CascadeOptions = {}
): Promise<{ list: AiFields[]; source: ListingSource }> {
  const parsed = parseTelegramMessage(text);
  const multi = isMultiRoute(text);
  if (parsed.confidence >= 0.7 && !multi) {
    return { list: [rulesFields(parsed, text)], source: 'telegram' };
  }
  const useAi = opts.useAi !== false;
  const scope = opts.scope ?? 'bot';
  if (useAi && env.AI_API_KEY && worthAiCheck(text)) {
    // болтовня в ИИ не уходит (worthAiCheck), а квота канала проверяется до вызова
    if (await aiQuotaAvailable(env, scope)) {
      const extract = opts.extract ?? aiExtractListing;
      const list = await extract(env, text, { scope, consumeQuota: opts.consumeQuota });
      if (list.length > 0) return { list, source: 'parser' };
    }
  }
  // ИИ не задан, не справился или квота канала исчерпана — хотя бы одно объявление правилами
  if (parsed.confidence >= 0.7) return { list: [rulesFields(parsed, text)], source: 'telegram' };
  return { list: [], source: 'telegram' };
}

/* ------------------------------------------------------------------ */
/* Дата сообщения                                                       */
/* ------------------------------------------------------------------ */

/** unix-секунды / unix-миллисекунды / ISO-строка → Date (или null). */
export function parseMessageDate(raw: number | string | null | undefined): Date | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    // секунды (Telegram) и миллисекунды (JS) различаем по порядку величины
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw === 'string') {
    const asNumber = Number(raw);
    if (/^\d{9,13}$/.test(raw.trim())) return parseMessageDate(asNumber);
    const t = Date.parse(raw);
    return Number.isFinite(t) ? new Date(t) : null;
  }
  return null;
}

function aiScopeOf(origin: ListingOrigin): AiQuotaScope {
  return origin === 'collector' ? 'collect' : origin === 'extension' ? 'extension' : 'bot';
}

/* ------------------------------------------------------------------ */
/* Главная точка входа                                                  */
/* ------------------------------------------------------------------ */

/**
 * Прогнать одно сообщение через общий конвейер.
 *
 * Идемпотентность: защита от дублей — единственная строка в tg_seen
 * (chat_id, message_id). Курсоры сборщика и локальные отметки расширения —
 * только оптимизация; повторная доставка того же сообщения вернёт
 * `{ status: 'duplicate', existingListingId }`, а не вторую заявку.
 */
export async function ingestMessage(
  env: Env,
  text: string,
  src: IngestSource,
  opts: IngestOptions = {}
): Promise<IngestResult> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const useAi = opts.useAi !== false;
  const scope = opts.aiScope ?? aiScopeOf(src.origin);
  const runCascade = opts.cascade ?? cascade;
  const notify = opts.notifyAdmins ?? defaultNotifyAdmins;
  const create = opts.createListing ?? createListing;
  // Дубль по смыслу ищем настоящей функцией из store, но не тогда, когда createListing
  // подменили (тесты пишут в свою заглушку — там сравнивать не с чем).
  const dedupe = opts.findDuplicate !== undefined
    ? opts.findDuplicate
    : (opts.createListing ? null : findDuplicate);
  const touch = opts.touchListing ?? touchListing;
  const body = typeof text === 'string' ? text.trim() : '';

  // 1. Пустой текст — invalid; длиннее 4000 — skipped:too_long (как в боте)
  if (!body) return { status: 'invalid', reason: 'bad_payload', listings: [] };
  if (body.length > MAX_TEXT_LENGTH) {
    return { status: 'skipped', reason: 'too_long', listings: [] };
  }
  const minLength = opts.minTextLength ?? MIN_TEXT_LENGTH;
  if (minLength > 0 && body.length < minLength) {
    return { status: 'skipped', reason: 'too_short', listings: [] };
  }

  // 2. Возраст сообщения (если дата известна)
  const maxAgeDays = opts.maxAgeDays;
  const messageDate = parseMessageDate(opts.date);
  if (maxAgeDays != null && maxAgeDays > 0 && messageDate) {
    const ageMs = now.getTime() - messageDate.getTime();
    if (ageMs > maxAgeDays * 86400_000) {
      return { status: 'skipped', reason: 'too_old', listings: [] };
    }
  }

  // 3. Пассажирские попутки доска не публикует
  if (isPassengerOnly(body)) return { status: 'skipped', reason: 'passenger', listings: [] };

  const parsed = parseTelegramMessage(body, now);
  const messageId = src.messageId != null && Number.isInteger(src.messageId) ? src.messageId : null;
  const hasKey = Boolean(src.chatId) && messageId != null;

  // 4. Дедупликация — ДО любых вызовов ИИ (иначе дубли тратят квоту и деньги)
  let existingListingId: string | null = null;
  if (hasKey) {
    if (dryRun) {
      existingListingId = await getSeenListing(env, src.chatId, messageId!);
      if (existingListingId !== null || (await isSeen(env, src.chatId, messageId!))) {
        return { status: 'duplicate', reason: undefined, listings: [], existingListingId, parsed };
      }
    } else if (!(await markSeen(env, src.chatId, messageId!))) {
      existingListingId = await getSeenListing(env, src.chatId, messageId!);
      return { status: 'duplicate', listings: [], existingListingId, parsed };
    }
  }

  // 5. Каскад: правила → ИИ. Пустой список — не объявление, но запись в tg_seen
  //    остаётся: повторно это сообщение не обрабатываем.
  let list: AiFields[] = [];
  let source: ListingSource = 'telegram';
  try {
    const res = await runCascade(env, body, {
      useAi,
      scope,
      consumeQuota: !dryRun,
    });
    list = res.list;
    source = res.source;
  } catch (e) {
    if (!dryRun && hasKey) await unmarkSeen(env, src.chatId, messageId!).catch(() => undefined);
    return { status: 'invalid', reason: 'bad_payload', listings: [], parsed, error: String(e) };
  }

  if (list.length === 0) {
    const aiWasPossible = useAi && Boolean(env.AI_API_KEY) && worthAiCheck(body);
    return {
      status: 'skipped',
      reason: aiWasPossible ? 'ai_empty' : 'no_intent',
      listings: [],
      fields: [],
      source,
      parsed,
    };
  }

  // dryRun: разбор есть, в базу не пишем ничего
  if (dryRun) {
    return { status: 'created', listings: [], fields: list, source, parsed };
  }

  // Ссылка на публичный чат сохраняем до создания заявок: она нужна для подписи
  // источника у ДРУГИХ сообщений этого чата, даже если это оказалось дублем.
  if (src.chatUrl && src.chatId) {
    await upsertChatLink(env, src.chatId, src.chatUrl).catch(() => undefined);
  }

  // 6. Заявки — всегда на модерацию: AUTO_APPROVE на собранные не влияет (ТЗ п. 0)
  const created: Listing[] = [];
  const duplicates: Array<{ listing: Listing; why: string }> = [];
  let similarTo: { id: string; why: string } | null = null;
  for (const fields of list) {
    // контакт — автор сообщения, если в самом тексте контакта нет
    // (так же работают пересылки и групповые сообщения бота)
    const telegram = fields.telegram ?? src.authorUsername ?? null;
    const input: ListingInput = {
      ...fields,
      telegram,
      status: 'pending',
      source,
      sourceChat: src.chatTitle ?? null,
      sourceChatId: src.chatId || null,
      sourceMessageId: messageId,
      origin: src.origin,
    };
    // 6.0 Дубль по смыслу: водитель пишет «20 сентября Варшава — Минск» каждый день
    //     новым сообщением — tg_seen это не ловит, вторая заявка не нужна.
    if (dedupe) {
      const hit = await dedupe(env, input).catch((e) => {
        console.error('ingest: duplicate check failed', src.chatId, messageId, e);
        return null;
      });
      if (hit && hit.kind === 'duplicate') {
        const refreshed = await touch(env, hit.listing.id).catch(() => null);
        const listing = refreshed ?? hit.listing;
        duplicates.push({ listing, why: hit.why });
        // ссылка «уже обработано» должна вести на существующую карточку
        if (hasKey && created.length === 0 && duplicates.length === 1) {
          await setSeenListing(env, src.chatId, messageId!, listing.id).catch(() => undefined);
        }
        continue;
      }
      if (hit && hit.kind === 'similar') similarTo = { id: hit.listing.id, why: hit.why };
    }

    try {
      const listing = await create(env, input);
      created.push(listing);
      // tg_seen.listing_id указывает на ПЕРВУЮ созданную заявку (ТЗ п. 2.1, шаг 6):
      // при нескольких направлениях из одного сообщения модератор по ссылке
      // «duplicate» видит первую карточку, остальные — через /api/admin/pending
      if (hasKey && created.length === 1) await setSeenListing(env, src.chatId, messageId!, listing.id);
    } catch (e) {
      // 8. Откат tg_seen: сообщение должно остаться доступным для повторной обработки
      //    (если не создано ни одной заявки — иначе повтор даст дубль направления)
      if (created.length === 0 && hasKey) {
        await unmarkSeen(env, src.chatId, messageId!).catch(() => undefined);
      }
      console.error('ingest: create listing failed', src.chatId, messageId, e);
      return {
        status: created.length > 0 ? 'created' : 'invalid',
        reason: created.length > 0 ? undefined : 'bad_payload',
        listings: created,
        fields: list,
        source,
        parsed,
        error: String(e),
      };
    }
  }

  // Все направления уже есть на доске — заявку не создаём, админам не пишем.
  if (created.length === 0) {
    return {
      status: 'duplicate',
      listings: [],
      existingListingId: duplicates[0]?.listing.id ?? null,
      duplicateOf: duplicates.map((d) => d.listing.id),
      duplicateWhy: duplicates[0]?.why ?? '',
      similarTo,
      fields: list,
      source,
      parsed,
    };
  }

  // 7. Уведомление админам — на каждую созданную заявку (дубли освежены молча)
  for (const listing of created) {
    await notify(env, listing).catch((e) => console.error('ingest: notify failed', e));
  }

  return {
    status: 'created',
    listings: created,
    fields: list,
    source,
    parsed,
    duplicateOf: duplicates.length ? duplicates.map((d) => d.listing.id) : undefined,
    duplicateWhy: duplicates.length ? duplicates[0]!.why : undefined,
    similarTo,
  };
}

/** Обработано ли сообщение раньше (только чтение, tg_seen не трогает). */
export async function isSeen(env: Env, chatId: string, messageId: number): Promise<boolean> {
  const row = (await env.DB.prepare(
    'SELECT 1 AS one FROM tg_seen WHERE chat_id = ? AND message_id = ?'
  ).bind(chatId, messageId).first()) as { one?: number } | null;
  return Boolean(row?.one);
}

/**
 * Пачка сообщений одного запроса: сортировка по (chatId, messageId)
 * и последовательная обработка (ТЗ п. 4.4.7 — по возрастанию messageId).
 */
export async function ingestMessages(
  env: Env,
  items: Array<{ text: string; src: IngestSource; date?: number | string | null }>,
  opts: Omit<IngestOptions, 'date'> = {}
): Promise<IngestResult[]> {
  const ordered = [...items].sort((a, b) => {
    if (a.src.chatId !== b.src.chatId) return a.src.chatId < b.src.chatId ? -1 : 1;
    return (a.src.messageId ?? 0) - (b.src.messageId ?? 0);
  });
  const out: IngestResult[] = [];
  for (const item of ordered) {
    out.push(await ingestMessage(env, item.text, item.src, { ...opts, date: item.date }));
  }
  return out;
}

/** IngestSource из сообщения веб-превью (вариант A). */
export function collectorSource(username: string, opts: {
  messageId: number;
  title?: string | null;
  author?: string | null;
}): IngestSource {
  const name = usernameOfChatId(username.startsWith('web:') ? username : `web:${username}`) ?? username;
  return {
    chatId: `web:${name}`,
    chatTitle: opts.title ?? name,
    messageId: opts.messageId,
    chatUrl: chatUrlOf(`web:${name}`),
    authorName: opts.author ?? null,
    origin: 'collector',
  };
}

/** IngestSource из сообщения браузерного расширения (вариант B). */
export function extensionSource(msg: {
  chatId: string;
  messageId: number;
  chatTitle?: string | null;
  chatUrl?: string | null;
  authorName?: string | null;
  authorUsername?: string | null;
}): IngestSource {
  return {
    chatId: msg.chatId,
    chatTitle: msg.chatTitle ?? null,
    messageId: msg.messageId,
    chatUrl: msg.chatUrl ?? chatUrlOf(msg.chatId),
    authorName: msg.authorName ?? null,
    authorUsername: normalizeAt(msg.authorUsername ?? null),
    origin: 'extension',
  };
}

/** '@user' / 'user' / 't.me/user' → '@user' (или null). */
export function normalizeAt(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  const m = /(?:t\.me\/|@)([a-zA-Z0-9_]{4,32})/i.exec(value);
  if (m) return `@${m[1]}`;
  return /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(value) ? `@${value}` : null;
}

// ParsedMessage реэкспортируем для удобства (расширению нужен тот же тип)
export type { ParsedMessage };
