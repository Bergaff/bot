import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  MAX_TEXT_LENGTH,
  cascade,
  ingestMessage,
  ingestMessages,
  isSeen,
  parseMessageDate,
  rulesFields,
  collectorSource,
  extensionSource,
  normalizeAt,
  type IngestOptions,
  type IngestSource,
} from '../src/ingest';
import { createListing, getListingById, getSeenListing, updateListingStatus } from '../src/store';
import { createLocalEnv } from '../local/sqlite-env';
import type { Env, Listing } from '../src/types';
import type { AiFields } from '../src/ai';

const NOW = new Date('2026-09-15T12:00:00Z');

const OFFER = '25.09 Варшава — Брест, возьму посылку до 20 кг, +48 579 264 254';
const REQUEST = 'Нужно передать документы из Кракова в Минск завтра, до 2 кг, @sergei_i';
/** Другой маршрут, дата и контакт — чтобы не сработала дедупликация по смыслу. */
const OFFER_OTHER = '28.09 Гродно — Варшава, возьму посылку до 15 кг, @petr_g';
const CHATTER = 'Всем привет! Как дела?';
const PASSENGER = 'Кто подвезёт пассажира из Гродно в Минск сегодня вечером?';

/** Источник-заглушка: публичный чат сборщика. */
function src(overrides: Partial<IngestSource> = {}): IngestSource {
  return {
    chatId: 'web:drivers_pl_by',
    chatTitle: 'Водители Польша–Беларусь',
    messageId: 12345,
    chatUrl: 'https://t.me/drivers_pl_by',
    origin: 'collector',
    ...overrides,
  };
}

/** Сколько уведомлений ушло админам. */
function trackingNotify() {
  const notified: Listing[] = [];
  return {
    notified,
    notify: async (_env: Env, listing: Listing) => { notified.push(listing); },
  };
}

describe('ingestMessage: создание заявки', () => {
  let env: Env & { close: () => void };
  beforeEach(() => { env = createLocalEnv({ dbPath: ':memory:' }); });

  it('объявление → заявка pending с полным набором полей источника', async () => {
    const { notified, notify } = trackingNotify();
    const res = await ingestMessage(env, OFFER, src(), { notifyAdmins: notify, now: NOW });

    expect(res.status).toBe('created');
    expect(res.listings).toHaveLength(1);
    const l = res.listings[0]!;
    expect(l).toMatchObject({
      type: 'offer',
      fromCity: 'Варшава',
      toCity: 'Брест',
      status: 'pending',
      source: 'telegram',
      sourceChat: 'Водители Польша–Беларусь',
      sourceChatId: 'web:drivers_pl_by',
      sourceMessageId: 12345,
      origin: 'collector',
    });
    expect(l.phone).toContain('48');
    // 7. уведомление админам — на каждую созданную заявку
    expect(notified).toHaveLength(1);
    expect(notified[0]!.id).toBe(l.id);
  });

  it('AUTO_APPROVE=1 на собранные заявки не влияет — всегда pending', async () => {
    const approve = createLocalEnv({ dbPath: ':memory:', vars: { AUTO_APPROVE: '1' } });
    const res = await ingestMessage(approve, OFFER, src(), { now: NOW });
    expect(res.listings[0]!.status).toBe('pending');
    approve.close();
  });

  it('origin пробрасывается: extension и bot', async () => {
    const a = await ingestMessage(env, OFFER, src({ origin: 'extension', chatId: 'ext:-100123', messageId: 1 }), { now: NOW });
    const b = await ingestMessage(env, REQUEST, src({ origin: 'bot', chatId: '-100999', messageId: 2 }), { now: NOW });
    expect(a.listings[0]!.origin).toBe('extension');
    expect(b.listings[0]!.origin).toBe('bot');
  });

  it('один текст → несколько заявок (каскад вернул 2 направления), уведомление на каждую', async () => {
    const { notified, notify } = trackingNotify();
    const fields: AiFields[] = [
      { ...rulesFields({ intent: 'offer', fromCity: 'Варшава', toCity: 'Брест', departureDate: null, weightKg: null, price: null, telegram: null, phone: null, confidence: 0.9 }, OFFER) },
      { ...rulesFields({ intent: 'offer', fromCity: 'Брест', toCity: 'Варшава', departureDate: null, weightKg: null, price: null, telegram: null, phone: null, confidence: 0.9 }, OFFER) },
    ];
    const res = await ingestMessage(env, OFFER, src(), {
      notifyAdmins: notify,
      cascade: async () => ({ list: fields, source: 'parser' }),
      now: NOW,
    });
    expect(res.listings).toHaveLength(2);
    expect(res.listings.every((l) => l.status === 'pending')).toBe(true);
    expect(res.source).toBe('parser');
    expect(notified).toHaveLength(2);
    // tg_seen указывает на первую созданную заявку
    expect(await getSeenListing(env, 'web:drivers_pl_by', 12345)).toBe(res.listings[0]!.id);
  });

  it('контакт — автор сообщения, если в тексте контакта нет', async () => {
    const res = await ingestMessage(env, 'Завтра Варшава — Минск, есть место для передачи', src({
      authorUsername: '@adelina_y',
      origin: 'extension',
      chatId: 'ext:-1001',
    }), { now: NOW });
    expect(res.listings[0]!.telegram).toBe('@adelina_y');
  });

  it('свой контакт в тексте важнее автора сообщения', async () => {
    const res = await ingestMessage(env, OFFER + ' , писать @driver_one', src({ authorUsername: '@someone_else' }), { now: NOW });
    expect(res.listings[0]!.telegram).toBe('@driver_one');
  });

  it('chatUrl сохраняется в chat_links — источник кликабелен на сайте', async () => {
    await ingestMessage(env, OFFER, src(), { now: NOW });
    const row = (await env.DB.prepare('SELECT url FROM chat_links WHERE chat_id = ?').bind('web:drivers_pl_by').first()) as { url?: string };
    expect(row?.url).toBe('https://t.me/drivers_pl_by');
  });
});

