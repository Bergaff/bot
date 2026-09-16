import { DatabaseSync, type DatabaseSyncInstance } from './node-sqlite.ts';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Env } from '../src/types.ts';

/**
 * Локальная реализация биндингов воркера (D1 + KV) поверх встроенного
 * `node:sqlite` — без нативных зависимостей, чтобы скраппер можно было
 * гонять на своей машине одним `npm run watch`.
 *
 * Файлы из `local/` в `Bergaff/parcel` НЕ переносятся: там D1 и KV настоящие.
 * Интерфейс повторяет Worker API ровно настолько, чтобы src/*.ts не замечал
 * разницы (prepare().bind().run()/.all()/.first(), KV.get/put/delete,
 * meta.changes, expirationTtl).
 */

export interface SqliteEnvOptions {
  /** Путь к файлу БД (':memory:' — в памяти). По умолчанию .data/collector.db */
  dbPath?: string;
  /** Применить миграции из migrations/ при создании. По умолчанию true. */
  migrate?: boolean;
  /** Переменные окружения (токены, лимиты). */
  vars?: Partial<Env>;
}

interface BoundStatement {
  sql: string;
  params: unknown[];
}

/** D1-совместимый подготовленный запрос. */
class LocalStatement implements D1PreparedStatement {
  private db: DatabaseSyncInstance;
  private sql: string;
  private params: unknown[];

  constructor(db: DatabaseSyncInstance, sql: string, params: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new LocalStatement(this.db, this.sql, values);
  }

  private normalized(): unknown[] {
    return this.params.map((v) => {
      if (v === undefined) return null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v === 'number' || typeof v === 'string' || v === null) return v;
      return String(v);
    });
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...(this.normalized() as never[])) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (colName) return (row[colName] as T) ?? null;
    return row as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Response & { results?: T[] }> {
    const started = Date.now();
    const stmt = this.db.prepare(this.sql);
    const res = stmt.run(...(this.normalized() as never[]));
    return {
      success: true,
      results: [],
      meta: { changes: Number(res.changes ?? 0), duration: Date.now() - started },
    } as D1Response & { results?: T[] };
  }

  async all<T = Record<string, unknown>>(): Promise<D1Response & { results: T[] }> {
    const started = Date.now();
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...(this.normalized() as never[])) as T[];
    return { success: true, results: rows, meta: { duration: Date.now() - started } };
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...(this.normalized() as never[])) as Array<Record<string, unknown>>;
    if (options?.columnNames) {
      const names = rows.length ? Object.keys(rows[0]!) : [];
      return [names, ...rows.map((r) => names.map((n) => r[n]))] as unknown as T[];
    }
    return rows.map((r) => Object.values(r)) as unknown as T[];
  }
}

/** D1-совместимая «база». */
export class LocalD1 implements D1Database {
  private db: DatabaseSyncInstance;

  constructor(db: DatabaseSyncInstance) {
    this.db = db;
  }

  prepare(query: string): D1PreparedStatement {
    return new LocalStatement(this.db, query);
  }

  async batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<Array<D1Response & { results?: T[] }>> {
    const out: Array<D1Response & { results?: T[] }> = [];
    for (const stmt of statements) out.push((await (stmt as LocalStatement).run<T>()));
    return out;
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    const started = Date.now();
    this.db.exec(query);
    return { count: query.split(';').filter((s) => s.trim()).length, duration: Date.now() - started };
  }

  async dump(): Promise<ArrayBuffer> {
    return new Uint8Array().buffer as ArrayBuffer;
  }
}

/** KV-совместимое хранилище (таблица kv с ленивым удалением по TTL). */
export class LocalKV {
  private db: DatabaseSyncInstance;

