/**
 * Тесты разведки чатов перед обкаткой (этап 7, ТЗ п. 3.7):
 * scripts/probe-chats.mjs.
 *
 * Сеть подменяется заглушкой на фикстурах tests/fixtures — те же страницы,
 * что увидит скрипт на живом t.me/s/.
 */
import { describe, expect, it, vi } from 'vitest';
import { formatProbeReport, probeChat, probeChats, recommend } from '../scripts/probe-chats.mjs';
import { FIXTURES } from './fixtures';

const RECENT = new Date('2026-09-15T12:00:00Z');

/** fetch-заглушка: одна и та же страница на любой запрос. */
function stub(html: string, status = 200): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: any) => {
    calls.push(String(input));
    if (html === 'THROW') throw new TypeError('fetch failed');
    return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Разметка пассажирского чата (в фикстурах такого нет). */
function passengerHtml(): string {
  const msg = (id: number, text: string, when: string) => `<div class="tgme_widget_message_wrap">
    <div class="tgme_widget_message" data-post="poputchiki/${id}">
      <div class="tgme_widget_message_text">${text}</div>
      <a class="tgme_widget_message_date" href="https://t.me/poputchiki/${id}">
        <time datetime="${when}">10:00</time></a>
    </div></div>`;
  return [
    msg(11, 'Кто подвезёт пассажира из Гродно в Минск сегодня вечером?', '2026-09-15T10:00:00+00:00'),
    msg(12, 'Ищу попутку до Варшавы, два человека, завтра утром.', '2026-09-15T11:00:00+00:00'),
  ].join('\n');
}

describe('пригодный чат', () => {
  it('супергруппа с объявлениями: добавлять, тип supergroup', async () => {
    const { fetchImpl, calls } = stub(FIXTURES.supergroup());
    const r = await probeChat('drivers_pl_by', { fetchImpl, now: RECENT });

    expect(r.verdict).toBe('ok');
    expect(r.status).toBe(200);
    expect(r.username).toBe('drivers_pl_by');
    expect(r.title).toBe('Водители Польша–Беларусь');
    expect(r.messages).toBe(3);
    expect(r.maxId).toBe(9004);
    expect(r.listings).toBe(3);
    expect(r.passenger).toBe(0);
    expect(r.authorShare).toBe(1);
    expect(r.kind).toBe('supergroup');
    expect(r.recommendation).toBe('добавлять');
    expect(calls[0]).toBe('https://t.me/s/drivers_pl_by');
    expect(r.notes.join('\n')).toContain('3 объявления правилами');
  });

  it('юзеньюм достаётся из ссылки и из @username', async () => {
    const { fetchImpl } = stub(FIXTURES.supergroup());
    for (const raw of ['https://t.me/s/drivers_pl_by', '@drivers_pl_by', 't.me/drivers_pl_by']) {
      const r = await probeChat(raw, { fetchImpl, now: RECENT });
      expect(r.username).toBe('drivers_pl_by');
      expect(r.verdict).toBe('ok');
    }
  });

  it('канал без объявлений: читать можно, но выход нулевой — «проверить вручную»', async () => {
    const { fetchImpl } = stub(FIXTURES.channel());
    const r = await probeChat('durov', { fetchImpl, now: new Date('2026-07-20T12:00:00Z') });
    expect(r.verdict).toBe('ok');
    expect(r.kind).toBe('channel');
    expect(r.authorShare).toBe(0);
    expect(r.listings).toBe(0);
    expect(r.chatter).toBe(3);
    expect(r.recommendation).toBe('проверить вручную');
    expect(r.notes.join('\n')).toContain('Объявлений на последней странице нет');
  });

  it('пассажирский чат: доска такое не публикует — не добавлять', async () => {
    const { fetchImpl } = stub(passengerHtml());
    const r = await probeChat('poputchiki', { fetchImpl, now: RECENT });
    expect(r.verdict).toBe('ok');
    expect(r.passenger).toBe(2);
    expect(r.listings).toBe(0);
    expect(r.recommendation).toBe('не добавлять');
    expect(r.notes.join('\n')).toContain('пассажирские попутки');
  });

  it('--deep проверяет пагинацию ?before=', async () => {
    const { fetchImpl, calls } = stub(FIXTURES.supergroup());
    const r = await probeChat('drivers_pl_by', { fetchImpl, now: RECENT, deep: true });
    expect(r.pagination).toMatchObject({ before: 9001, status: 200, verdict: 'ok', messages: 3 });
    expect(calls[1]).toContain('before=9001');
    expect(r.notes.join('\n')).toContain('Пагинация ?before=9001 работает');
  });

  it('без --deep второй запрос не делается', async () => {
    const { fetchImpl, calls } = stub(FIXTURES.supergroup());
    await probeChat('drivers_pl_by', { fetchImpl, now: RECENT });
    expect(calls).toHaveLength(1);
  });
});

describe('непригодные чаты', () => {
  it('404 → http_404', async () => {
    const { fetchImpl } = stub(FIXTURES.missing(), 404);
    const r = await probeChat('gone_channel', { fetchImpl, now: RECENT });
    expect(r.verdict).toBe('http_404');
    expect(r.recommendation).toBe('не добавлять');
    expect(r.notes.join('\n')).toContain('Ответ 404');
  });

  it('заглушка «чат не найден» при 200 → missing (приватный/удалённый)', async () => {
    const { fetchImpl } = stub(FIXTURES.missing());
    const r = await probeChat('private_chat', { fetchImpl, now: RECENT });
    expect(r.verdict).toBe('missing');
    expect(r.recommendation).toBe('не добавлять');
    expect(r.notes.join('\n')).toContain('приватный');
  });

  it('капча/бан-стена → blocked, «проверить вручную»', async () => {
    const { fetchImpl } = stub(FIXTURES.blocked());
    const r = await probeChat('capped_chat', { fetchImpl, now: RECENT });
    expect(r.verdict).toBe('blocked');
    expect(r.recommendation).toBe('проверить вручную');
    expect(r.notes.join('\n')).toContain('капчу');
  });

  it('чужая разметка → markup_changed: сначала чиним парсер', async () => {
    const { fetchImpl } = stub('<html><body><div class="brand_new">Telegram поменял вёрстку</div></body></html>');
    const r = await probeChat('new_markup', { fetchImpl, now: RECENT });
    expect(r.verdict).toBe('markup_changed');
    expect(r.recommendation).toBe('не добавлять');
    expect(r.notes.join('\n')).toContain('src/preview-html.ts');
  });

  it('сеть не отвечает → network', async () => {
    const { fetchImpl } = stub('THROW');
    // fetchPreview() логирует причину — в тесте это шум
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await probeChat('unreachable', { fetchImpl, now: RECENT });
    spy.mockRestore();
    expect(r.verdict).toBe('network');
    expect(r.status).toBe(0);
    expect(r.recommendation).toBe('проверить вручную');
  });

  it('мусор вместо юзернейма → bad_username, запрос не уходит', async () => {
    const { fetchImpl, calls } = stub(FIXTURES.channel());
    for (const raw of ['не юзернейм!', '@ab', 'https://example.com/xxx', '']) {
      const r = await probeChat(raw, { fetchImpl, now: RECENT });
      expect(r.verdict).toBe('bad_username');
      expect(r.recommendation).toBe('не добавлять');
    }
    expect(calls).toHaveLength(0);
  });

  it('мёртвый чат: последнее сообщение старше 30 дней', async () => {
    const { fetchImpl } = stub(FIXTURES.supergroup());
    const r = await probeChat('drivers_pl_by', { fetchImpl, now: new Date('2027-09-15T12:00:00Z') });
    expect(r.verdict).toBe('ok');
    expect(r.newestAgeDays).toBeGreaterThan(30);
    expect(r.recommendation).toBe('не добавлять');
    expect(r.notes.join('\n')).toContain('мёртвый');
  });

  it('зеркало превью (--base-url) используется для всех запросов', async () => {
    const { fetchImpl, calls } = stub(FIXTURES.supergroup());
    await probeChat('drivers_pl_by', { fetchImpl, now: RECENT, baseUrl: 'http://127.0.0.1:8899/s', deep: true });
    expect(calls[0]).toBe('http://127.0.0.1:8899/s/drivers_pl_by');
    expect(calls[1]).toBe('http://127.0.0.1:8899/s/drivers_pl_by?before=9001');
    // ссылка в отчёте остаётся настоящей — её дают админу
    expect((await probeChat('drivers_pl_by', { fetchImpl, now: RECENT, baseUrl: 'http://127.0.0.1:8899/s' })).url)
      .toBe('https://t.me/s/drivers_pl_by');
  });
});

describe('вывод разведки', () => {
  it('recommend() — чистая функция: по разбору страницы даёт вердикт', () => {
    expect(recommend({ verdict: 'ok', listings: 2, worthAi: 0, passenger: 0, chatter: 1, messages: 3, authorShare: 0.8, kindHint: 'supergroup', newestAgeDays: 1 }).recommendation).toBe('добавлять');
    expect(recommend({ verdict: 'ok', listings: 0, worthAi: 3, passenger: 0, chatter: 0, messages: 3, authorShare: 0, kindHint: 'channel', newestAgeDays: 1 }).recommendation).toBe('добавлять');
    expect(recommend({ verdict: 'ok', listings: 0, worthAi: 0, passenger: 0, chatter: 3, messages: 3, authorShare: 0, kindHint: 'channel', newestAgeDays: 1 }).recommendation).toBe('проверить вручную');
    expect(recommend({ verdict: 'missing' }).recommendation).toBe('не добавлять');
  });

  it('в отчёте есть вердикт, цифры и готовая команда добавления', async () => {
    // маршрутизирующая заглушка: один чат живой, второй — 404
    const fetchImpl = (async (input: any) => {
      const url = String(input);
      if (url.includes('gone_channel')) return new Response(FIXTURES.missing(), { status: 404 });
      return new Response(FIXTURES.supergroup(), { status: 200, headers: { 'Content-Type': 'text/html' } });
    }) as unknown as typeof fetch;
    const results = await probeChats(['drivers_pl_by', 'gone_channel'], { fetchImpl, now: RECENT, delayMs: 0 });
    expect(results).toHaveLength(2);
    expect(results[1]!.verdict).toBe('http_404');

    const text = formatProbeReport(results);
    expect(text).toContain('drivers_pl_by — ДОБАВЛЯТЬ');
    expect(text).toContain('gone_channel');
    expect(text).toContain('"username":"drivers_pl_by","kind":"supergroup"');
    expect(text).toContain('Итог: 1 из 2 можно добавлять в обход.');
    // команда добавления — только для пригодных чатов
    expect(text.split('добавить:')).toHaveLength(2);
  });
});
