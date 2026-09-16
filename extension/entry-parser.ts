/**
 * Точка сборки клиентского детекта (ТЗ п. 4.5).
 *
 * `src/parser.ts` — чистые функции без Worker API, поэтому их можно собрать
 * бандлером и выполнять прямо в вкладке Telegram Web: отсеивать пассажирские
 * и болтовню ДО отправки на сервер, а не гонять туда весь поток сообщений.
 *
 * Сборка: npm run build:ext  →  extension/vendor/parser.js
 */
export {
  parseTelegramMessage,
  looksLikeListing,
  isPassengerOnly,
  worthAiCheck,
  isMultiRoute,
  scoreIntent,
  normalizeCity,
} from '../src/parser.ts';
