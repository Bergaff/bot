/**
 * Мини-шим Cloudflare Worker API для работы вне воркера.
 *
 * В `Bergaff/parcel` эти типы даёт devDependency `@cloudflare/workers-types`
 * (tsconfig: "types": ["@cloudflare/workers-types"]), и этот файл туда
 * переносить НЕ нужно. Здесь он нужен, чтобы `src/*.ts` компилировались и
 * запускались в обычном Node (CLI-скраппер, локальный сервер, vitest),
 * оставаясь при этом байт-в-байт совместимыми с воркером.
 */

interface D1Response {
  results?: unknown[];
  success: boolean;
  error?: string;
  meta: Record<string, unknown> & { changes?: number; duration?: number };
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Response & { results?: T[] }>;
  all<T = Record<string, unknown>>(): Promise<D1Response & { results: T[] }>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
}

declare interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<Array<D1Response & { results?: T[] }>>;
  exec(query: string): Promise<{ count: number; duration: number }>;
  dump(): Promise<ArrayBuffer>;
}

declare interface KVNamespace {
  get(key: string, options?: { cacheTtl?: number }): Promise<string | null>;
  get(key: string, type: 'text'): Promise<string | null>;
  get<T = unknown>(key: string, type: 'json'): Promise<T | null>;
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  get(key: string, type: 'stream'): Promise<ReadableStream | null>;
  get(key: string, options?: { type: 'text' } & { cacheTtl?: number }): Promise<string | null>;
  get<T = unknown>(key: string, options?: { type: 'json' } & { cacheTtl?: number }): Promise<T | null>;
  put(key: string, value: string | ArrayBuffer | ReadableStream, init?: Partial<{ expiration?: number; expirationTtl?: number }>): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: Partial<{ prefix?: string; limit?: number; cursor?: string }>): Promise<{ keys: Array<{ name: string; expiration?: number }>; list_complete: boolean; cursor?: string }>;
}

declare interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
  readonly noRetry: () => void;
}

declare interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/** Отдаёт статические файлы (в воркере — биндинг ASSETS). Авто-сбору не нужен. */
declare interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}
