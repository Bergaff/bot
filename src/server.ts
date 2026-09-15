import { Hono } from 'hono';
import { collectPublicChats } from './collect.ts';
import { registerAdminCollectRoutes, registerIngestRoutes } from './routes.ts';
import type { Env } from './types.ts';

/**
 * Точка входа воркера авто-сбора.
 *
 * В `Bergaff/parcel` этот файл НЕ переносится: там уже есть src/index.ts
 * с Hono-приложением, CORS и админ-middleware. Переносится только:
 *   1. `registerIngestRoutes(app)`   — до app.use('/api/admin/*');
 *   2. `registerAdminCollectRoutes(app)` — после него;
 *   3. `scheduled()` с switch (event.cron) — вместо текущего хендлера,
 *      который игнорирует event.cron (ТЗ п. 2.4).
 * Здесь же всё это собрано в самостоятельное приложение, чтобы серверную
 * часть можно было гонять локально (`npm run server`) и тестировать.
 */

export const ARCHIVE_CRON = '0 21 * * *';
export const COLLECT_CRON = '17 */2 * * *';

export function createApp(env: Partial<Env> = {}): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  /* CORS: расширение шлёт запросы с origin https://web.telegram.org.
     Методы и заголовки — как в src/index.ts проекта parcel (PUT здесь не нужен:
     /api/ingest работает через POST, админка — через PUT под своим middleware). */
  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('Origin') ?? '';
    if (origin) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      c.header('Access-Control-Max-Age', '86400');
    }
    if (c.req.method === 'OPTIONS') {
      // именно c.body(), а не new Response(): иначе c.header() не попадёт в ответ
      return c.body(null, 204);
    }
    await next();
  });

  app.get('/api/health', (c) => c.json({ ok: true, time: new Date().toISOString() }));

  // вариант B: POST /api/ingest (Authorization: Bearer INGEST_TOKEN)
  registerIngestRoutes(app);

  /* Админка: Bearer ADMIN_API_TOKEN — тот же middleware, что в parcel. */
  app.use('/api/admin/*', async (c, next) => {
    const auth = c.req.header('Authorization') ?? '';
    if (!c.env.ADMIN_API_TOKEN || auth !== `Bearer ${c.env.ADMIN_API_TOKEN}`) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  // вариант A: watch-chats / collect / collect/status
  registerAdminCollectRoutes(app);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    console.error('worker error', err);
    return c.json({ error: 'internal_error' }, 500);
  });

  void env; // env приходит из биндингов воркера; параметр оставлен для единообразия signature
  return app;
}

/** Задача архивации (в parcel — archiveExpired() из src/store.ts). */
export type ArchiveTask = (env: Env) => Promise<{ archived: number; deleted: number }>;

export interface ScheduledHooks {
  archive?: ArchiveTask;
  collect?: (env: Env) => Promise<unknown>;
  collectCron?: string;
  archiveCron?: string;
}

/**
 * Обработчик cron.
 *
 * ОБЯЗАТЕЛЬНО switch (event.cron): триггеров теперь два (архив + сборщик),
 * и без ветвления архивация запускалась бы вместе со сбором каждый раз.
 */
export async function runScheduled(
  event: Pick<ScheduledController, 'cron'>,
  env: Env,
  hooks: ScheduledHooks = {}
): Promise<void> {
  const collectCron = hooks.collectCron ?? env.COLLECT_CRON ?? COLLECT_CRON;
  const archiveCron = hooks.archiveCron ?? env.ARCHIVE_CRON ?? ARCHIVE_CRON;

  switch (event.cron) {
    case archiveCron: {
      if (!hooks.archive) {
        console.log('scheduled: archive task не подключён (в parcel — archiveExpired(env))');
        return;
      }
      const res = await hooks.archive(env);
      console.log('archiveExpired:', JSON.stringify(res));
      return;
    }
    case collectCron: {
      const collect = hooks.collect ?? ((e: Env) => collectPublicChats(e));
      const report = await collect(env);
      console.log('collectPublicChats:', JSON.stringify(report));
      return;
    }
    default:
      console.log('scheduled: неизвестный cron', event.cron);
  }
}

export function createWorker(hooks: ScheduledHooks = {}): {
  fetch: Hono<{ Bindings: Env }>['fetch'];
  scheduled: (event: ScheduledController, env: Env, ctx: ExecutionContext) => Promise<void>;
} {
  const app = createApp();
  return {
    fetch: app.fetch,
    scheduled: async (event, env, ctx) => {
      await runScheduled(event, env, hooks);
      void ctx;
    },
  };
}

export default createWorker();