describe('ingestMessage: дедупликация через tg_seen', () => {
  let env: Env & { close: () => void };
  beforeEach(() => { env = createLocalEnv({ dbPath: ':memory:' }); });

  it('повторный messageId → duplicate + id существующей заявки, ИИ не вызываем', async () => {
    const first = await ingestMessage(env, OFFER, src(), { now: NOW });
    expect(first.status).toBe('created');

    const cascadeSpy = vi.fn(async () => ({ list: [] as AiFields[], source: 'telegram' as const }));
    const second = await ingestMessage(env, OFFER, src(), { cascade: cascadeSpy, now: NOW });
    expect(second.status).toBe('duplicate');
    expect(second.existingListingId).toBe(first.listings[0]!.id);
    expect(second.listings).toEqual([]);
    // защита от дублей срабатывает ДО каскада — иначе дубли жгли бы квоту ИИ
    expect(cascadeSpy).not.toHaveBeenCalled();

    const count = (await env.DB.prepare('SELECT COUNT(*) AS n FROM listings').first()) as { n: number };
    expect(count.n).toBe(1);
  });

  it('тот же текст из ДРУГОГО чата: tg_seen не срабатывает, но ловит дедупликация по смыслу', async () => {
    const first = await ingestMessage(env, OFFER, src({ chatId: 'web:drivers_pl_by', messageId: 7 }), { now: NOW });
    expect(first.status).toBe('created');

    // ключ tg_seen другой (ext:-100555:7), а объявление то же самое — вторая заявка не нужна
    const other = await ingestMessage(env, OFFER, src({ chatId: 'ext:-100555', messageId: 7, origin: 'extension' }), { now: NOW });
    expect(other.status).toBe('duplicate');
    expect(other.listings).toEqual([]);
    expect(other.duplicateOf).toEqual([first.listings[0]!.id]);
    expect(other.existingListingId).toBe(first.listings[0]!.id);
    expect(other.duplicateWhy!.length).toBeGreaterThan(0);

    // проверку можно отключить (например, модератор знает, что это другой человек)
    const forced = await ingestMessage(env, OFFER, src({ chatId: 'ext:-100555', messageId: 8, origin: 'extension' }), {
      now: NOW,
      findDuplicate: null,
    });
    expect(forced.status).toBe('created');
  });

  it('один и тот же messageId в разных чатах — не дубль', async () => {
    await ingestMessage(env, OFFER, src({ chatId: 'web:chat_one', messageId: 42 }), { now: NOW });
    const other = await ingestMessage(env, REQUEST, src({ chatId: 'web:chat_two', messageId: 42 }), { now: NOW });
    expect(other.status).toBe('created');
  });

  it('без messageId (пересылка в личку): tg_seen молчит, повтор ловит сравнение по смыслу', async () => {
    const a = await ingestMessage(env, OFFER, src({ messageId: null }), { now: NOW });
    const b = await ingestMessage(env, OFFER, src({ messageId: null }), { now: NOW });
    expect(a.status).toBe('created');
    expect(b.status).toBe('duplicate');
    expect(b.existingListingId).toBe(a.listings[0]!.id);
  });

  it('откат tg_seen при ошибке создания: сообщение можно обработать повторно', async () => {
    const boom = async () => { throw new Error('D1 is down'); };
    const failed = await ingestMessage(env, OFFER, src(), { createListing: boom as unknown as typeof createListing, now: NOW });
    expect(failed.status).toBe('invalid');
    expect(failed.reason).toBe('bad_payload');
    expect(failed.listings).toEqual([]);
    expect(await isSeen(env, 'web:drivers_pl_by', 12345)).toBe(false);

    // повторная доставка создаёт заявку (а не отвечает duplicate)
    const retry = await ingestMessage(env, OFFER, src(), { now: NOW });
    expect(retry.status).toBe('created');
  });

  it('ошибка на второй заявке: первую не откатываем (иначе повтор даст дубль)', async () => {
    let calls = 0;
    const flaky = async (e: Env, input: Parameters<typeof createListing>[1]) => {
      calls++;
      if (calls === 2) throw new Error('quota');
      return createListing(e, input);
    };
    const fields: AiFields[] = [
      rulesFields({ intent: 'offer', fromCity: 'Варшава', toCity: 'Брест', departureDate: null, weightKg: null, price: null, telegram: null, phone: null, confidence: 0.9 }, OFFER),
      rulesFields({ intent: 'offer', fromCity: 'Брест', toCity: 'Варшава', departureDate: null, weightKg: null, price: null, telegram: null, phone: null, confidence: 0.9 }, OFFER),
    ];
    const res = await ingestMessage(env, OFFER, src(), {
      createListing: flaky as unknown as typeof createListing,
      cascade: async () => ({ list: fields, source: 'parser' }),
      now: NOW,
    });
    expect(res.status).toBe('created');
    expect(res.listings).toHaveLength(1);
    expect(res.error).toContain('quota');
    expect(await isSeen(env, 'web:drivers_pl_by', 12345)).toBe(true);
  });

  it('ошибка в каскаде — tg_seen тоже откатываем', async () => {
    const res = await ingestMessage(env, OFFER, src(), {
      cascade: async () => { throw new Error('AI exploded'); },
      now: NOW,
    });
    expect(res.status).toBe('invalid');
    expect(await isSeen(env, 'web:drivers_pl_by', 12345)).toBe(false);
  });
});

