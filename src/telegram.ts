import type { Env, Listing } from './types.ts';
import { uniqueContacts, escapeHtml, admins } from './util.ts';
import { listingSourceLink } from './links.ts';

/**
 * Форматирование карточки и уведомления админам в Telegram.
 *
 * В `Bergaff/parcel` это уже реализовано в src/telegram.ts (formatListing,
 * notifyAdmins, sendText) — этот файл НЕ переносится, он нужен, чтобы
 * сборщик работал и тестировался отдельно от бота. При переносе в parcel:
 *   - listingSourceLink() в src/telegram.ts заменить на версию из src/links.ts
 *     (или сделать re-export), поведение для '-100<id>' не меняется;
 *   - notifyAdmins из src/ingest.ts подключить к существующему notifyAdmins().
 */

/** Карточка заявки для модератора — формат бота (HTML для parse_mode=HTML). */
export function formatListing(l: Listing, sourceNote = ''): string {
  const typeLabel = l.type === 'offer' ? 'Водитель везёт' : 'Нужно передать';
  const parts = [
    `#${l.id.slice(0, 8)} ${typeLabel}`,
    `Маршрут: ${escapeHtml(l.fromCity)} → ${escapeHtml(l.toCity)}`,
  ];
  if (l.departureDate) parts.push(`Дата: ${escapeHtml(l.departureDate)}`);
  const extras: string[] = [];
  if (l.weightKg != null) extras.push(`вес ${l.weightKg} кг`);
  if (l.price) extras.push(`цена ${escapeHtml(l.price)}`);
  if (extras.length) parts.push(`Детали: ${extras.join(' · ')}`);
  parts.push(`Описание: ${escapeHtml(l.description.slice(0, 300))}`);
  const contacts = uniqueContacts(l.telegram, l.phone);
  if (contacts.length) parts.push(`Контакты: ${escapeHtml(contacts.join(', '))}`);
  const srcLink = listingSourceLink(l.sourceChatId, l.sourceMessageId);
  const srcRef = l.sourceChat
    ? (l.sourceChat.startsWith('Переслано от ') ? escapeHtml(l.sourceChat) : `чат «${escapeHtml(l.sourceChat)}»`)
    : '';
  const srcLinkTag = srcLink ? ` — <a href="${srcLink}">исходное сообщение</a>` : '';
  if (l.source === 'parser') parts.push(`Источник: ИИ-разбор${srcRef ? `, ${srcRef}` : ''}${srcLinkTag}`);
  else if (l.sourceChat) parts.push(`Источник: ${srcRef}${srcLinkTag}`);
  if (sourceNote) parts.push(sourceNote);
  return parts.join('\n');
}

/** Отправить текст администраторам (ADMIN_IDS). Без BOT_TOKEN — тихо в лог. */
export async function sendTextToAdmins(
  env: Env,
  text: string,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<number> {
  const ids = admins(env);
  if (ids.length === 0) return 0;
  if (!env.BOT_TOKEN) {
    console.log('[notify:admins]', text.replace(/<[^>]+>/g, ''));
    return 0;
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const base = (env.TG_API_BASE ?? 'https://api.telegram.org').replace(/\/+$/, '');
  let sent = 0;
  for (const id of ids) {
    try {
      const res = await doFetch(`${base}/bot${env.BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: Number(id), text, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) sent++;
    } catch (e) {
      console.error('notify admins failed', e);
    }
  }
  return sent;
}

/** Уведомление о новой заявке на модерацию (как в боте). */
export async function notifyAdmins(env: Env, listing: Listing): Promise<void> {
  if (!listing || listing.status !== 'pending') return;
  const noContact = uniqueContacts(listing.telegram, listing.phone).length === 0
    ? '\n<i>⚠ Контакта нет — сверьтесь с исходным сообщением или чатом</i>'
    : '';
  await sendTextToAdmins(env, formatListing(listing, noContact));
}