  constructor(db: DatabaseSyncInstance) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS kv (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL,
       expires_at INTEGER
     )`);
  }

  async get(key: string): Promise<string | null> {
    this.db.prepare('DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .run(Date.now());
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value?: string }
      | undefined;
    return row?.value ?? null;
  }

  async put(key: string, value: string, init?: { expiration?: number; expirationTtl?: number }): Promise<void> {
    let expiresAt: number | null = null;
    if (init?.expiration) expiresAt = init.expiration * 1000;
    else if (init?.expirationTtl) expiresAt = Date.now() + init.expirationTtl * 1000;
    this.db.prepare(
      `INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`
    ).run(key, String(value), expiresAt);
  }

  async delete(key: string): Promise<void> {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  async list(options?: { prefix?: string; limit?: number }): Promise<{
    keys: Array<{ name: string; expiration?: number }>;
    list_complete: boolean;
  }> {
    const prefix = options?.prefix ?? '';
    const limit = Math.max(1, options?.limit ?? 1000);
    const rows = this.db.prepare(
      'SELECT key, expires_at FROM kv WHERE key LIKE ? ORDER BY key LIMIT ?'
    ).all(`${prefix.replace(/[%_]/g, '\\$&')}%`, limit) as Array<{ key: string; expires_at: number | null }>;
    return {
      keys: rows.map((r) => ({ name: r.key, expiration: r.expires_at ? Math.floor(r.expires_at / 1000) : undefined })),
      list_complete: true,
    };
  }
}

/** Применённые миграции — чтобы ALTER TABLE … не запускался дважды. */
const MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS _migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

/** «Это уже применялось» — SQLite не умеет IF NOT EXISTS для колонок. */
function isAlreadyAppliedError(e: unknown): boolean {
  const message = String((e as Error | null)?.message ?? e);
  return /duplicate column name|duplicate table|already exists/i.test(message);
}

/** Разбить файл миграции на предложения (нужно, чтобы перезапустить их по одному). */
function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0 &&
      chunk.split('\n').some((l) => l.trim().length > 0 && !l.trim().startsWith('--')));
}

/**
 * Применить migrations/*.sql по порядку, каждый — один раз.
 * Трекинг в таблице _migrations: в 0006 есть ALTER TABLE listings ADD COLUMN,
 * повторный прогон которого SQLite не переживёт (durable migrations wrangler
 * делает так же). Сами CREATE TABLE в миграциях — с IF NOT EXISTS.
 *
 * Отдельно переживаем переименование файла миграции (0004_ingest.sql →
 * 0006_ingest.sql при подстройке под нумерацию parcel): трекинг по имени уже
 * не совпадает, но DDL частично применён — тогда повторяем по одному
 * предложению и пропускаем «duplicate column/table».
 */
export function applyMigrations(db: DatabaseSyncInstance, migrationsDir: string): string[] {
  db.exec(MIGRATIONS_DDL);
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    const done = db.prepare('SELECT name FROM _migrations WHERE name = ?').get(file) as { name?: string } | undefined;
    if (done) continue;
    const sql = readFileSync(resolve(migrationsDir, file), 'utf8');
    try {
      db.exec(sql);
    } catch (e) {
      if (!isAlreadyAppliedError(e)) throw e;
      for (const statement of splitStatements(sql)) {
        try {
          db.exec(statement);
        } catch (e2) {
          if (!isAlreadyAppliedError(e2)) throw e2;
        }
      }
    }
    db.prepare('INSERT OR IGNORE INTO _migrations (name) VALUES (?)').run(file);
    applied.push(file);
  }
  return applied;
}

/** Собрать локальный Env: D1 (sqlite-файл) + KV + переменные. */
export function createLocalEnv(opts: SqliteEnvOptions = {}): Env & {
  close: () => void;
  dbPath: string;
  db: DatabaseSyncInstance;
} {
  const dbPath = opts.dbPath ?? '.data/collector.db';
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  if (opts.migrate !== false) {
    applyMigrations(db, resolve(import.meta.dirname ?? '.', '..', 'migrations'));
  }

  const env = {
    DB: new LocalD1(db),
    KV: new LocalKV(db),
    ...opts.vars,
    close: () => db.close(),
    dbPath,
    db,
  } as Env & { close: () => void; dbPath: string; db: DatabaseSyncInstance };
  return env;
}

/** То же, но в памяти — для тестов и одноразовых прогонов. */
export function createMemoryEnv(vars: Partial<Env> = {}): Env & { close: () => void } {
  return createLocalEnv({ dbPath: ':memory:', vars });
}

/** Переменные окружения из .env-подобного файла и process.env. */
export function envFromProcess(extra: Partial<Env> = {}): Partial<Env> {
  const p = process.env as Record<string, string | undefined>;
  const num = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);
  return {
    BOT_TOKEN: num(p.BOT_TOKEN),
    ADMIN_IDS: num(p.ADMIN_IDS),
    ADMIN_API_TOKEN: num(p.ADMIN_API_TOKEN) ?? 'dev-admin-token',
    INGEST_TOKEN: num(p.INGEST_TOKEN) ?? 'dev-ingest-token',
    AI_API_KEY: num(p.AI_API_KEY),
    AI_MODEL: num(p.AI_MODEL),
    COLLECT_ENABLED: num(p.COLLECT_ENABLED) ?? '1',
    COLLECT_MAX_CHATS: num(p.COLLECT_MAX_CHATS) ?? '10',
    COLLECT_MAX_PAGES: num(p.COLLECT_MAX_PAGES) ?? '2',
    COLLECT_MAX_AGE_DAYS: num(p.COLLECT_MAX_AGE_DAYS) ?? '7',
    COLLECT_AI_DAILY_LIMIT: num(p.COLLECT_AI_DAILY_LIMIT) ?? '100',
    COLLECT_MAX_FETCHES: num(p.COLLECT_MAX_FETCHES),
    COLLECT_PREVIEW_BASE: num(p.COLLECT_PREVIEW_BASE),
    INGEST_MAX_AGE_DAYS: num(p.INGEST_MAX_AGE_DAYS),
    SITE_URL: num(p.SITE_URL),
    // для локальной отладки: зеркало t.me/s (local/mock-tme.mjs), мок Bot API и ИИ
    TG_API_BASE: num(p.TG_API_BASE),
    AI_BASE_URL: num(p.AI_BASE_URL),
    ...extra,
  };
}

export type { BoundStatement };