describe('ingestMessage: отсев', () => {
  let env: Env & { close: () => void };
  beforeEach(() => { env = createLocalEnv({ dbPath: ':memory:' }); });

  it('пассажирская попутка → skipped:passenger, в tg_seen не пишем', async () => {
    const res = await ingestMessage(env, PASSENGER, src(), { now: NOW });
    expect(res).toMatchObject({ status: 'skipped', reason: 'passenger' });
    expect(res.listings).toEqual([]);
    expect(await isSeen(env, 'web:drivers_pl_by', 12345)).toBe(false);
  });

  it('болтовня → skipped:no_intent, но сообщение помечено обработанным', async () => {
    const res = await ingestMessage(env, CHATTER, src(), { now: NOW });
    expect(res).toMatchObject({ status: 'skipped', reason: 'no_intent' });
    // повторно это сообщение не обрабатываем (ТЗ п. 2.1.5)
    expect(await isSeen(env, 'web:drivers_pl_by', 12345)).toBe(true);

    const again = await ingestMessage(env, CHATTER, src(), { now: NOW });
    expect(again.status).toBe('duplicate');
  });

  it('пустой текст → invalid, слишком длинный → skipped:too_long', async () => {
    expect(await ingestMessage(env, '', src(), { now: NOW })).toMatchObject({ status: 'invalid', reason: 'bad_payload' });
    expect(await ingestMessage(env, '   ', src({ messageId: 1 }), { now: NOW })).toMatchObject({ status: 'invalid' });
    const long = 'посылка '.repeat(700);
    expect(long.length).toBeGreaterThan(MAX_TEXT_LENGTH);
    expect(await ingestMessage(env, long, src({ messageId: 2 }), { now: NOW }))
      .toMatchObject({ status: 'skipped', reason: 'too_long' });
  });

  it('короче 10 символов → skipped:too_short (как в групповых сообщениях бота)', async () => {
    expect(await ingestMessage(env, 'ок', src(), { now: NOW })).toMatchObject({ status: 'skipped', reason: 'too_short' });
  });

  it('старое сообщение → skipped:too_old (maxAgeDays варианта A = 7)', async () => {
    const old = new Date(NOW.getTime() - 10 * 86400_000).toISOString();
    const res = await ingestMessage(env, OFFER, src(), { maxAgeDays: 7, date: old, now: NOW });
    expect(res).toMatchObject({ status: 'skipped', reason: 'too_old' });
    expect(await isSeen(env, 'web:drivers_pl_by', 12345)).toBe(false);
  });

  it('свежее сообщение с maxAgeDays проходит', async () => {
    const fresh = new Date(NOW.getTime() - 2 * 86400_000).toISOString();
    const res = await ingestMessage(env, OFFER, src(), { maxAgeDays: 7, date: fresh, now: NOW });
    expect(res.status).toBe('created');
  });

  it('дата unix-секундами и ISO-строкой понимается одинаково', async () => {
    const unix = Math.floor((NOW.getTime() - 86400_000) / 1000);
    expect(await ingestMessage(env, OFFER, src({ messageId: 90 }), { maxAgeDays: 7, date: unix, now: NOW })).toMatchObject({ status: 'created' });
    const oldUnix = Math.floor((NOW.getTime() - 30 * 86400_000) / 1000);
    expect(await ingestMessage(env, OFFER, src({ messageId: 91 }), { maxAgeDays: 7, date: oldUnix, now: NOW })).toMatchObject({ status: 'skipped', reason: 'too_old' });
  });
});

