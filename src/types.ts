/** Точка входа для Cloudflare Worker — переменные окружения и биндинги. */
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  /** Доступ к статическим файлам из public/ без сетевого запроса (для OG-шрифтов).
   *  Необязательный: авто-сбору не нужен, а вне воркера (CLI/тесты) его просто нет. */
  ASSETS?: Fetcher;
  BOT_TOKEN?: string;
  BOT_SECRET?: string;
  ADMIN_IDS?: string;
  AUTO_APPROVE?: string;
  SITE_URL?: string;
  BOT_USERNAME?: string;
  ADMIN_API_TOKEN?: string;
  /** "1" — бот отвечает в группах после распознавания объявления (по умолчанию молчит). */
  REPLY_IN_GROUPS?: string;
  /** Ключ DeepSeek API: включает ИИ-оформление «трудных» объявлений (вторая ступень после правил). */
  AI_API_KEY?: string;
  /** Модель DeepSeek (по умолчанию deepseek-chat). */
  AI_MODEL?: string;
  /** Базовый URL API — для локальных тестов. */
  AI_BASE_URL?: string;

  /* ---- Авто-сбор объявлений (ТЗ docs/tz-auto-collection.md, п. 2.5) ---- */

  /** Bearer-токен для POST /api/ingest (вариант B — браузерное расширение). Секрет. */
  INGEST_TOKEN?: string;
  /** "1" — cron-сборщик публичных чатов включён (вариант A). */
  COLLECT_ENABLED?: string;
  /** Сколько чатов обходим за один запуск cron (лимит подзапросов воркера). */
  COLLECT_MAX_CHATS?: string;
  /** Сколько страниц `?before=` на один чат за запуск. */
  COLLECT_MAX_PAGES?: string;
  /** Сообщения старше N дней не берём. */
  COLLECT_MAX_AGE_DAYS?: string;
  /** Дневной лимит ИИ-вызовов авто-сбора (отдельный от ботовского ai:day:*). */
  COLLECT_AI_DAILY_LIMIT?: string;
  /** Зарезервировано: собранные заявки ВСЕГДА идут в pending. */
  COLLECT_AUTO_APPROVE?: string;
  /** Жёсткий потолок сетевых запросов сборщика на один прогон (лимит подзапросов воркера). */
  COLLECT_MAX_FETCHES?: string;
  /** Выражение cron сборщика — должно совпадать с [triggers] в wrangler.toml. */
  COLLECT_CRON?: string;
  /** Выражение cron архивации (в parcel задано в wrangler.toml: 0 21 * * *). */
  ARCHIVE_CRON?: string;
  /** Сколько дней хранения у сообщений, присланных расширением (вариант B). */
  INGEST_MAX_AGE_DAYS?: string;
  /** Базовый URL Telegram Bot API (по умолчанию https://api.telegram.org) — для тестов/прокси. */
  TG_API_BASE?: string;
}

export type ListingType = 'offer' | 'request';
export type ListingStatus = 'pending' | 'published' | 'rejected' | 'expired';
export type ListingSource = 'site' | 'telegram' | 'parser';

/** Откуда заявка попала на доску: бот в чате, серверный сборщик (t.me/s/)
 *  или браузерное расширение (POST /api/ingest). Колонка listings.origin. */
export type ListingOrigin = 'bot' | 'collector' | 'extension';

export interface ListingInput {
  type: ListingType;
  fromCity: string;
  toCity: string;
  departureDate?: string | null;
  weightKg?: number | null;
  price?: string | null;
  description: string;
  phone?: string | null;
  telegram?: string | null;
  status: ListingStatus;
  source: ListingSource;
  sourceChat?: string | null;
  sourceChatId?: string | null;
  sourceMessageId?: number | null;
  /** 'bot' по умолчанию — см. ListingOrigin и миграцию 0004_ingest.sql. */
  origin?: ListingOrigin;
}

export interface Listing extends ListingInput {
  id: string;
  createdAt: string;
  publishedAt: string | null;
  views: number;
}

export interface ListFilters {
  type?: ListingType;
  /** true — архив: заявки с прошедшей датой (статус expired или published с прошлой датой). */
  archive?: boolean;
  from?: string;
  to?: string;
  date?: string;
  q?: string;
  page?: number;
  perPage?: number;
  status?: ListingStatus;
}

export interface ParsedMessage {
  intent: 'offer' | 'request' | null;
  fromCity: string | null;
  toCity: string | null;
  departureDate: string | null;
  weightKg: number | null;
  price: string | null;
  telegram: string | null;
  phone: string | null;
  confidence: number;
}
