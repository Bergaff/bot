import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Фикстуры разметки t.me/s/<username> (ТЗ п. 5.1).
 *
 * Структура повторяет живое веб-превью: контейнеры .tgme_widget_message_wrap /
 * .tgme_widget_message с data-post="<username>/<id>", текст в
 * .tgme_widget_message_text (<br> — перенос строки), permalink и
 * <time datetime="…"> в .tgme_widget_message_date, обвязка
 * «VIEW IN TELEGRAM» / «Please open Telegram to view this post»,
 * в супергруппах — .tgme_widget_message_author_name и
 * .tgme_widget_message_forwarded_from_name, сервисные сообщения —
 * класс .tgme_widget_message_service.
 *
 * Заменить на настоящие страницы (снять с живого t.me одной командой):
 *   npm run fixture -- durov
 *   npm run fixture -- drivers_pl_by supergroup
 * (скрипт положит их в tests/fixtures/tme-s-<username>.html — имена совпадают)
 */

const dir = fileURLToPath(new URL('./fixtures/', import.meta.url));

export function fixture(name: string): string {
  return readFileSync(dir + name, 'utf8');
}

export const FIXTURES = {
  /** Канал: текст, медиа, многострочное сообщение, «edited». */
  channel: () => fixture('tme-s-durov.html'),
  /** Публичная супергруппа: авторы, форвард, сервисное сообщение. */
  supergroup: () => fixture('tme-s-supergroup.html'),
  /** Страница ?before=528 — более старые сообщения. */
  older: () => fixture('tme-s-durov-before-528.html'),
  /** Чата нет: t.me отдаёт страницу «Contact @…». */
  missing: () => fixture('tme-s-missing.html'),
  /** Обрезанный HTML: обрыв внутри второго сообщения. */
  truncated: () => fixture('tme-s-truncated.html'),
  /** Пустой ответ. */
  empty: () => fixture('tme-s-empty.html'),
  /** Капча/бан-стена. */
  blocked: () => fixture('tme-s-blocked.html'),
  /** Разметка без data-post: id остаётся только в permalink'ах. */
  noDataPost: () => fixture('tme-s-durov-nodata.html'),
} as const;