describe('ingestMessage: dryRun', () => {
  let env: Env & { close: () => void };
  beforeEach(() => { env = createLocalEnv({ dbPath: ':memory:' }); });

  it('разбор есть, записей в БД нет', async () => {
    const { notified, notify } = trackingNotify();
    const res = await ingestMessage(env, OFFER, src(), { dryRun: true, notifyAdmins: notify, now: NOW });
    expect(res.status).toBe('created');
    expect(res.listings).toEqual([]);
    expect(res.fields?.[0]).toMatchObject({ type: 'offer', fromCity: 'Варшава', toCity: 'Брест' });
    expect(res.parsed?.confidence).toBeGreaterThanOrEqual(0.7);
    expect(notified).toEqual([]);

    const listings = (await env.DB.prepare('SELECT COUNT(*) AS n FROM listings').first()) as { n: number };
    const seen = (await env.DB.prepare('SELECT COUNT(*) AS n FROM tg_seen').first()) as { n: number };
    const links = (await env.DB.prepare('SELECT COUNT(*) AS n FROM chat_links').first()) as { n: number };
    expect([listings.n, seen.n, links.n]).toEqual([0, 0, 0]);
  });

  it('после dryRun обычный запрос создаёт заявку', async () => {
    await ingestMessage(env, OFFER, src(), { dryRun: true, now: NOW });
    const real = await ingestMessage(env, OFFER, src(), { now: NOW });
    expect(real.status).toBe('created');
    expect(real.listings).toHaveLength(1);
  });

  it('dryRun видит уже обработанное сообщение как duplicate', async () => {
    await ingestMessage(env, OFFER, src(), { now: NOW });
    const res = await ingestMessage(env, OFFER, src(), { dryRun: true, now: NOW });
    expect(res.status).toBe('duplicate');
    expect(res.existingListingId).toBeTruthy();
  });
});

