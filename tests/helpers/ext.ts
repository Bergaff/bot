/**
 * Подключение клиентских модулей расширения к тестам.
 *
 * extension/core.js и extension/dom.js — UMD-файлы (в браузере их грузит
 * обычный <script>, в MV3 ES-модули для content scripts недоступны), поэтому
 * здесь они достаются через createRequire, как node:sqlite в local/node-sqlite.ts.
 * Vite/Vitest .cjs не разрешает — Node делает это сам.
 */
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

/* eslint-disable @typescript-eslint/no-explicit-any -- браузерные модули без .d.ts */

export interface ChatRef {
  title?: string | null;
  username?: string | null;
  id?: string | number | null;
  chatId?: string | null;
  /** Как Telegram Web представил чат: supergroup | group | user | channel. */
  kind?: string | null;
  /** Заголовок группы, когда открыт рум (заголовок вкладки — имя рума). */
  groupTitle?: string | null;
  /** Имя рума (топика) форум-чата. */
  topicTitle?: string | null;
  /** id рума (топика) из адреса вкладки. */
  topicId?: number | null;
  /** 'whitelist' — id рума пришлось взять из ссылки в белом списке (клиент его не отдал). */
  topicIdSource?: string | null;
}

/** Запись белого списка после разбора (см. core.normalizeWhitelistEntry). */
export interface WhitelistEntry {
  kind: 'username' | 'title' | 'peer';
  value: string;
  /** Имя рума (топика), если запись вида «чат :: тема». */
  topic?: string | null;
  /** id рума из ссылки t.me/<чат>/<рум> или из записи «чат :: 91529». */
  topicId?: number | null;
  /** true — рум задан явно; false — ссылка из двух частей, могла быть ссылкой на сообщение. */
  topicStrict?: boolean;
}

export interface ExtSettings {
  serverUrl: string;
  token: string;
  intervalSec: number;
  batchSize: number;
  maxPerChat: number;
  confirmMode: boolean;
  paused: boolean;
  whitelist: string[];
  maxAgeHours: number;
  requireContact: boolean;
  /** Автообход: расширение само открывает чаты и румы из белого списка. */
  autoWalk: boolean;
  /** Сколько проходов чтения сделать в чате, прежде чем идти дальше. */
  walkReadsPerChat: number;
  /** Случайная пауза перед переходом, секунд (от…до). */
  walkMinSec: number;
  walkMaxSec: number;
  /** Предел переходов в час. */
  walkMaxPerHour: number;
  /** Пока пользователь сам во вкладке — чат не переключаем (секунд тишины). */
  walkIdleGuardSec: number;
}

/** Цель обхода: запись белого списка, в которую расширение откроет вкладку. */
export interface WalkTarget {
  /** Как запись выглядела в белом списке. */
  raw: string;
  /** Короткое имя для журнала и панели: «travelersminsk/91529». */
  label: string;
  kind: 'username' | 'title' | 'peer';
  value: string;
  topicId: number | null;
  topic: string | null;
  topicStrict: boolean;
  chatKey: string | null;
}

/** Что обход решил на этом такте. */
export interface WalkDecision {
  action: 'off' | 'idle' | 'wait' | 'wait-load' | 'navigate' | 'read';
  reason?: string;
  target?: WalkTarget | null;
  from?: WalkTarget | null;
  index?: number;
  reads?: number;
  waitSec?: number;
  switchesHour?: number;
  note?: string;
}

/** Состояние обхода для чистого расчёта решения (без DOM и таймеров). */
export interface WalkStateInput {
  plan: WalkTarget[];
  index: number;
  reads: number;
  nextAt: number;
  switching: boolean;
  switches: number[];
  lastUserActivity: number;
  now: number;
}

export interface DetectVerdict {
  send: boolean;
  reason: string;
  parsed?: any;
  hasContact?: boolean;
}

export interface PayloadMessage {
  chatId: string;
  messageId: number;
  text: string;
  /** Рум (топик) форум-чата — уходит в контракт, нужен серверу для ссылки. */
  topicId?: number | null;
  /** Пермалинк t.me/<чат>[/<рум>]/<сообщение> или null (для панели расширения). */
  link?: string | null;
  chatTitle: string | null;
  chatUrl: string | null;
  date: number | null;
  authorName: string | null;
  authorUsername: string | null;
  dateMs: number | null;
  idSource: 'dom' | 'synthetic';
}

export interface IngestSummary {
  received: number; created: number; duplicate: number;
  skipped: number; invalid: number; listings: number;
}

export interface HarvestedMessage {
  text: string;
  messageId: number | null;
  idSource: string;
  dateMs: number | null;
  dateRaw: string | null;
  authorName: string | null;
  authorUsername: string | null;
}

export interface HarvestReport {
  messages: HarvestedMessage[];
  strategy: string | null;
  total: number;
  unreadable: boolean;
  counts: Record<string, number>;
}

