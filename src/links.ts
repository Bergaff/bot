import type { ListingOrigin } from './types.ts';

/**
 * Ссылка на исходное сообщение (ТЗ п. 2.3).
 *
 * Ключи чатов-источников живут в трёх мирах:
 *   '-100<id>'      — бот добавлен в супергруппу/канал → служебная t.me/c/<id>/<msg>
 *   'web:<username>'— серверный сборщик публичных чатов → открытая t.me/<username>/<msg>
 *   'ext:<id>'      — приватный чат из браузерного расширения → ссылки нет,
 *                     если админ не задал её вручную в chat_links
 *
 * Приоритет всегда у chat_links: админ может задать красивую публичную ссылку
 * на любой чат (на сайте её показывает sourceLinkUrl() в public/app.js).
 */
export function listingSourceLink(
  sourceChatId: string | null | undefined,
  sourceMessageId: number | null | undefined,
  chatLinks?: Record<string, string> | null
): string | null {
  if (!sourceChatId) return null;

  const manual = chatLinks?.[sourceChatId];
  if (manual && manual.trim()) {
    const url = manual.trim().replace(/\/$/, '');
    // К сообщению ведёт только ссылка вида t.me/<username>:
    // пригласительные t.me/+AbC… и служебные t.me/c/<id> так не работают.
    return sourceMessageId != null && /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]*$/.test(url)
      ? `${url}/${sourceMessageId}`
      : url;
  }

  // публичный чат из сборщика: web:durov + 528 → https://t.me/durov/528
  const web = /^web:([A-Za-z][A-Za-z0-9_]*)$/.exec(sourceChatId);
  if (web) return `https://t.me/${web[1]}${sourceMessageId != null ? `/${sourceMessageId}` : ''}`;

  // приватный чат из расширения: вручную ссылку не задали — честно null
  if (sourceChatId.startsWith('ext:')) return null;

  // супергруппа/канал, где работает бот: id начинается с -100
  const super100 = /^-100(\d+)$/.exec(sourceChatId);
  if (super100) return `https://t.me/c/${super100[1]}${sourceMessageId != null ? `/${sourceMessageId}` : ''}`;

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