describe('cascade: правила → ИИ', () => {
  it('уверенные правила: ИИ не нужен', async () => {
    const env = createLocalEnv({ dbPath: ':memory:', vars: { AI_API_KEY: 'sk-test' } });
    const res = await cascade(env, OFFER);
    expect(res.source).toBe('telegram');
    expect(res.list[0]).toMatchObject({ type: 'offer', fromCity: 'Варшава', toCity: 'Брест' });
    env.close();
  });

  it('useAi=false: работаем только правилами, даже если ключ ИИ задан', async () => {
    const env = createLocalEnv({ dbPath: ':memory:', vars: { AI_API_KEY: 'sk-test', AI_BASE_URL: 'http://127.0.0.1:1' } });
    const res = await cascade(env, CHATTER, { useAi: false });
    expect(res.list).toEqual([]);
    expect(res.source).toBe('telegram');
    // счётчик ИИ бота не тронут
    expect(await env.KV.get(`ai:day:${new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10)}`)).toBeNull();
    env.close();
  });

  it('счётчики квот у каналов разные: collect не трогает ai:day (бюджет бота)', async () => {
    const env = createLocalEnv({ dbPath: ':memory:' });
    await env.KV.put('ai:collect:day:2026-09-15', '7', { expirationTtl: 172800 });
    expect(await env.KV.get('ai:day:2026-09-15')).toBeNull();
    expect(await env.KV.get('ai:collect:day:2026-09-15')).toBe('7');
    expect(await env.KV.get('ai:ingest:day:2026-09-15')).toBeNull();
    env.close();
  });
});

describe('ingestMessages: порядок обработки', () => {
  it('внутри chatId — по возрастанию messageId', async () => {
    const env = createLocalEnv({ dbPath: ':memory:' });
    const order: number[] = [];
    await ingestMessages(env, [
      // тексты разные: иначе второе «то же» объявление поймает дедупликация по смыслу
      { text: OFFER, src: src({ messageId: 300 }) },
      { text: OFFER_OTHER, src: src({ messageId: 100 }) },
      { text: REQUEST, src: src({ messageId: 200 }) },
    ], {
      now: NOW,
      notifyAdmins: async (_e, l) => { order.push(Number(l.sourceMessageId)); },
    });
    expect(order).toEqual([100, 200, 300]);
    env.close();
  });
});

