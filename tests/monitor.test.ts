/**
 * Тесты мониторинга авто-сбора (этап 7): scripts/collect-report.mjs.
 * Отчёт — чистая функция от ответа сервера, поэтому проверяется без сети.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_STALE_HOURS, fetchState, formatReport, summarize } from '../scripts/collect-report.mjs';

const NOW = new Date('2026-09-16T14:00:00Z');

function status(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    enabled: true,
    ingestTokenSet: true,
    watchChats: { total: 2, enabled: 2, withErrors: 0 },
    ai: { collectUsedToday: 3, collectLimit: 20, collectLeft: 17, ingestLeft: 20 },
    listingsByOrigin: { bot: 2, collector: 5, extension: 1 },
    extensionToday: { messages: 12, created: 3 },
    lastReport: {
      startedAt: '2026-09-16T13:20:49.156Z',
      dryRun: false,
      totals: { chats: 2, fetched: 6, new: 6, created: 3, duplicate: 0, skipped: 3, invalid: 0, errors: 0, disabled: 0, fetches: 2 },
    },
    ...over,
  };
}

function chat(over: Record<string, unknown> = {}) {
  return {
    id: 'web:drivers_pl_by', username: 'drivers_pl_by', kind: 'supergroup', enabled: true,
    lastMessageId: 9004, lastCheckedAt: '2026-09-16 13:20:49', lastError: null, errorCount: 0,
    statsFound: 6, statsCreated: 3, statsSkipped: 1, ...over,
  };
}

describe('summarize: здоровый прогон', () => {
  it('проблем нет, отчёт содержит главные цифры', () => {
    const s = summarize(status(), [chat(), chat({ id: 'web:durov', username: 'durov', kind: 'channel' })], { now: NOW });
    expect(s.ok).toBe(true);
    expect(s.problems).toEqual([]);
    expect(s.warnings).toEqual([]);
    expect(s.chats).toBe(2);
    const text = s.lines.join('\n');
    expect(text).toContain('cron-сборщик: включён');
    expect(text).toContain('приём от расширения: включён');
    expect(text).toContain('3/20 (осталось 17)');
    expect(text).toContain('бот 2, сборщик 5, расширение 1');
    expect(text).toContain('принято 12 сообщений, создано 3 заявок');
    expect(text).toContain('заявок 3, дублей 0, отсеяно 3, ошибок 0');
    expect(text).toContain('drivers_pl_by [supergroup] вкл · курсор 9004');
  });

  it('формат даты sqlite (без T) понимается так же, как ISO', () => {
    const sqlite = summarize(status(), [chat({ lastCheckedAt: '2026-09-16 13:20:49' })], { now: NOW, staleHours: 1 });
    expect(sqlite.problems).toEqual([]);
    const iso = summarize(status(), [chat({ lastCheckedAt: '2026-09-16T13:20:49Z' })], { now: NOW, staleHours: 1 });
    expect(iso.problems).toEqual([]);
  });

  it('пустой и битый ответ не роняют отчёт', () => {
    const s = summarize(null, null, { now: NOW });
    expect(s.ok).toBe(true);
    expect(s.chats).toBe(0);
    expect(s.lines.join('\n')).toContain('cron-сборщик: ВЫКЛЮЧЕН');
  });
});

describe('summarize: что считается проблемой', () => {
  it('ошибка чата (markup_changed) — проблема по умолчанию', () => {
    const s = summarize(status(), [chat({ lastError: 'markup_changed? (страница 200, но контейнеров сообщений нет)', errorCount: 1 })], { now: NOW });
    expect(s.ok).toBe(false);
    expect(s.problems[0]).toMatchObject({ kind: 'errors' });
    expect(s.problems[0]!.text).toContain('markup_changed');
  });

  it('чат выключен сборщиком после ошибок подряд — проблема disabled', () => {
    const s = summarize(status(), [chat({ enabled: false, lastError: 'chat not found (404)', errorCount: 3 })], { now: NOW });
    expect(s.ok).toBe(false);
    expect(s.problems.map((p) => p.kind)).toEqual(['disabled']);
    expect(s.problems[0]!.text).toContain('включите обратно');
  });

  it('INGEST_TOKEN не задан — проблема, но падает только с --fail-on token', () => {
    const s = summarize(status({ ingestTokenSet: false }), [chat()], { now: NOW });
    expect(s.problems.map((p) => p.kind)).toEqual(['token']);
    expect(s.ok).toBe(true); // по умолчанию fail-on errors,disabled
    const strict = summarize(status({ ingestTokenSet: false }), [chat()], { now: NOW, failOn: 'token' });
    expect(strict.ok).toBe(false);
    expect(strict.lines.join('\n')).toContain('ВЫКЛЮЧЕН (нет INGEST_TOKEN)');
  });

  it('чат давно не проверяли — stale (порог настраивается)', () => {
    const stale = summarize(status(), [chat({ lastCheckedAt: '2026-09-16 04:00:00' })], { now: NOW, failOn: 'stale' });
    expect(stale.problems.map((p) => p.kind)).toEqual(['stale']);
    expect(stale.problems[0]!.text).toContain('не проверяли 10 ч');
    expect(stale.ok).toBe(false);

    const fresh = summarize(status(), [chat({ lastCheckedAt: '2026-09-16 13:20:49' })], { now: NOW, staleHours: 6, failOn: 'stale' });
    expect(fresh.ok).toBe(true);
    expect(DEFAULT_STALE_HOURS).toBe(6);
  });

  it('ещё не проверявшийся чат — не stale, а пометка в строке', () => {
    const s = summarize(status(), [chat({ lastCheckedAt: null })], { now: NOW, failOn: 'stale' });
    expect(s.ok).toBe(true);
    expect(s.lines.join('\n')).toContain('ещё не проверялся');
  });

  it('квота ИИ выбрана — предупреждение, сбор продолжается правилами', () => {
    const s = summarize(status({ ai: { collectUsedToday: 20, collectLimit: 20, collectLeft: 0, ingestLeft: 0 } }), [chat()], { now: NOW });
    expect(s.ok).toBe(true);
    expect(s.warnings.map((w) => w.kind)).toEqual(['quota', 'quota']);
    expect(s.warnings[0]!.text).toContain('только правилами');
  });

  it('прогон прошёл, а заявок нет — предупреждение empty', () => {
    const s = summarize(status({
      lastReport: { startedAt: '2026-09-16T13:20:49Z', totals: { chats: 2, fetched: 4, new: 4, created: 0, duplicate: 0, skipped: 4, errors: 0 } },
    }), [chat()], { now: NOW });
    expect(s.warnings.map((w) => w.kind)).toEqual(['empty']);
    expect(s.warnings[0]!.text).toContain('не создал ни одной заявки');
  });

  it('dry run прогона помечен в отчёте', () => {
    const s = summarize(status({ lastReport: { startedAt: '2026-09-16T13:20:49Z', dryRun: true, totals: null } }), [chat()], { now: NOW });
    expect(s.lines.join('\n')).toContain('(dry run)');
  });

  it('прогона ещё не было — так и написано', () => {
    const s = summarize(status({ lastReport: null }), [chat()], { now: NOW });
    expect(s.lines.join('\n')).toContain('ещё не запускался');
  });
});

describe('formatReport: то, что видит дежурный', () => {
  it('здоровый отчёт', () => {
    const text = formatReport(summarize(status(), [chat(), chat({ username: 'durov' })], { now: NOW }));
    expect(text).toContain('Авто-сбор объявлений: состояние на');
    expect(text).toContain('Всё в порядке (2 чата в обходе).');
    expect(text).not.toContain('Проблемы:');
  });

  it('проблемы и предупреждения — отдельными блоками, с кодами видов', () => {
    const text = formatReport(summarize(
      status({ ai: { collectUsedToday: 20, collectLimit: 20, collectLeft: 0, ingestLeft: 5 } }),
      [chat({ lastError: 'blocked: капча', errorCount: 2 })],
      { now: NOW },
    ));
    expect(text).toContain('Предупреждения:');
    expect(text).toContain('! Дневная квота ИИ сборщика выбрана');
    expect(text).toContain('Проблемы:');
    expect(text).toContain('× [errors] drivers_pl_by: blocked: капча');
    expect(text).toContain('Нужно вмешательство: 1 проблема из списка --fail-on errors,disabled.');
  });

  it('склонение числа проблем', () => {
    const chats = [
      chat({ username: 'a', lastError: 'e1' }),
      chat({ username: 'b', lastError: 'e2' }),
      chat({ username: 'c', lastError: 'e3' }),
    ];
    expect(formatReport(summarize(status(), chats, { now: NOW }))).toContain('3 проблемы');
    expect(formatReport(summarize(status(), chats.slice(0, 1), { now: NOW }))).toContain('1 проблема');
  });
});

describe('fetchState: поход на сервер', () => {
  function stubFetch(statusBody: unknown, chatsBody: unknown, codes: [number, number] = [200, 200]) {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = (async (url: string, init: any = {}) => {
      calls.push({ url: String(url), auth: init.headers?.Authorization ?? null });
      const i = calls.length - 1;
      const body = i === 0 ? statusBody : chatsBody;
      return {
        status: codes[i] ?? 200,
        ok: (codes[i] ?? 200) < 400,
        json: async () => body,
      };
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it('забирает статус и список чатов с админским токеном', async () => {
    const { fetchImpl, calls } = stubFetch(status(), { chats: [chat()] });
    const state = await fetchState('https://pop-utka.app/', 'secret', fetchImpl);
    expect(state.chats).toHaveLength(1);
    expect(state.status.enabled).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      'https://pop-utka.app/api/admin/collect/status',
      'https://pop-utka.app/api/admin/watch-chats',
    ]);
    expect(calls[0]!.auth).toBe('Bearer secret');
  });

  it('401 — понятная ошибка про токен', async () => {
    const { fetchImpl } = stubFetch({ error: 'unauthorized' }, {}, [401, 401]);
    await expect(fetchState('https://pop-utka.app', 'wrong', fetchImpl)).rejects.toThrow('401: неверный ADMIN_API_TOKEN');
  });

  it('без URL — ошибка, а не запрос в никуда', async () => {
    await expect(fetchState('', 'x', fetch)).rejects.toThrow('не задан --url');
  });

  it('недоступный watch-chats не ломает отчёт (статус важнее)', async () => {
    const { fetchImpl } = stubFetch(status(), {}, [200, 500]);
    const state = await fetchState('https://pop-utka.app', 'secret', fetchImpl);
    expect(state.chats).toEqual([]);
  });
});