export interface CoreApi {
  COLLECTOR: string;
  SENT_LOG_LIMIT: number;
  DEFAULT_SETTINGS: ExtSettings;
  withDefaults: (raw?: unknown) => ExtSettings;
  /** Текст проблемы с адресом сервера или null, если адрес годится. */
  serverUrlProblem: (raw?: unknown) => string | null;
  normalizeWhitelist: (list: unknown) => WhitelistEntry[];
  normalizeWhitelistEntry: (raw: unknown) => WhitelistEntry | null;
  matchesWhitelist: (chat: ChatRef | null, whitelist: unknown) => boolean;
  /** Почему открытый чат не подошёл белому списку (или null, если подошёл). */
  whitelistMismatch: (chat: ChatRef | null, whitelist: unknown) => string | null;
  /** Рум из белого списка, когда клиент не отдал его id (или null). */
  adoptTopicFromWhitelist: (chat: ChatRef | null, whitelist: unknown) => { topicId: number; note: string } | null;
  /** Пермалинк на сообщение: t.me/<чат>[/<рум>]/<сообщение> или null. */
  messageLink: (chat: ChatRef | null, messageId: unknown, opts?: { synthetic?: boolean; idSource?: string }) => string | null;
  VERDICT_LABELS: Record<string, string>;
  REASON_LABELS: Record<string, string>;
  explainReason: (reason: string | null | undefined) => string;
  verdictLine: (rec: Record<string, any> | null) => string;
  squashTitle: (s: string) => string;
  chatKeyOf: (chat: ChatRef | null) => string | null;
  stableId: (s: string) => number;
  syntheticMessageId: (chatKey: string, text: string, dateMs?: number | null) => number;
  detect: (text: string, parser: unknown, settings?: Partial<ExtSettings> | null) => DetectVerdict;
  withinAge: (dateMs: number | null | undefined, maxAgeHours: number, now?: number) => boolean;
  sentKey: (chatId: string, messageId: number) => string;
  filterUnsent: <T extends { chatId: string; messageId: number }>(messages: T[], sent: string[]) => T[];
  chunk: <T>(messages: T[], size?: number) => T[][];
  takeRecent: <T extends { dateMs?: number | null }>(messages: T[], maxPerChat?: number) => T[];
  backoffMs: (attempt: number, baseMs?: number, maxMs?: number) => number;
  classifyStatus: (status: number) => string;
  buildPayload: (messages: any[], opts?: { collector?: string; dryRun?: boolean }) => any;
  toPayloadMessage: (raw: any, settings?: Partial<ExtSettings>) => PayloadMessage;
  /**
   * Разбор ответа /api/ingest. `batch` — что мы сами отправили: даже если сервер
   * не прислал results, эти сообщения повторно не уйдут (кроме помеченных invalid).
   */
  summarizeResponse: (body: any, batch?: Array<{ chatId: string; messageId: number }>) => IngestSummary & { sentKeys: string[] };
  mergeCounters: (a: any, b: any) => any;
  pruneSentLog: (keys: string[], limit?: number) => string[];
  diagnostic: (report: any) => string;
  /* --- автообход чатов и румов --- */
  /** План обхода из белого списка: порядок сохранён, повторы схлопнуты. */
  walkTargets: (whitelist: unknown) => WalkTarget[];
  /** Какой это клиент Telegram Web: 'k' | 'a' | 'z' | null. */
  clientFlavor: (location: any) => string | null;
  /** Адрес вкладки для цели (или null — тогда открываем кликом по списку чатов). */
  walkHashFor: (target: WalkTarget | null | undefined, location: any) => string | null;
  /** Случайная пауза перед переходом, мс. */
  walkPauseMs: (minSec: number, maxSec: number, rand?: () => number) => number;
  /** Отметки переходов за последний час. */
  walkSwitchesInHour: (stamps: number[] | null | undefined, now?: number) => number[];
  /** Индекс цели, которая сейчас открыта (-1, если это не из плана). */
  walkIndexForChat: (plan: WalkTarget[], chat: ChatRef | null) => number;
  /** Следующая цель перехода, минуя те, что в этом круге не открылись. */
  walkNextIndex: (plan: WalkTarget[], from: number, failed?: string[] | null) => number;
  /** Тот ли чат/рум открылся после перехода. */
  walkTargetMatches: (target: WalkTarget | null | undefined, chat: ChatRef | null) => boolean;
  /** Чистое решение: читать, переходить или подождать. */
  walkDecision: (input: WalkStateInput, settings: Partial<ExtSettings>) => WalkDecision;
}

export interface DomApi {
  MESSAGE_CONTAINERS: string[];
  TEXT_SELECTORS: string[];
  AUTHOR_SELECTORS: string[];
  DATE_SELECTORS: string[];
  ID_ATTRS: string[];
  CHAT_ROW_SELECTORS: string[];
  ROW_TITLE_SELECTORS: string[];
  NON_CHAT_HASHES: string[];
  textOf: (node: any) => string;
  attrOf: (node: any, names: string[]) => string | null;
  messageIdFromNode: (node: any) => { id: number | null; source: string };
  toMessageId: (raw: unknown) => number | null;
  monthOf: (word: string) => number | null;
  parseDomDate: (raw: unknown, now?: number) => number | null;
  cleanDocTitle: (raw: string) => string;
  readChatInfo: (doc: any, location: any) => ChatRef;
  harvest: (doc: any, opts?: { limit?: number; now?: number; root?: any }) => HarvestReport;
  isReadable: (doc: any) => boolean;
  /** Текст в одну строку, в нижнем регистре — для сравнения имён чатов. */
  squashText: (raw: unknown) => string;
  /** Строка чата/рума в боковом списке: { node, title } или null. Только поиск, клик делает вызывающий. */
  findChatRow: (doc: any, labels: unknown) => { node: any; title: string } | null;
  /** Отпечаток содержимого ленты (без адреса вкладки) — для проверки перехода. */
  contentFingerprint: (doc: any) => string;
}

export const core = nodeRequire('../../extension/core.js') as CoreApi;
export const dom = nodeRequire('../../extension/dom.js') as DomApi;