describe('ingestMessage: дубликаты по смыслу (src/dedupe.ts)', () => {
  let env: Env & { close: () => void };
  beforeEach(() => { env = createLocalEnv({ dbPath: ':memory:' }); });

  /** То же объявление, но другое сообщение: так водитель пишет каждый день. */
  const SAME_AD_OTHER_DAY = '25.09 Варшава — Брест, возьму посылку до 20 кг, +48 579 264 254';

  it('то же объявление другим messageId — вторая заявка не создаётся', async () => {
    const first = await ingestMessage(env, OFFER, src({ messageId: 1001 }), { now: NOW });
    expect(first.status).toBe('created');

    const second = await ingestMessage(env, SAME_AD_OTHER_DAY, src({ messageId: 1002 }), { now: NOW });
    expect(second.status).toBe('duplicate');
    expect(second.listings).toEqual([]);
    expect(second.duplicateOf).toEqual([first.listings[0]!.id]);
    expect(second.duplicateWhy!.length).toBeGreaterThan(0);

    const count = (await env.DB.prepare('SELECT COUNT(*) AS n FROM listings').first()) as { n: number };
    expect(count.n).toBe(1);
    // сообщение при этом обработано: повторная доставка не будет дёргать конвейер
    expect(await isSeen(env, 'web:drivers_pl_by', 1002)).toBe(true);
    // ссылка «уже обработано» ведёт на существующую карточку
    expect(await getSeenListing(env, 'web:drivers_pl_by', 1002)).toBe(first.listings[0]!.id);
  });

  it('дубль освежает опубликованную заявку — она снова наверху доски', async () => {
    const first = await ingestMessage(env, OFFER, src({ messageId: 2001 }), { now: NOW });
    const id = first.listings[0]!.id;
    await updateListingStatus(env, id, 'published');
    await env.DB.prepare("UPDATE listings SET published_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(id).run();

    const second = await ingestMessage(env, SAME_AD_OTHER_DAY, src({ messageId: 2002 }), { now: NOW });
    expect(second.status).toBe('duplicate');
    const after = await getListingById(env, id);
    expect(after?.publishedAt).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('похожая, но не та же заявка (similar) — создаём и возвращаем similarTo', async () => {
    const stub = (async () => ({
      listing: { id: 'another-listing' } as Listing,
      kind: 'similar' as const,
      why: 'маршрут и дата совпали, а контакт другой',
    })) as unknown as NonNullable<IngestOptions['findDuplicate']>;
    const res = await ingestMessage(env, OFFER, src({ messageId: 3001 }), { now: NOW, findDuplicate: stub });
    expect(res.status).toBe('created');
    expect(res.listings).toHaveLength(1);
    expect(res.similarTo).toEqual({ id: 'another-listing', why: 'маршрут и дата совпали, а контакт другой' });
  });

  it('ссылка на чат сохраняется, даже если сообщение оказалось дублем', async () => {
    const first = await ingestMessage(env, OFFER, src({ messageId: 4001, chatUrl: 'https://t.me/drivers_pl_by' }), { now: NOW });
    expect(first.status).toBe('created');
    // тот же текст из ДРУГОГО публичного чата со своей ссылкой
    const second = await ingestMessage(env, SAME_AD_OTHER_DAY, src({
      chatId: 'web:posylki_pl_by', chatUrl: 'https://t.me/posylki_pl_by', messageId: 4002,
    }), { now: NOW });
    expect(second.status).toBe('duplicate');
    const row = (await env.DB.prepare('SELECT url FROM chat_links WHERE chat_id = ?').bind('web:posylki_pl_by').first()) as { url?: string };
    expect(row?.url).toBe('https://t.me/posylki_pl_by');
  });

  it('ошибка проверки дубля не роняет обработку — заявку создаём', async () => {
    const boom = (async () => { throw new Error('D1 is down'); }) as unknown as NonNullable<IngestOptions['findDuplicate']>;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await ingestMessage(env, OFFER, src({ messageId: 5001 }), { now: NOW, findDuplicate: boom });
    errSpy.mockRestore();
    expect(res.status).toBe('created');
    expect(res.listings).toHaveLength(1);
  });
});

describe('parseMessageDate', () => {
  it('unix-секунды, миллисекунды, ISO, мусор', () => {
    expect(parseMessageDate(1789000000)?.toISOString()).toBe('2026-09-10T00:26:40.000Z');
    expect(parseMessageDate(1789000000000)?.toISOString()).toBe('2026-09-10T00:26:40.000Z');
    expect(parseMessageDate('2026-09-15T12:00:00Z')?.toISOString()).toBe('2026-09-15T12:00:00.000Z');
    expect(parseMessageDate('1789000000')?.toISOString()).toBe('2026-09-10T00:26:40.000Z');
    expect(parseMessageDate('не дата')).toBeNull();
    expect(parseMessageDate(null)).toBeNull();
    expect(parseMessageDate(undefined)).toBeNull();
    expect(parseMessageDate(-5)).toBeNull();
  });
});

describe('помощники источника', () => {
  it('collectorSource: web:<username> и ссылка на чат', () => {
    expect(collectorSource('durov', { messageId: 528, title: 'Pavel Durov', author: 'Pavel' })).toEqual({
      chatId: 'web:durov',
      chatTitle: 'Pavel Durov',
      messageId: 528,
      chatUrl: 'https://t.me/durov',
      authorName: 'Pavel',
      origin: 'collector',
    });
  });

  it('extensionSource: приватный чат ext:* без ссылки', () => {
    const s = extensionSource({ chatId: 'ext:-100123', messageId: 7, authorUsername: 'user_name' });
    expect(s.chatId).toBe('ext:-100123');
    expect(s.chatUrl).toBeNull();
    expect(s.authorUsername).toBe('@user_name');
  });

  it('normalizeAt', () => {
    expect(normalizeAt('user')).toBe('@user');
    expect(normalizeAt('@user')).toBe('@user');
    expect(normalizeAt('https://t.me/user')).toBe('@user');
    expect(normalizeAt('')).toBeNull();
    expect(normalizeAt('не юзернейм!')).toBeNull();
  });
});
