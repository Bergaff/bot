#!/usr/bin/env node
/**
 * Сборка клиентской части (этап 3 ТЗ):
 *   1. бандл чистых функций src/parser.ts → extension/vendor/parser.js
 *      (клиентский детект: пассажирские и болтовня отсеиваются в вкладке);
 *   2. единый файл юзерскрипта userscript/poputchka-collector.user.js —
 *      тот же код, что и в расширении, только для Tampermonkey/Violentmonkey.
 *
 * Запуск: npm run build:ext
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* 1. Бандл парсера ------------------------------------------------- */

await build({
  entryPoints: [resolve(root, 'extension/entry-parser.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'PoputkaParser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  outfile: resolve(root, 'extension/vendor/parser.js'),
});
const parserBytes = readFileSync(resolve(root, 'extension/vendor/parser.js')).length;
console.log(`✓ extension/vendor/parser.js — ${(parserBytes / 1024).toFixed(1)} КБ (детект на правилах src/parser.ts)`);

/* 2. Юзерскрипт ---------------------------------------------------- */

const parts = [
  'extension/vendor/parser.js',
  'extension/core.js',
  'extension/dom.js',
  'extension/content.js',
];

const header = `// ==UserScript==
// @name         попутка. — сбор объявлений из чатов Telegram Web
// @namespace    https://github.com/Bergaff/bot
// @version      1.0.4
// @description  Только чтение: находит объявления о передаче посылок в открытой вкладке Telegram Web и отправляет их на сервер попутки (POST /api/ingest). Ничего не публикует от вашего имени.
// @match        https://web.telegram.org/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==
/*
 * Сгенерирован scripts/build-extension.mjs из тех же файлов, что и расширение:
 *   ${parts.join('\n *   ')}
 *
 * Настройки юзерскрипта — в localStorage["poputchka"] (попапа у юзерскрипта нет):
 *   localStorage.setItem('poputchka', JSON.stringify({ settings: {
 *     serverUrl: 'https://pop-utka.app',
 *     token: 'ВАШ_INGEST_TOKEN',
 *     // рум (топик) форум-чата — просто ссылкой из Telegram или записью с '::'
 *     whitelist: ['https://t.me/travelersminsk/91529', 't.me/granica_es',
 *                 'Граница :: Очередь BY-PL', 'Граница :: 7'],
 *     intervalSec: 120, batchSize: 20, maxPerChat: 30,
 *     confirmMode: true, paused: false, maxAgeHours: 72, requireContact: false,
 *     // автообход: сам открывает чаты и румы из whitelist со случайными паузами
 *     autoWalk: false, walkReadsPerChat: 2, walkMinSec: 60, walkMaxSec: 240,
 *     walkMaxPerHour: 20, walkIdleGuardSec: 45,
 *   }}));
 *   location.reload();
 *
 * Счётчики и лог отправленного живут там же; панель — справа внизу вкладки.
 *
 * Версия 1.0.4: автообход чатов и румов. Расширение само открывает цели из
 * белого списка (адресом вкладки, а если клиент его не понял — кликом по строке
 * в списке чатов), читает их и идёт дальше по кругу. Темп человеческий: случайная
 * пауза 60–240 с между переходами, 2 прохода на чат, не больше 20 переходов в час
 * и «не мешать» — пока вы печатаете или кликаете во вкладке, чат не переключаем.
 * Обход только читает: ничего не отправляет, не публикует и не печатает от вашего
 * имени. Пауза и выключение — мгновенные (кнопка «Обход: выключить» в панели справа
 * внизу или галочка в попапе). Если чат не открылся, обход пишет об этом в журнале
 * и идёт дальше, а адрес вкладки возвращает прежний — иначе сообщения чужого чата
 * ушли бы на сервер под неверным именем. По умолчанию автообход ВЫКЛЮЧЕН.
 * Ещё: отправленные сообщения больше не повторяются, даже если сервер ответил без
 * разбора по сообщениям (results) — важно, когда обход перечитывает чат по кругу.
 *
 * Версия 1.0.3: рум (топик) forum-чата можно задать ссылкой из Telegram
 * (t.me/<чат>/<рум> или t.me/<чат>/<рум>/<сообщение>); в панели справа внизу и в
 * попапе видно каждое прочитанное сообщение с вердиктом и ссылкой-пермалинком
 * t.me/<чат>/<рум>/<сообщение> — её можно открыть и переслать объявление вручную.
 *
 * Версия 1.0.2: ядро и DOM-модуль называются core.js и dom.js — Chrome определяет
 * тип файла контент-скрипта по расширению и не грузил .cjs («Invalid script mime
 * type»), из-за чего не внедрялся весь список файлов и вкладка «не отвечала».
 *
 * Версия 1.0.1: контент-скрипт помечает свой экземпляр на window и при повторном
 * внедрении не плодит второй таймер (попап расширения умеет подключаться к уже
 * открытой вкладке сам — chrome.scripting; у юзерскрипта такой возможности нет,
 * там достаточно перезагрузки страницы).
 *
 * Если на сервере заданы настройки из админки (вкладка «чаты» → «Аккаунт Telegram
 * (расширение)»), они перекрывают локальные: клиент каждый проход спрашивает
 * GET /api/extension/config и шлёт отметку POST /api/extension/heartbeat — по ней
 * панель видит, что аккаунт на связи, какой чат и рум открыты и сколько принято.
 * Ограничение юзерскрипта (@grant none): с https-страницы не достучаться до
 * http://127.0.0.1 — для локальной отладки используйте расширение (extension/).
 */
`;

const body = parts.map((p) => {
  const code = readFileSync(resolve(root, p), 'utf8');
  return `\n/* ---- ${p} ---- */\n${code}`;
}).join('\n');

mkdirSync(resolve(root, 'userscript'), { recursive: true });
const out = resolve(root, 'userscript/poputchka-collector.user.js');
writeFileSync(out, header + body);
console.log(`✓ userscript/poputchka-collector.user.js — ${(readFileSync(out).length / 1024).toFixed(1)} КБ`);
console.log('  Установите в Tampermonkey/Violentmonkey или загрузите extension/ как «распакованное расширение».');
