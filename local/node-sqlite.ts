import { createRequire } from 'node:module';

/**
 * Обёртка над встроенным `node:sqlite`.
 *
 * Нужна только для локального запуска (CLI-скраппер, тесты): Vite/Vitest
 * не знает такой builtin у новых версий Node и пытается разрешить «sqlite»
 * как пакет. Через createRequire модуль достаётся напрямую из Node.
 * В `Bergaff/parcel` (Cloudflare Worker) файлов из local/ нет вовсе.
 */
const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire('node:sqlite') as typeof import('node:sqlite');

export const DatabaseSync = sqlite.DatabaseSync;
export type DatabaseSyncInstance = InstanceType<typeof sqlite.DatabaseSync>;
