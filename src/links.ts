import type { ListingOrigin } from './types.ts';

/**
 * Ссылка на исходное сообщение (ТЗ п. 2.3).
 *
 * Ключи чатов-источников живут в трёх мирах:
 *   '-100<id>'      — бот добавлен в супергруппу/канал → служебная t.me/c/<id>[/<рум>]/<msg>
 *   'web:<username>'— серверный сборщик публичных чатов → открытая t.me/<username>/<msg>
 *   'ext:<peer-id>' — приватный чат из браузерного расширения → для супергруппы
 *                     и канала строим служебную t.me/c/<id>/<msg> (открывается
 *                     у участников); для обычных групп и личных чатов ссылки нет,
 *                     если админ не задал её вручную в chat_links
 *
 * Приоритет всегда у chat_links: админ может задать красивую публичную ссылку
 * на любой чат (на сайте её показывает sourceLinkUrl() в public/app.js).
 */
export function listingSourceLink(
  sourceChatId: string | null | undefined,
  sourceMessageId: number | null | undefined,
  chatLinks?: Record<string, string> | null,
  sourceTopicId?: number | null
): string | null {
  if (!sourceChatId) return null;

  // В форум-чате ссылка на сообщение трёхчастная: t.me/<чат>/<рум>/<сообщение>.
  // Без рума ссылка ведёт на весь чат и сообщение не открывается.
  const topic = Number.isInteger(sourceTopicId) && Number(sourceTopicId) > 0
    ? `/${sourceTopicId}`
    : '';
  const msg = sourceMessageId != null ? `/${sourceMessageId}` : '';

  const manual = chatLinks?.[sourceChatId];
  if (manual && manual.trim()) {
    const url = manual.trim().replace(/\/$/, '');
    // К сообщению ведёт только ссылка вида t.me/<username>:
    // пригласительные t.me/+AbC… и служебные t.me/c/<id> так не работают.
    return /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]*$/.test(url) && (msg || topic)
      ? `${url}${topic}${msg}`
      : url;
  }

  // публичный чат из сборщика: web:durov + 528 → https://t.me/durov/528
  // форум-чат: web:travelersminsk + рум 91529 + 713464 → t.me/travelersminsk/91529/713464
  const web = /^web:([A-Za-z][A-Za-z0-9_]*)$/.exec(sourceChatId);
  if (web) return `https://t.me/${web[1]}${topic}${msg}`;

  // приватный чат из расширения: если известен peer-id супергруппы/канала,
  // работает служебная ссылка t.me/c/<id>[/<рум>]/<msg> — она открывается у участников
  // чата (именно её просит модератор: открыть сообщение и переслать самому).
  const ext = /^ext:(-100\d+|-\d+|\d+)$/.exec(sourceChatId);
  if (ext) {
    const peer = ext[1]!;
    const superFromExt = /^-100(\d+)$/.exec(peer);
    if (superFromExt) return `https://t.me/c/${superFromExt[1]}${topic}${msg}`;
    // обычная группа и личный чат служебных ссылок на сообщение не имеют
    return null;
  }
  if (sourceChatId.startsWith('ext:')) return null;

  // супергруппа/канал, где работает бот: id начинается с -100
  const super100 = /^-100(\d+)$/.exec(sourceChatId);
  if (super100) return `https://t.me/c/${super100[1]}${topic}${msg}`;

  return null;
}

/** Ключ чата сборщика для публичного юзернейма: 'durov' → 'web:durov'. */
export function webChatId(username: string): string {
  return `web:${username.trim().replace(/^@/, '')}`;
}

/** Юзернейм из ключа 'web:<username>' (или null, если ключ не про публичный чат). */
export function usernameOfChatId(chatId: string): string | null {
  const m = /^web:([A-Za-z][A-Za-z0-9_]*)$/.exec(chatId ?? '');
  return m ? m[1]! : null;
}

/** Публичная ссылка на чат: 'web:durov' → https://t.me/durov. */
export function chatUrlOf(chatId: string): string | null {
  const username = usernameOfChatId(chatId);
  return username ? `https://t.me/${username}` : null;
}

/** Человекочитаемое имя источника заявки — для админки и фильтра по origin. */
export const ORIGIN_LABELS: Record<ListingOrigin, string> = {
  bot: 'бот',
  collector: 'сборщик',
  extension: 'расширение',
};

export function originLabel(origin: ListingOrigin | string | null | undefined): string {
  return ORIGIN_LABELS[(origin ?? 'bot') as ListingOrigin] ?? 'бот';
}
