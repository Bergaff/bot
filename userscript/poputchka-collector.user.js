// ==UserScript==
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
 *   extension/vendor/parser.js
 *   extension/core.js
 *   extension/dom.js
 *   extension/content.js
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

/* ---- extension/vendor/parser.js ---- */
"use strict";var PoputkaParser=(()=>{var p=Object.defineProperty;var C=Object.getOwnPropertyDescriptor;var q=Object.getOwnPropertyNames;var x=Object.prototype.hasOwnProperty;var A=(t,e)=>{for(var n in e)p(t,n,{get:e[n],enumerable:!0})},T=(t,e,n,r)=>{if(e&&typeof e=="object"||typeof e=="function")for(let i of q(e))!x.call(t,i)&&i!==n&&p(t,i,{get:()=>e[i],enumerable:!(r=C(e,i))||r.enumerable});return t};var F=t=>T(p({},"__esModule",{value:!0}),t);var ee={};A(ee,{isMultiRoute:()=>R,isPassengerOnly:()=>I,looksLikeListing:()=>v,normalizeCity:()=>z,parseTelegramMessage:()=>y,scoreIntent:()=>g,worthAiCheck:()=>$});var h={\u0432\u0430\u0440\u0448\u0430\u0432\u0430:"\u0412\u0430\u0440\u0448\u0430\u0432\u0430",\u0432\u0430\u0440\u0448\u0430\u0432:"\u0412\u0430\u0440\u0448\u0430\u0432\u0430",\u043A\u0440\u0430\u043A\u043E\u0432:"\u041A\u0440\u0430\u043A\u043E\u0432",\u043A\u0440\u0430\u043A\u043E\u0432\u043E\u0432:"\u041A\u0440\u0430\u043A\u043E\u0432",\u0433\u0434\u0430\u043D\u0441\u044C\u043A:"\u0413\u0434\u0430\u043D\u044C\u0441\u043A",\u0433\u0434\u0430\u043D\u0441\u043A:"\u0413\u0434\u0430\u043D\u044C\u0441\u043A",\u0433\u0434\u0430\u043D\u044C\u0441\u043A:"\u0413\u0434\u0430\u043D\u044C\u0441\u043A",\u0434\u0430\u043D\u0446\u0438\u0433:"\u0413\u0434\u0430\u043D\u044C\u0441\u043A",\u0432\u0440\u043E\u0446\u043B\u0430\u0432:"\u0412\u0440\u043E\u0446\u043B\u0430\u0432",\u0432\u0440\u043E\u0446\u043B\u0430\u0432\u043E\u0432:"\u0412\u0440\u043E\u0446\u043B\u0430\u0432",\u043F\u043E\u0437\u043D\u0430\u043D\u044C:"\u041F\u043E\u0437\u043D\u0430\u043D\u044C",\u043F\u043E\u0437\u043D\u0430\u043D\u0438:"\u041F\u043E\u0437\u043D\u0430\u043D\u044C",\u043B\u043E\u0434\u0437\u044C:"\u041B\u043E\u0434\u0437\u044C",\u043B\u043E\u0434\u0437\u0438:"\u041B\u043E\u0434\u0437\u044C",\u043A\u0430\u0442\u043E\u0432\u0438\u0446\u0435:"\u041A\u0430\u0442\u043E\u0432\u0438\u0446\u0435",\u043A\u0430\u0442\u043E\u0432\u0438\u0446\u044B:"\u041A\u0430\u0442\u043E\u0432\u0438\u0446\u0435",\u043A\u0430\u0442\u043E\u0432\u0438\u0446:"\u041A\u0430\u0442\u043E\u0432\u0438\u0446\u0435",\u043B\u044E\u0431\u043B\u0438\u043D:"\u041B\u044E\u0431\u043B\u0438\u043D",\u0431\u0435\u043B\u043E\u0441\u0442\u043E\u043A:"\u0411\u0435\u043B\u043E\u0441\u0442\u043E\u043A",\u0431\u0438\u043B\u043E\u0441\u0442\u043E\u043A:"\u0411\u0435\u043B\u043E\u0441\u0442\u043E\u043A",\u0431\u044F\u043B\u044B\u0441\u0442\u043E\u043A:"\u0411\u0435\u043B\u043E\u0441\u0442\u043E\u043A",\u043A\u0443\u0437\u043D\u0438\u0446\u0430:"\u041A\u0443\u0437\u043D\u0438\u0446\u0430",kuznica:"\u041A\u0443\u0437\u043D\u0438\u0446\u0430",ku\u017Anica:"\u041A\u0443\u0437\u043D\u0438\u0446\u0430",\u0431\u0440\u0443\u0437\u0433\u0438:"\u0411\u0440\u0443\u0437\u0433\u0438",bruzgi:"\u0411\u0440\u0443\u0437\u0433\u0438",\u0430\u0432\u0433\u0443\u0441\u0442\u043E\u0432:"\u0410\u0432\u0433\u0443\u0441\u0442\u043E\u0432",augustow:"\u0410\u0432\u0433\u0443\u0441\u0442\u043E\u0432",\u0449\u0435\u0446\u0438\u043D:"\u0429\u0435\u0446\u0438\u043D",\u0448\u0447\u0435\u0446\u0438\u043D:"\u0429\u0435\u0446\u0438\u043D",\u0431\u044B\u0434\u0433\u043E\u0449:"\u0411\u044B\u0434\u0433\u043E\u0449",\u0431\u044B\u0434\u0433\u043E\u0449\u044C:"\u0411\u044B\u0434\u0433\u043E\u0449",\u0442\u043E\u0440\u0443\u043D\u044C:"\u0422\u043E\u0440\u0443\u043D\u044C",\u0442\u043E\u0440\u0443\u043D\u0456:"\u0422\u043E\u0440\u0443\u043D\u044C",\u0447\u0435\u043D\u0441\u0442\u043E\u0445\u043E\u0432\u0430:"\u0427\u0435\u043D\u0441\u0442\u043E\u0445\u043E\u0432\u0430",\u0447\u0435\u043D\u0441\u0442\u043E\u0445\u043E\u0432\u043E:"\u0427\u0435\u043D\u0441\u0442\u043E\u0445\u043E\u0432\u0430",\u0440\u0430\u0434\u043E\u043C:"\u0420\u0430\u0434\u043E\u043C",\u0441\u043E\u0441\u043D\u043E\u0432\u0435\u0446:"\u0421\u043E\u0441\u043D\u043E\u0432\u0435\u0446",\u0441\u043E\u0441\u043D\u043E\u0432\u0454\u0446:"\u0421\u043E\u0441\u043D\u043E\u0432\u0435\u0446",\u0433\u0434\u044B\u043D\u044F:"\u0413\u0434\u044B\u043D\u044F",\u0433\u0434\u0438\u043D\u044F:"\u0413\u0434\u044B\u043D\u044F",\u043E\u043B\u044C\u0448\u0442\u044B\u043D:"\u041E\u043B\u044C\u0448\u0442\u044B\u043D",\u0436\u0435\u0448\u0443\u0432:"\u0416\u0435\u0448\u0443\u0432",\u0440\u0436\u0435\u0448\u0443\u0432:"\u0416\u0435\u0448\u0443\u0432","\u0437\u0435\u043B\u0435\u043D\u0430-\u0433\u0443\u0440\u0430":"\u0417\u0435\u043B\u0451\u043D\u0430-\u0413\u0443\u0440\u0430",\u043E\u043F\u043E\u043B\u0435:"\u041E\u043F\u043E\u043B\u0435","\u0431\u0435\u043B\u044C\u0441\u043A\u043E-\u0431\u044F\u043B\u0430":"\u0411\u0435\u043B\u044C\u0441\u043A\u043E-\u0411\u044F\u043B\u0430",\u043A\u0435\u043B\u044C\u0446\u0435:"\u041A\u0435\u043B\u044C\u0446\u0435",\u0433\u043B\u0438\u0432\u0438\u0446\u0435:"\u0413\u043B\u0438\u0432\u0438\u0446\u0435",\u0433\u043B\u0438\u0432\u0438\u0446\u044B:"\u0413\u043B\u0438\u0432\u0438\u0446\u0435",\u0437\u0430\u0431\u0436\u0435:"\u0417\u0430\u0431\u0436\u0435",\u0431\u044B\u0442\u043E\u043C:"\u0411\u044B\u0442\u043E\u043C",\u0442\u044B\u0445\u044B:"\u0422\u044B\u0445\u044B",\u043F\u043B\u043E\u0446\u043A:"\u041F\u043B\u043E\u0446\u043A",\u044D\u043B\u044C\u0431\u043B\u043E\u043D\u0433:"\u042D\u043B\u044C\u0431\u043B\u043E\u043D\u0433",\u0432\u0430\u043B\u0431\u0436\u0438\u0445:"\u0412\u0430\u043B\u0431\u0436\u0438\u0445",\u0432\u043B\u043E\u0446\u043B\u0430\u0432\u0435\u043A:"\u0412\u043B\u043E\u0446\u043B\u0430\u0432\u0435\u043A",\u0442\u0430\u0440\u043D\u0443\u0432:"\u0422\u0430\u0440\u043D\u0443\u0432",\u043A\u043E\u0448\u0430\u043B\u0438\u043D:"\u041A\u043E\u0448\u0430\u043B\u0438\u043D",\u043A\u0430\u043B\u0438\u0448:"\u041A\u0430\u043B\u0438\u0448",\u043B\u0435\u0433\u0438\u043D\u0446\u0430:"\u041B\u0435\u0433\u043D\u0438\u0446\u0430",\u043B\u0435\u0433\u043D\u0438\u0446\u0430:"\u041B\u0435\u0433\u043D\u0438\u0446\u0430",\u0433\u0440\u0443\u0434\u0437\u0451\u043D\u0434\u0437:"\u0413\u0440\u0443\u0434\u0437\u0451\u043D\u0434\u0437",\u0433\u0440\u0443\u0434\u0437\u0435\u043D\u0434\u0437:"\u0413\u0440\u0443\u0434\u0437\u0451\u043D\u0434\u0437",\u0441\u043B\u0443\u043F\u0441\u043A:"\u0421\u043B\u0443\u043F\u0441\u043A",\u0445\u043E\u0436\u0443\u0432:"\u0425\u043E\u0436\u0443\u0432",\u043A\u0438\u0435\u0432:"\u041A\u0438\u0435\u0432",\u043A\u0438\u0457\u0432:"\u041A\u0438\u0435\u0432",\u043B\u044C\u0432\u043E\u0432:"\u041B\u044C\u0432\u043E\u0432",\u043B\u044C\u0432\u0456:"\u041B\u044C\u0432\u043E\u0432",\u0445\u0430\u0440\u044C\u043A\u043E\u0432:"\u0425\u0430\u0440\u044C\u043A\u043E\u0432",\u0445\u0430\u0440\u043A\u0456\u0432:"\u0425\u0430\u0440\u044C\u043A\u043E\u0432",\u043E\u0434\u0435\u0441\u0441\u0430:"\u041E\u0434\u0435\u0441\u0441\u0430",\u043E\u0434\u0435\u0441\u0430:"\u041E\u0434\u0435\u0441\u0441\u0430",\u0434\u043D\u0435\u043F\u0440:"\u0414\u043D\u0435\u043F\u0440",\u0434\u043D\u0456\u043F\u0440\u043E:"\u0414\u043D\u0435\u043F\u0440",\u0434\u043D\u0435\u043F\u0440\u043E\u043F\u0435\u0442\u0440\u043E\u0432\u0441\u043A:"\u0414\u043D\u0435\u043F\u0440",\u0437\u0430\u043F\u043E\u0440\u043E\u0436\u044C\u0435:"\u0417\u0430\u043F\u043E\u0440\u043E\u0436\u044C\u0435",\u0437\u0430\u043F\u043E\u0440\u0456\u0436\u0436\u044F:"\u0417\u0430\u043F\u043E\u0440\u043E\u0436\u044C\u0435",\u0432\u0438\u043D\u043D\u0438\u0446\u0430:"\u0412\u0438\u043D\u043D\u0438\u0446\u0430",\u0432\u0456\u043D\u043D\u0438\u0446\u044F:"\u0412\u0438\u043D\u043D\u0438\u0446\u0430",\u043F\u043E\u043B\u0442\u0430\u0432\u0430:"\u041F\u043E\u043B\u0442\u0430\u0432\u0430",\u0447\u0435\u0440\u043D\u0438\u0433\u043E\u0432:"\u0427\u0435\u0440\u043D\u0438\u0433\u043E\u0432",\u0447\u0435\u0440\u043D\u0456\u0433\u0456\u0432:"\u0427\u0435\u0440\u043D\u0438\u0433\u043E\u0432",\u0441\u0443\u043C\u044B:"\u0421\u0443\u043C\u044B","\u0438\u0432\u0430\u043D\u043E-\u0444\u0440\u0430\u043D\u043A\u043E\u0432\u0441\u043A":"\u0418\u0432\u0430\u043D\u043E-\u0424\u0440\u0430\u043D\u043A\u043E\u0432\u0441\u043A","\u0456\u0432\u0430\u043D\u043E-\u0444\u0440\u0430\u043D\u043A\u0456\u0432\u0441\u044C\u043A":"\u0418\u0432\u0430\u043D\u043E-\u0424\u0440\u0430\u043D\u043A\u043E\u0432\u0441\u043A",\u043B\u0443\u0446\u043A:"\u041B\u0443\u0446\u043A",\u043B\u0443\u0446\u044C\u043A:"\u041B\u0443\u0446\u043A",\u0440\u043E\u0432\u043D\u043E:"\u0420\u043E\u0432\u043D\u043E",\u0440\u0456\u0432\u043D\u0435:"\u0420\u043E\u0432\u043D\u043E",\u0442\u0435\u0440\u043D\u043E\u043F\u043E\u043B\u044C:"\u0422\u0435\u0440\u043D\u043E\u043F\u043E\u043B\u044C",\u0442\u0435\u0440\u043D\u043E\u043F\u0456\u043B\u044C:"\u0422\u0435\u0440\u043D\u043E\u043F\u043E\u043B\u044C",\u0445\u043C\u0435\u043B\u044C\u043D\u0438\u0446\u043A\u0438\u0439:"\u0425\u043C\u0435\u043B\u044C\u043D\u0438\u0446\u043A\u0438\u0439",\u0445\u043C\u0435\u043B\u044C\u043D\u0438\u0446\u044C\u043A\u0438\u0439:"\u0425\u043C\u0435\u043B\u044C\u043D\u0438\u0446\u043A\u0438\u0439",\u0447\u0435\u0440\u043D\u043E\u0432\u0446\u044B:"\u0427\u0435\u0440\u043D\u043E\u0432\u0446\u044B",\u0447\u0435\u0440\u043D\u0456\u0432\u0446\u0456:"\u0427\u0435\u0440\u043D\u043E\u0432\u0446\u044B",\u0443\u0436\u0433\u043E\u0440\u043E\u0434:"\u0423\u0436\u0433\u043E\u0440\u043E\u0434",\u043C\u0443\u043A\u0430\u0447\u0435\u0432\u043E:"\u041C\u0443\u043A\u0430\u0447\u0435\u0432\u043E",\u043C\u0443\u043A\u0430\u0447\u0435\u0432\u0435:"\u041C\u0443\u043A\u0430\u0447\u0435\u0432\u043E",\u043D\u0438\u043A\u043E\u043B\u0430\u0435\u0432:"\u041D\u0438\u043A\u043E\u043B\u0430\u0435\u0432",\u043C\u0438\u043A\u043E\u043B\u0430\u0457\u0432:"\u041D\u0438\u043A\u043E\u043B\u0430\u0435\u0432",\u0445\u0435\u0440\u0441\u043E\u043D:"\u0425\u0435\u0440\u0441\u043E\u043D","\u043A\u0440\u0438\u0432\u043E\u0439 \u0440\u043E\u0433":"\u041A\u0440\u0438\u0432\u043E\u0439 \u0420\u043E\u0433","\u043A\u0440\u0438\u0432\u0438\u0439 \u0440\u0456\u0433":"\u041A\u0440\u0438\u0432\u043E\u0439 \u0420\u043E\u0433",\u043C\u0430\u0440\u0438\u0443\u043F\u043E\u043B\u044C:"\u041C\u0430\u0440\u0438\u0443\u043F\u043E\u043B\u044C",\u043C\u0430\u0440\u0456\u0443\u043F\u043E\u043B\u044C:"\u041C\u0430\u0440\u0438\u0443\u043F\u043E\u043B\u044C",\u0431\u0435\u0440\u043B\u0438\u043D:"\u0411\u0435\u0440\u043B\u0438\u043D",\u0431\u0435\u0440\u043B\u0456\u043D:"\u0411\u0435\u0440\u043B\u0438\u043D",\u043C\u044E\u043D\u0445\u0435\u043D:"\u041C\u044E\u043D\u0445\u0435\u043D",\u0433\u0430\u043C\u0431\u0443\u0440\u0433:"\u0413\u0430\u043C\u0431\u0443\u0440\u0433",\u0444\u0440\u0430\u043D\u043A\u0444\u0443\u0440\u0442:"\u0424\u0440\u0430\u043D\u043A\u0444\u0443\u0440\u0442",\u0433\u0430\u043D\u043D\u043E\u0432\u0435\u0440:"\u0413\u0430\u043D\u043D\u043E\u0432\u0435\u0440",\u0434\u0440\u0435\u0437\u0434\u0435\u043D:"\u0414\u0440\u0435\u0437\u0434\u0435\u043D",\u0434\u0440\u0435\u0437\u0434\u043D:"\u0414\u0440\u0435\u0437\u0434\u0435\u043D",\u043A\u0451\u043B\u044C\u043D:"\u041A\u0451\u043B\u044C\u043D",\u043A\u0435\u043B\u044C\u043D:"\u041A\u0451\u043B\u044C\u043D",\u0432\u0435\u043D\u0430:"\u0412\u0435\u043D\u0430",\u0432\u0456\u0434\u0435\u043D:"\u0412\u0435\u043D\u0430",\u043F\u0440\u0430\u0433\u0430:"\u041F\u0440\u0430\u0433\u0430",\u0431\u0440\u0430\u0442\u0438\u0441\u043B\u0430\u0432\u0430:"\u0411\u0440\u0430\u0442\u0438\u0441\u043B\u0430\u0432\u0430",\u0431\u0443\u0434\u0430\u043F\u0435\u0448\u0442:"\u0411\u0443\u0434\u0430\u043F\u0435\u0448\u0442",\u0430\u043C\u0441\u0442\u0435\u0440\u0434\u0430\u043C:"\u0410\u043C\u0441\u0442\u0435\u0440\u0434\u0430\u043C",\u0431\u0440\u044E\u0441\u0441\u0435\u043B\u044C:"\u0411\u0440\u044E\u0441\u0441\u0435\u043B\u044C",\u043F\u0430\u0440\u0438\u0436:"\u041F\u0430\u0440\u0438\u0436",\u043B\u043E\u043D\u0434\u043E\u043D:"\u041B\u043E\u043D\u0434\u043E\u043D",\u043C\u0438\u043B\u0430\u043D:"\u041C\u0438\u043B\u0430\u043D",\u0440\u0438\u043C:"\u0420\u0438\u043C",\u043C\u0430\u0434\u0440\u0438\u0434:"\u041C\u0430\u0434\u0440\u0438\u0434",\u0431\u0430\u0440\u0441\u0435\u043B\u043E\u043D\u0430:"\u0411\u0430\u0440\u0441\u0435\u043B\u043E\u043D\u0430",\u0432\u0438\u043B\u044C\u043D\u044E\u0441:"\u0412\u0438\u043B\u044C\u043D\u044E\u0441",\u043A\u0430\u0443\u043D\u0430\u0441:"\u041A\u0430\u0443\u043D\u0430\u0441",\u043A\u043B\u0430\u0439\u043F\u0435\u0434\u0430:"\u041A\u043B\u0430\u0439\u043F\u0435\u0434\u0430",\u043A\u043Ba\u0439\u043F\u0435\u0434\u0430:"\u041A\u043B\u0430\u0439\u043F\u0435\u0434\u0430",\u0440\u0438\u0433\u0430:"\u0420\u0438\u0433\u0430",\u0442\u0430\u043B\u043B\u0438\u043D:"\u0422\u0430\u043B\u043B\u0438\u043D",\u0442\u0430\u043B\u043B\u0438\u043D\u043D:"\u0422\u0430\u043B\u043B\u0438\u043D",\u043C\u0438\u043D\u0441\u043A:"\u041C\u0438\u043D\u0441\u043A",\u043C\u0456\u043D\u0441\u043A:"\u041C\u0438\u043D\u0441\u043A",\u0431\u0440\u0435\u0441\u0442:"\u0411\u0440\u0435\u0441\u0442",\u0433\u0440\u043E\u0434\u043D\u043E:"\u0413\u0440\u043E\u0434\u043D\u043E",\u0433\u043E\u043C\u0435\u043B\u044C:"\u0413\u043E\u043C\u0435\u043B\u044C",\u0432\u0438\u0442\u0435\u0431\u0441\u043A:"\u0412\u0438\u0442\u0435\u0431\u0441\u043A",\u043C\u043E\u0433\u0438\u043B\u0435\u0432:"\u041C\u043E\u0433\u0438\u043B\u0451\u0432",\u043C\u043E\u0433\u0438\u043B\u0451\u0432:"\u041C\u043E\u0433\u0438\u043B\u0451\u0432",\u0431\u043E\u0431\u0440\u0443\u0439\u0441\u043A:"\u0411\u043E\u0431\u0440\u0443\u0439\u0441\u043A",\u0431\u0430\u0440\u0430\u043D\u043E\u0432\u0438\u0447\u0438:"\u0411\u0430\u0440\u0430\u043D\u043E\u0432\u0438\u0447\u0438",\u043F\u0438\u043D\u0441\u043A:"\u041F\u0438\u043D\u0441\u043A",\u0436\u0438\u0442\u043E\u043C\u0438\u0440:"\u0416\u0438\u0442\u043E\u043C\u0438\u0440",\u0447\u0435\u0440\u043A\u0430\u0441\u0441\u044B:"\u0427\u0435\u0440\u043A\u0430\u0441\u0441\u044B",\u043A\u0430\u043B\u0438\u043D\u0438\u043D\u0433\u0440\u0430\u0434:"\u041A\u0430\u043B\u0438\u043D\u0438\u043D\u0433\u0440\u0430\u0434",\u043A\u0435\u043D\u0438\u0433\u0441\u0431\u0435\u0440\u0433:"\u041A\u0430\u043B\u0438\u043D\u0438\u043D\u0433\u0440\u0430\u0434",\u043C\u043E\u0441\u043A\u0432\u0430:"\u041C\u043E\u0441\u043A\u0432\u0430","\u0441\u0430\u043D\u043A\u0442-\u043F\u0435\u0442\u0435\u0440\u0431\u0443\u0440\u0433":"\u0421\u0430\u043D\u043A\u0442-\u041F\u0435\u0442\u0435\u0440\u0431\u0443\u0440\u0433",\u043F\u0438\u0442\u0435\u0440:"\u0421\u0430\u043D\u043A\u0442-\u041F\u0435\u0442\u0435\u0440\u0431\u0443\u0440\u0433",\u043F\u0435\u0442\u0435\u0440\u0431\u0443\u0440\u0433:"\u0421\u0430\u043D\u043A\u0442-\u041F\u0435\u0442\u0435\u0440\u0431\u0443\u0440\u0433",\u0432\u0430\u0440\u0430\u0448\u0430\u0432\u0430:"\u0412\u0430\u0440\u0448\u0430\u0432\u0430",\u043A\u0440\u0430\u043A\u043E\u0432\u043E\u0435:"\u041A\u0440\u0430\u043A\u043E\u0432",\u0432\u0440\u043E\u0446\u043B\u0430\u0432\u044C:"\u0412\u0440\u043E\u0446\u043B\u0430\u0432",warsawa:"\u0412\u0430\u0440\u0448\u0430\u0432\u0430",warshawa:"\u0412\u0430\u0440\u0448\u0430\u0432\u0430",warshava:"\u0412\u0430\u0440\u0448\u0430\u0432\u0430",krakov:"\u041A\u0440\u0430\u043A\u043E\u0432",krakiv:"\u041A\u0440\u0430\u043A\u043E\u0432",lwow:"\u041B\u044C\u0432\u043E\u0432",lw\u00F3w:"\u041B\u044C\u0432\u043E\u0432",warszawa:"\u0412\u0430\u0440\u0448\u0430\u0432\u0430",warsaw:"\u0412\u0430\u0440\u0448\u0430\u0432\u0430",krakow:"\u041A\u0440\u0430\u043A\u043E\u0432",krak\u00F3w:"\u041A\u0440\u0430\u043A\u043E\u0432",wroclaw:"\u0412\u0440\u043E\u0446\u043B\u0430\u0432",wroc\u0142aw:"\u0412\u0440\u043E\u0446\u043B\u0430\u0432",gdansk:"\u0413\u0434\u0430\u043D\u044C\u0441\u043A",gda\u0144sk:"\u0413\u0434\u0430\u043D\u044C\u0441\u043A",poznan:"\u041F\u043E\u0437\u043D\u0430\u043D\u044C",pozna\u0144:"\u041F\u043E\u0437\u043D\u0430\u043D\u044C",lodz:"\u041B\u043E\u0434\u0437\u044C",\u0142\u00F3d\u017A:"\u041B\u043E\u0434\u0437\u044C",katowice:"\u041A\u0430\u0442\u043E\u0432\u0438\u0446\u0435",lublin:"\u041B\u044E\u0431\u043B\u0438\u043D",bialystok:"\u0411\u0435\u043B\u043E\u0441\u0442\u043E\u043A",szczecin:"\u0429\u0435\u0446\u0438\u043D",bydgoszcz:"\u0411\u044B\u0434\u0433\u043E\u0449",torun:"\u0422\u043E\u0440\u0443\u043D\u044C",toru\u0144:"\u0422\u043E\u0440\u0443\u043D\u044C",olsztyn:"\u041E\u043B\u044C\u0448\u0442\u044B\u043D",rzeszow:"\u0416\u0435\u0448\u0443\u0432",czestochowa:"\u0427\u0435\u043D\u0441\u0442\u043E\u0445\u043E\u0432\u0430",gdynia:"\u0413\u0434\u044B\u043D\u044F",sosnowiec:"\u0421\u043E\u0441\u043D\u043E\u0432\u0435\u0446",gliwice:"\u0413\u043B\u0438\u0432\u0438\u0446\u0435",kyiv:"\u041A\u0438\u0435\u0432",kiev:"\u041A\u0438\u0435\u0432",lviv:"\u041B\u044C\u0432\u043E\u0432",lvov:"\u041B\u044C\u0432\u043E\u0432",kharkiv:"\u0425\u0430\u0440\u044C\u043A\u043E\u0432",kharkov:"\u0425\u0430\u0440\u044C\u043A\u043E\u0432",odessa:"\u041E\u0434\u0435\u0441\u0441\u0430",odesa:"\u041E\u0434\u0435\u0441\u0441\u0430",dnipro:"\u0414\u043D\u0435\u043F\u0440",zaporizhzhia:"\u0417\u0430\u043F\u043E\u0440\u043E\u0436\u044C\u0435",zhytomyr:"\u0416\u0438\u0442\u043E\u043C\u0438\u0440",vinnytsia:"\u0412\u0438\u043D\u043D\u0438\u0446\u0430","ivano-frankivsk":"\u0418\u0432\u0430\u043D\u043E-\u0424\u0440\u0430\u043D\u043A\u043E\u0432\u0441\u043A",ternopil:"\u0422\u0435\u0440\u043D\u043E\u043F\u043E\u043B\u044C",chernivtsi:"\u0427\u0435\u0440\u043D\u043E\u0432\u0446\u044B",uzhhorod:"\u0423\u0436\u0433\u043E\u0440\u043E\u0434",uzhorod:"\u0423\u0436\u0433\u043E\u0440\u043E\u0434",rivne:"\u0420\u043E\u0432\u043D\u043E",lutsk:"\u041B\u0443\u0446\u043A",khmelnytskyi:"\u0425\u043C\u0435\u043B\u044C\u043D\u0438\u0446\u043A\u0438\u0439",mykolaiv:"\u041D\u0438\u043A\u043E\u043B\u0430\u0435\u0432",kherson:"\u0425\u0435\u0440\u0441\u043E\u043D",poltava:"\u041F\u043E\u043B\u0442\u0430\u0432\u0430",cherkasy:"\u0427\u0435\u0440\u043A\u0430\u0441\u0441\u044B",chernihiv:"\u0427\u0435\u0440\u043D\u0438\u0433\u043E\u0432",sumy:"\u0421\u0443\u043C\u044B",mukachevo:"\u041C\u0443\u043A\u0430\u0447\u0435\u0432\u043E",berlin:"\u0411\u0435\u0440\u043B\u0438\u043D",munich:"\u041C\u044E\u043D\u0445\u0435\u043D",munchen:"\u041C\u044E\u043D\u0445\u0435\u043D",hamburg:"\u0413\u0430\u043C\u0431\u0443\u0440\u0433",frankfurt:"\u0424\u0440\u0430\u043D\u043A\u0444\u0443\u0440\u0442",hannover:"\u0413\u0430\u043D\u043D\u043E\u0432\u0435\u0440",dresden:"\u0414\u0440\u0435\u0437\u0434\u0435\u043D",koln:"\u041A\u0451\u043B\u044C\u043D",k\u00F6ln:"\u041A\u0451\u043B\u044C\u043D",bremen:"\u0411\u0440\u0435\u043C\u0435\u043D",stuttgart:"\u0428\u0442\u0443\u0442\u0433\u0430\u0440\u0442",dusseldorf:"\u0414\u044E\u0441\u0441\u0435\u043B\u044C\u0434\u043E\u0440\u0444",dortmund:"\u0414\u043E\u0440\u0442\u043C\u0443\u043D\u0434",leipzig:"\u041B\u0435\u0439\u043F\u0446\u0438\u0433",wien:"\u0412\u0435\u043D\u0430",prague:"\u041F\u0440\u0430\u0433\u0430",praha:"\u041F\u0440\u0430\u0433\u0430",brno:"\u0411\u0440\u043D\u043E",bratislava:"\u0411\u0440\u0430\u0442\u0438\u0441\u043B\u0430\u0432\u0430",budapest:"\u0411\u0443\u0434\u0430\u043F\u0435\u0448\u0442",vilnius:"\u0412\u0438\u043B\u044C\u043D\u044E\u0441",kaunas:"\u041A\u0430\u0443\u043D\u0430\u0441",klaipeda:"\u041A\u043B\u0430\u0439\u043F\u0435\u0434\u0430",riga:"\u0420\u0438\u0433\u0430",tallinn:"\u0422\u0430\u043B\u043B\u0438\u043D",amsterdam:"\u0410\u043C\u0441\u0442\u0435\u0440\u0434\u0430\u043C",brussels:"\u0411\u0440\u044E\u0441\u0441\u0435\u043B\u044C",paris:"\u041F\u0430\u0440\u0438\u0436",london:"\u041B\u043E\u043D\u0434\u043E\u043D",milan:"\u041C\u0438\u043B\u0430\u043D",milano:"\u041C\u0438\u043B\u0430\u043D",rome:"\u0420\u0438\u043C",roma:"\u0420\u0438\u043C",madrid:"\u041C\u0430\u0434\u0440\u0438\u0434",barcelona:"\u0411\u0430\u0440\u0441\u0435\u043B\u043E\u043D\u0430"},L=Object.keys(h).sort((t,e)=>e.length-t.length),M=[/возьму/i,/могу взять/i,/взять посылк/i,/могу передать/i,/могу забрать/i,/везу/i,/везём/i,/везем/i,/перевезу/i,/доставлю/i,/заберу/i,/отвезу/i,/повезу/i,/отвожу/i,/попутчик/i,/есть\s+мест\w*/i,/место есть/i,/мест\w*\s+свободн/i,/свободн\w* мест\w*/i,/погрузк/i,/загруж\w+\s*(?:сам|машину)/i,/выезжаю/i,/отправляю(?:сь|ю)\s+рейс/i,/еду/i,/поеду/i,/беру/i],Y=[/везёт/i,/везет/i,/отвез/i,/попутк/i,/попутно/i,/доставк/i,/перевозк/i,/перевоз/i,/перевезти/i,/груз/i,/рейс/i,/маршрут/i,/бронь/i,/бронир/i,/выезд\w*/i,/заряд/i,/отвоз/i],_=[/нужно передать/i,/надо передать/i,/нужн\w* (?:передать|отправить|забрать)/i,/необходим\w*\s*(?:передать|отправить|забрать)/i,/осталось передать/i,/ищу/i,/ищ[уе] (?:водителя|курьера|попутку)/i,/нужн\w* (?:водитель|курьер)/i,/кто[\s-]*(?:то|нибудь|либо)/i,/есть\s+кто/i,/может\s+кто/i,/кто-нибудь/i,/кто\s+(?:может|сможет|возьм[её]т|перевез[её]т|привез[её]т|едет|поедет|летит|вез[её]т|возит|занимает|помож[её]т|помогает|переда[её]т|отвез|подвез|довез|забер|доставит|отправит|приедет)/i,/(?:занимает|возит|возмёт|берет|берёт|доставляет|помогает)\s+(?:ли\s+)?кто/i,/занимает(?:есь|ся)\s+(?:ли\s+)?(?:перевоз\w*|доставк\w*|посылк\w*|передач\w*|груз\w*)/i,/(?:кто|куда|где)\s+(?:обратиться|писать|кидать)/i,/помогите/i,/помощь с передачей/i,/подскаж/i,/не\s+подскаж/i,/посоветуй/i,/передайте/i,/прошу/i,/хочу (?:передать|отправить|переслать)/i,/нужно (?:доставить|отправить|переслать)/i,/надо (?:доставить|отправить|переслать)/i],O=[/передать посылк/i,/посылк\w* (?:передать|доставить)/i,/привезти/i,/подвезти/i,/переслать/i,/помож[её]т/i,/кто передаёт/i,/кто передает/i,/перевоз\w*\s+посылок/i,/доставк\w*\s+посылок/i],D=2,P=1;function d(t,e,n){let r=0;for(let i of e)i.test(t)&&(r+=D);for(let i of n)i.test(t)&&(r+=P);return r}var N={\u043F\u043E\u043D\u0435\u0434\u0435\u043B\u044C\u043D\u0438\u043A:1,\u0432\u0442\u043E\u0440\u043D\u0438\u043A:2,\u0441\u0440\u0435\u0434\u0430:3,\u0441\u0440\u0435\u0434\u0443:3,\u0447\u0435\u0442\u0432\u0435\u0440\u0433:4,\u043F\u044F\u0442\u043D\u0438\u0446\u0430:5,\u043F\u044F\u0442\u043D\u0438\u0446\u0443:5,\u0441\u0443\u0431\u0431\u043E\u0442\u0430:6,\u0441\u0443\u0431\u0431\u043E\u0442\u0443:6,\u0432\u043E\u0441\u043A\u0440\u0435\u0441\u0435\u043D\u044C\u0435:0,\u0432\u043E\u0441\u043A\u0440\u0435\u0441\u0435\u043D\u044C\u044F:0},G=[["\u044F\u043D\u0432\u0430\u0440",1],["\u0444\u0435\u0432\u0440\u0430\u043B",2],["\u043C\u0430\u0440\u0442",3],["\u0430\u043F\u0440\u0435\u043B",4],["\u043C\u0430[\u0439\u0435\u044F]",5],["\u0438\u044E\u043D",6],["\u0438\u044E\u043B",7],["\u0430\u0432\u0433\u0443\u0441\u0442",8],["\u0441\u0435\u043D\u0442\u044F\u0431\u0440",9],["\u043E\u043A\u0442\u044F\u0431\u0440",10],["\u043D\u043E\u044F\u0431\u0440",11],["\u0434\u0435\u043A\u0430\u0431\u0440",12],["\u0441\u0456\u0447\u0435\u043D",1],["\u043B\u044E\u0442",2],["\u0431\u0435\u0440\u0435\u0437\u043D",3],["\u043A\u0432\u0456\u0442\u043D",4],["\u0442\u0440\u0430\u0432\u043D",5],["\u0447\u0435\u0440\u0432",6],["\u043B\u0438\u043F",7],["\u0441\u0435\u0440\u043F",8],["\u0432\u0435\u0440\u0435\u0441\u043D",9],["\u0436\u043E\u0432\u0442\u043D",10],["\u043B\u0438\u0441\u0442\u043E\u043F\u0430\u0434",11],["\u0433\u0440\u0443\u0434\u043D",12]];var u="\u0430-\u044F\u0451a-z";function w(t){let e=[],n=t.toLowerCase().replace(/ё/g,"\u0435");for(let r of L){let i=r.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),s=new RegExp(`(?<![${u}0-9])${i}[${u}]?(?![${u}0-9])`,"g"),a;for(;(a=s.exec(n))!==null;)e.push({city:h[r],index:a.index,end:a.index+a[0].length})}return e.sort((r,i)=>r.index-i.index)}var W=/^(?:\s*(?:->|=>|>>|→|⇒|—|–|−|-|до|в|на|из|с|от)\s*(?:[а-яёa-z]{0,12}\s*)?)$/;function z(t){let e=t.toLowerCase().replace(/ё/g,"\u0435").replace(/[^\p{L}\- ]/gu," ").replace(/\s+/g," ").trim();if(!e)return t.trim();let n=h[e];if(n)return n;let r=w(e);return r.length>0?r[0].city:e.split(" ").map(s=>s.length>0?s[0].toUpperCase()+s.slice(1):s).join(" ").slice(0,60)}function H(t){let e=w(t);for(let n=0;n<e.length;n++)for(let r=n+1;r<e.length;r++){let i=e[n],s=e[r];if(s.index<i.end||i.city===s.city)continue;let a=t.slice(i.end,s.index);if(a.length>40)continue;let o=a.trim();if(o===""||W.test(o))return{from:i.city,to:s.city}}return null}function m(t,e){return new RegExp(`(^|[^${u}0-9])${e}([^${u}0-9]|$)`).test(t)}function U(t,e=new Date){let n=t.toLowerCase().replace(/ё/g,"\u0435");if(m(n,"\u043F\u043E\u0441\u043B\u0435\u0437\u0430\u0432\u0442\u0440\u0430"))return l(k(e,2));if(m(n,"\u0437\u0430\u0432\u0442\u0440\u0430"))return l(k(e,1));if(m(n,"\u0441\u0435\u0433\u043E\u0434\u043D\u044F"))return l(e);for(let[i,s]of Object.entries(N))if(new RegExp(`(^|[^${u}0-9])${i}([^${u}0-9]|$)`).test(n)){let o=new Date(e),c=(s-o.getDay()+7)%7||7;return o.setDate(o.getDate()+c),l(o)}let r=n.match(/(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/);if(r){let i=parseInt(r[1],10),s=parseInt(r[2],10);if(i>=1&&i<=31&&s>=1&&s<=12){let a=r[3]?parseInt(r[3],10):e.getFullYear();a<100&&(a+=2e3);let o=new Date(a,s-1,i);if(o.getDate()===i&&o.getMonth()===s-1)return!r[3]&&o<b(e)&&o.setFullYear(o.getFullYear()+1),l(o)}}for(let[i,s]of G){let a=new RegExp(`(\\d{1,2})[^\\d\u0430-\u044F\u0451]{0,3}${i}`),o=n.match(a);if(o){let c=parseInt(o[1],10);if(c>=1&&c<=31){let f=new Date(e.getFullYear(),s-1,c);if(f.getDate()===c)return f<b(e)&&f.setFullYear(f.getFullYear()+1),l(f)}}}return null}function k(t,e){let n=new Date(t);return n.setDate(n.getDate()+e),n}function b(t){return new Date(t.getFullYear(),t.getMonth(),t.getDate())}function l(t){let e=t.getFullYear(),n=String(t.getMonth()+1).padStart(2,"0"),r=String(t.getDate()).padStart(2,"0");return`${e}-${n}-${r}`}function K(t){let e=t.match(/(?:до\s*)?(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:кг|kg|кило|килограмм)/i);if(!e)return null;let n=parseFloat(e[1].replace(",","."));return!Number.isFinite(n)||n<=0||n>1e3?null:Math.round(n*100)/100}function j(t){let e=t.match(/(\d{1,3}(?:\s?\d{3})*(?:[.,]\d{1,2})?)\s*(зл|злот|zl|zł|pln|евро|eur|€|\$|грн|грив|uah|руб|₽|р\.)/i);if(!e)return null;let n=e[1].trim(),r=e[2].trim().toUpperCase();return`${n} ${r==="\u0417\u041B"||r==="Z\u0141"||r==="ZL"||r==="PLN"?"z\u0142":r==="\u0415\u0412\u0420\u041E"||r==="EUR"||r==="\u20AC"?"\u20AC":r==="$"?"$":r==="\u0413\u0420\u041D"||r==="\u0413\u0420\u0418\u0412"||r==="UAH"?"\u0433\u0440\u043D":r==="\u0420\u0423\u0411"||r==="RUB"||r==="\u20BD"||r==="\u0420."?"\u20BD":""}`.trim()}function Z(t){let e=t.match(/\+?[\d][\d\s\-()]{8,17}[\d]/);if(!e)return null;let n=e[0].replace(/[^\d+]/g,"");return n.replace(/\D/g,"").length<9||n.replace(/\D/g,"").length>16?null:e[0].trim()}function Q(t){let e=t.match(/(?:t\.me\/|https?:\/\/t\.me\/|@)([a-zA-Z0-9_]{4,32})/);return e?`@${e[1]}`:null}function g(t){let e=d(t,M,[]),n=d(t,_,[]);return{offerStrong:e,requestStrong:n,offer:e+d(t,[],Y),request:n+d(t,[],O)}}function S(t,e){let{offer:n,request:r}=t;return n===r?n===0?null:/\?/.test(e)||/передать/i.test(e)?"request":"offer":n>r?"offer":"request"}function B(t){return S(g(t),t)}function J(t){let e=typeof t=="string"?g(t):t;if(e.offer===0&&e.request===0)return!0;if(e.offer===e.request)return!1;let n=e.offer>e.request?"offer":"request";return n==="offer"&&e.offerStrong>0&&e.requestStrong===0||n==="request"&&e.requestStrong>0&&e.offerStrong===0?!0:Math.abs(e.offer-e.request)>=D}function R(t){return/обратно|туда[-\u2013 ]?обратно/i.test(t)?!0:(t.match(/(?<!\d)\d{1,2}[-\u2013.]\d{1,2}(?:\.\d{1,2})?(?!\d)(?!\s*(?:кг|kg|тонн))/gi)??[]).length>=2}function y(t,e=new Date){let n=H(t),r=g(t),i=S(r,t)??(n?"offer":null),s=!J(r);return{intent:i,fromCity:n?.from??null,toCity:n?.to??null,departureDate:U(t,e),weightKg:K(t),price:j(t),telegram:Q(t),phone:Z(t),confidence:n&&i?s?.6:.9:n?.7:i?.5:0}}var V=[/пассажир/i,/(?:довез|подвез|подброс|доехать|проехать)/i,/ищ[уе]\s+попутк/i],E=/посылк|бандерол|переда|груз|вещи|коробк|документ|печат|лекарств|медикамент|запечат/i;function I(t){return V.some(e=>e.test(t))?!E.test(t):!1}var X=/(?:\bкто\b|ищ[уи]|надо|нужн|можно|переда[йът]|отвез|забер|привез|подвез|довез|мест[ао]?\b)/i;function $(t){return B(t)!==null||E.test(t)||w(t).length>0?!0:X.test(t)}function v(t,e=new Date){let n=y(t,e);return n.intent!==null&&(n.fromCity!==null||n.toCity!==null)}return F(ee);})();


/* ---- extension/core.js ---- */
/**
 * Ядро сборщика для Telegram Web — ЧИСТАЯ логика, без DOM и без fetch.
 *
 * Файл намеренно в формате UMD и с расширением .js:
 *   - в расширении/юзерскрипте подключается обычным <script> (content scripts
 *     в MV3 не умеют ES-модули) и кладёт API в globalThis.PoputkaCore;
 *   - в тестах импортируется как CommonJS (tests/extension-core.test.ts) —
 *     для этого рядом лежит extension/package.json с "type": "commonjs".
 *
 * Расширение именно .js обязательно: Chrome определяет тип файла контент-скрипта
 * по расширению и отказывается грузить .cjs («Invalid script mime type») — тогда
 * не внедряется НИ ОДИН файл списка, и вкладка «не отвечает».
 *
 * Здесь всё, что можно проверить без браузера: белый список чатов, ключи
 * chatId, клиентский детект объявлений, локальная дедупликация, батчи,
 * backoff, классификация ошибок HTTP и сборка тела запроса под контракт
 * POST /api/ingest.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PoputkaCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Версия клиента — уходит в поле collector (ТЗ п. 4.3). */
  const COLLECTOR = 'tg-web-ext/1.0.4';

  /** Настройки по умолчанию. Всё хранится в chrome.storage / localStorage. */
  const DEFAULT_SETTINGS = {
    /** Базовый URL воркера, например https://pop-utka.app */
    serverUrl: '',
    /** INGEST_TOKEN (wrangler secret put INGEST_TOKEN) */
    token: '',
    /** Опрос вкладки: 60–180 с (ТЗ п. 4.5) */
    intervalSec: 120,
    /** Не больше ~20 сообщений за один POST */
    batchSize: 20,
    /** Сколько последних сообщений чата читать за проход */
    maxPerChat: 30,
    /** Спрашивать подтверждение перед отправкой (по умолчанию включён) */
    confirmMode: true,
    /** Пауза — ничего не читаем и не отправляем */
    paused: false,
    /** Белый список чатов: названия или ссылки t.me/… (пусто — ничего не собираем) */
    whitelist: [],
    /** Локальный отсев: сообщения старше N часов не отправляем */
    maxAgeHours: 72,
    /** Отправлять только сообщения с контактом (телефон/@username) */
    requireContact: false,

    /* Автообход: расширение само открывает чаты и румы из белого списка.
       По умолчанию ВЫКЛЮЧЕН — это уже автоматизация аккаунта (см. walkDecision). */
    autoWalk: false,
    /** Сколько проходов прочитать в одном чате, прежде чем уйти дальше */
    walkReadsPerChat: 2,
    /** Случайная пауза перед переходом: от… */
    walkMinSec: 60,
    /** …до (пауза каждый раз разная — как у человека) */
    walkMaxSec: 240,
    /** Предел переходов в час: защита от «слишком бодрого» обхода */
    walkMaxPerHour: 20,
    /** Не переключать чат, пока пользователь сам печатает/кликает (0 — не ждать) */
    walkIdleGuardSec: 45,
    /** Служебный лог отправленного (ключи chatId:messageId), хранится отдельно */
  };

  /** Сколько ключей «отправлено» держим локально: память не резиновая. */
  const SENT_LOG_LIMIT = 3000;

  /* ---------------------------------------------------------------- */
  /* Хранилище настроек: chrome.storage.local или localStorage         */
  /* ---------------------------------------------------------------- */

  /** chrome.storage.local (расширение) */
  function chromeStore(namespace) {
    return {
      async read() {
        const all = await chrome.storage.local.get(namespace);
        return all[namespace] || {};
      },
      async write(data) {
        await chrome.storage.local.set({ [namespace]: data });
      },
    };
  }

  /** localStorage (юзерскрипт) */
  function localStore(namespace) {
    return {
      read() {
        try { return JSON.parse(localStorage.getItem(namespace) || '{}') || {}; }
        catch { return {}; }
      },
      write(data) {
        localStorage.setItem(namespace, JSON.stringify(data));
        return Promise.resolve();
      },
    };
  }

  /** Настройки с дефолтами + валидацией диапазонов. */
  function withDefaults(raw) {
    const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
    s.intervalSec = clamp(Number(s.intervalSec) || DEFAULT_SETTINGS.intervalSec, 60, 600);
    s.batchSize = clamp(Math.round(Number(s.batchSize) || DEFAULT_SETTINGS.batchSize), 1, 100);
    s.maxPerChat = clamp(Math.round(Number(s.maxPerChat) || DEFAULT_SETTINGS.maxPerChat), 1, 200);
    s.maxAgeHours = clamp(Number(s.maxAgeHours) || DEFAULT_SETTINGS.maxAgeHours, 1, 24 * 30);
    s.confirmMode = s.confirmMode !== false;
    s.paused = s.paused === true;
    s.requireContact = s.requireContact === true;
    s.autoWalk = s.autoWalk === true;
    s.walkReadsPerChat = clamp(Math.round(Number(s.walkReadsPerChat) || DEFAULT_SETTINGS.walkReadsPerChat), 1, 20);
    s.walkMinSec = clamp(Math.round(Number(s.walkMinSec) || DEFAULT_SETTINGS.walkMinSec), 10, 3600);
    s.walkMaxSec = clamp(Math.round(Number(s.walkMaxSec) || DEFAULT_SETTINGS.walkMaxSec), 10, 7200);
    if (s.walkMaxSec < s.walkMinSec) s.walkMaxSec = s.walkMinSec;
    s.walkMaxPerHour = clamp(Math.round(Number(s.walkMaxPerHour) || DEFAULT_SETTINGS.walkMaxPerHour), 1, 600);
    s.walkIdleGuardSec = clamp(Math.round(Number(s.walkIdleGuardSec) || 0), 0, 1800);
    s.whitelist = Array.isArray(s.whitelist) ? s.whitelist.filter((x) => typeof x === 'string' && x.trim()) : [];
    s.serverUrl = String(s.serverUrl || '').trim().replace(/\/+$/, '');
    s.token = String(s.token || '').trim();
    return s;
  }

  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

  /**
   * Годится ли URL сервера. Возвращает текст проблемы или null.
   * https — всегда; http — только для локальной отладки (127.0.0.1/localhost),
   * потому что страница web.telegram.org открыта по https и обычный http-адрес
   * браузер заблокирует как mixed content.
   */
  function serverUrlProblem(raw) {
    const url = String(raw || '').trim();
    if (!url) return 'Укажите базовый URL сервера (например https://pop-utka.app).';
    if (/^https:\/\/[^\s/]/.test(url)) return null;
    if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(url)) return null;
    return 'URL сервера должен начинаться с https://. Для локальной отладки годится ' +
      'http://127.0.0.1:8790 — остальные http-адреса браузер заблокирует как mixed content ' +
      '(страница Telegram Web открыта по https).';
  }

  /* ---------------------------------------------------------------- */
  /* Белый список чатов                                                */
  /* ---------------------------------------------------------------- */

  /** Запись белого списка: ссылка t.me/<username>, @username или название чата. */
  /**
   * Канонический peer-id чата из того, что отдаёт Telegram Web.
   *
   * Клиент показывает чат по-разному: /k/#-1001234567890, /a/#/im?p=g1234567890,
   * ?p=u123456 (личный), ?p=c123456 (обычная группа). Приводим к одному виду —
   * тогда из приватной супергруппы можно построить служебную ссылку
   * https://t.me/c/<id>/<msgId>, которая открывается у участников чата
   * (именно её просит модератор: «дать ссылку на сообщение, чтобы переслать»).
   */
  function normalizePeerId(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    let m = /^[gG](\d{4,})$/.exec(s);                 // супергруппа/канал: g1234567890
    if (m) return { id: '-100' + m[1], kind: 'supergroup' };
    m = /^[cC](\d{4,})$/.exec(s);                     // обычная группа: c1234567890
    if (m) return { id: '-' + m[1], kind: 'group' };
    m = /^[uU](\d{4,})$/.exec(s);                     // личный чат: u1234567890
    if (m) return { id: m[1], kind: 'user' };
    if (/^-100\d{4,}$/.test(s)) return { id: s, kind: 'supergroup' };
    if (/^-\d{4,}$/.test(s)) return { id: s, kind: 'group' };
    if (/^\d{4,}$/.test(s)) return { id: s, kind: 'user' };
    return null;
  }

  function normalizeWhitelistEntry(raw) {
    const value = String(raw || '').trim();
    if (!value) return null;
    // «чат :: тема» — считать только один рум (топик) форум-супергруппы.
    // Тема задаётся названием («Граница :: Очередь BY-PL») или id («Граница :: 12»).
    const parts = value.split(/\s*(?:::|>>)\s*/);
    const base = normalizeChatPart((parts[0] || '').trim());
    if (!base) return null;
    base.raw = String(raw).trim();
    const topicPart = (parts[1] || '').trim();
    if (!topicPart) return base;
    if (/^\d{1,12}$/.test(topicPart)) {
      return Object.assign(base, { topicId: Number(topicPart), topic: null, topicStrict: true, raw: raw });
    }
    return Object.assign(base, { topic: squashTitle(topicPart), topicId: null, topicStrict: true, raw: raw });
  }

  /**
   * Запись белого списка → { kind, value, topicId?, topic?, topicStrict? }.
   *
   * Рум (топик) форум-чата можно задать тремя способами:
   *   «Граница :: Очередь BY-PL» / «Граница :: 7»  — явно;
   *   «t.me/travelersminsk/91529»                  — ссылкой на рум (как её даёт Telegram);
   *   «t.me/travelersminsk/91529/713464»           — ссылкой на сообщение в руме:
   *                                                первое число — рум, второе — сообщение;
   *   «t.me/c/1234567890/91529»                    — то же для приватной супергруппы.
   */
  function normalizeChatPart(value) {
    if (!value) return null;

    // приватная супергруппа/канал: t.me/c/<id>[/<рум>[/<сообщение>]]
    const priv = /t\.me\/c\/(\d{4,})(?:\/(\d{1,12}))?(?:\/(\d{1,12}))?/i.exec(value);
    if (priv) {
      const entry = { kind: 'peer', value: '-100' + priv[1] };
      if (priv[2]) { entry.topicId = Number(priv[2]); entry.topicStrict = true; }
      return entry;
    }

    // публичный чат: t.me/<username>[/<рум>[/<сообщение>]]
    const link = /t\.me\/(?:s\/)?@?([A-Za-z][A-Za-z0-9_]{3,31})(?:\/(\d{1,12}))?(?:\/(\d{1,12}))?/i.exec(value);
    if (link) {
      const entry = { kind: 'username', value: link[1].toLowerCase() };
      if (link[2]) {
        entry.topicId = Number(link[2]);
        // три сегмента — точно рум + сообщение; два — может быть и ссылкой на сообщение
        // в обычном чате, поэтому такую запись смягчаем (см. matchesWhitelist)
        entry.topicStrict = Boolean(link[3]);
      }
      return entry;
    }

    const at = /^@([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(value);
    if (at) return { kind: 'username', value: at[1].toLowerCase() };
    return { kind: 'title', value: squashTitle(value) };
  }

  function normalizeWhitelist(list) {
    // терпим к строке (настройки из панели могут прийти текстом): режем по строкам/запятым
    const arr = typeof list === 'string'
      ? list.split(/[\n,;]+/)
      : (Array.isArray(list) ? list : []);
    return arr.map(normalizeWhitelistEntry).filter(Boolean);
  }

  /**
   * Сравнимый вид названия чата: регистр, ё/е, разные тире и повторы пробелов
   * не должны мешать совпадению («Водители Польша–Беларусь» = «водители польша-беларусь»).
   */
  function squashTitle(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[\u2010-\u2015\u2212]/g, '-') // ‐‑–—–− → обычный дефис
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Пускаем ли чат в работу. Вне белого списка сообщения не читаются ВОВСЕ
   * (ТЗ п. 4.5) — это главная защита от лишнего трафика и от приватности.
   */
  function matchesWhitelist(chat, whitelist) {
    const entries = normalizeWhitelist(whitelist);
    if (entries.length === 0) return false;
    const titles = chatTitleCandidates(chat);
    const username = String((chat && chat.username) || '').toLowerCase();
    const peer = normalizePeerId(chat && chat.id);
    const peerId = peer ? peer.id : null;
    const topics = topicCandidates(chat);
    const topicId = chat && chat.topicId != null && chat.topicId !== '' ? Number(chat.topicId) : null;
    // форум ли открыт: знаем id рума или видим имя темы
    const looksLikeForum = topicId != null || topics.length > 0;

    for (const e of entries) {
      if (!chatPartMatches(e, titles, username, peerId)) continue;
      // запись без указания рума — берём весь чат, все румы
      if (e.topic == null && e.topicId == null) return true;
      if (e.topicId != null && topicId === e.topicId) return true;
      if (e.topic && topics.some((t) => t === e.topic || t.includes(e.topic) || e.topic.includes(t))) return true;
      // Ссылка t.me/<username>/<число> в чате, который не похож на форум, — это, скорее всего,
      // ссылка на сообщение, а не на рум. Читаем весь чат: иначе сбор молча встанет навсегда.
      if (e.topicId != null && e.topicStrict === false && !looksLikeForum) return true;
      // чат совпал, но рум задан и не совпал/не прочитался — не читаем (ТЗ: только белый список)
    }
    return false;
  }

  /** Названия, по которым узнаём чат: заголовок шапки и, если прочиталось, имя группы. */
  function chatTitleCandidates(chat) {
    const out = [];
    const t = squashTitle(chat && chat.title);
    const g = squashTitle(chat && chat.groupTitle);
    if (t) out.push(t);
    if (g && g !== t) out.push(g);
    return out;
  }

  /** Названия, по которым узнаём рум (топик): явный заголовок темы или шапка при найденной группе. */
  function topicCandidates(chat) {
    const out = [];
    const tt = squashTitle(chat && chat.topicTitle);
    if (tt) out.push(tt);
    const t = squashTitle(chat && chat.title);
    const g = squashTitle(chat && chat.groupTitle);
    if (g && t && t !== g) out.push(t);
    return out;
  }

  function chatPartMatches(entry, titles, username, peerId) {
    // запись ссылкой на приватный чат (t.me/c/<id>): сравниваем внутренние id
    if (entry.kind === 'peer') {
      return Boolean(peerId) && String(peerId) === String(entry.value);
    }
    if (entry.kind === 'username') {
      return Boolean(username && username === entry.value) ||
        // в названии чата иногда пишут юзернейм — считаем совпадением
        titles.some((t) => t.includes(entry.value));
    }
    return titles.some((t) => t === entry.value || t.includes(entry.value) || entry.value.includes(t));
  }

  /**
   * Почему чат не подошёл белому списку — для диагностики (на логику не влияет).
   * Отличает «чат не в списке» от «чат тот, но рум не совпал или не прочитался».
   */
  /**
   * Запасной вариант для форум-чатов.
   *
   * Бывает, что Telegram Web показывает заголовок открытого рума, но числовой
   * id рума в URL не отдаёт. Тогда запись вида `t.me/<чат>/<рум>` не с чем
   * сравнить, и сбор молча встал бы. Если в белом списке за этим чатом закреплён
   * РОВНО ОДИН рум — берём его id (и обязательно сообщаем об этом пользователю:
   * вызывающий печатает `note`).
   *
   * Возвращает { topicId, note } или null, если угадывать нельзя:
   * нет признаков открытого рума, румов закреплено несколько или ни одного.
   */
  function adoptTopicFromWhitelist(chat, whitelist) {
    if (!chat) return null;
    if (chat.topicId != null && chat.topicId !== '') return null;   // id и так прочитался
    if (topicCandidates(chat).length === 0) return null;            // не видно, что открыт рум

    const entries = normalizeWhitelist(whitelist);
    const titles = chatTitleCandidates(chat);
    const username = String(chat.username || '').toLowerCase();
    const peer = normalizePeerId(chat.id);
    const pinned = entries.filter((e) =>
      e.topicId != null && chatPartMatches(e, titles, username, peer ? peer.id : null));
    const ids = pinned.map((e) => e.topicId).filter((v, i, arr) => arr.indexOf(v) === i);
    if (ids.length !== 1) return null;                              // неоднозначно — не угадываем

    const room = topicCandidates(chat)[0];
    return {
      topicId: ids[0],
      note: 'id рума взят из ссылки в белом списке (клиент не отдал его в адресе). ' +
        'Проверьте, что открыт рум «' + (room || '?') + '».',
    };
  }

  function whitelistMismatch(chat, whitelist) {
    const entries = normalizeWhitelist(whitelist);
    if (entries.length === 0) return 'Белый список пуст — сообщения не читаются вовсе.';
    if (matchesWhitelist(chat, whitelist)) return null;
    const titles = chatTitleCandidates(chat);
    const username = String((chat && chat.username) || '').toLowerCase();
    const peer = normalizePeerId(chat && chat.id);
    const sameChat = entries.filter((e) => chatPartMatches(e, titles, username, peer ? peer.id : null));
    if (sameChat.length === 0) return 'Чат не в белом списке.';
    const topics = topicCandidates(chat);
    const hasTopicId = Boolean(chat && chat.topicId != null && chat.topicId !== '');
    if (topics.length === 0 && !hasTopicId) {
      return 'Чат в белом списке с указанием рума, но тема (рум) не прочиталась — сообщения не читаются. ' +
        'Откройте конкретный рум в Telegram Web (список тем румом не считается) ' +
        'или уберите указание рума из записи, если нужны все румы этого чата.';
    }
    return 'Чат в белом списке, но рум не совпал: открыт «' +
      (topics[0] || ('id ' + chat.topicId)) + '», а в списке «' +
      sameChat.map((e) => (e.topic || (e.topicId != null ? 'id ' + e.topicId : 'все румы'))).join(', ') + '».';
  }

  /* ---------------------------------------------------------------- */
  /* Ключи чата и сообщения                                            */
  /* ---------------------------------------------------------------- */

  /**
   * chatId для сервера (ТЗ п. 4.3):
   *   публичный чат  → 'web:<username>'   (совпадает с ключом серверного сборщика —
   *                    одно и то же сообщение из двух источников не даст дубль)
   *   приватный чат  → 'ext:<внутренний id>'
   */
  function chatKeyOf(chat) {
    if (!chat) return null;
    if (chat.username) return 'web:' + String(chat.username).replace(/^@/, '');
    const peer = normalizePeerId(chat && chat.id);
    if (peer) return 'ext:' + peer.id;
    if (chat.id !== undefined && chat.id !== null && chat.id !== '') return 'ext:' + chat.id;
    if (chat.title) return 'ext:' + stableId('title:' + squashTitle(chat.title));
    return null;
  }

  /**
   * Детерминированный положительный int31 из строки.
   *
   * Нужен, если DOM-клиент не отдаёт числовой id сообщения: сервер требует
   * `messageId: integer > 0`, а дедупликация на сервере идёт по паре
   * (chatId, messageId). Синтетический id устойчив: то же сообщение в том же
   * чате даст то же число и в следующий проход, и после перезапуска браузера,
   * поэтому tg_seen его отловит как duplicate.
   */
  function stableId(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    // 31 бит, строго > 0
    return (h & 0x7fffffff) || 1;
  }

  function syntheticMessageId(chatKey, text, dateMs) {
    return stableId([chatKey, String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500), dateMs || ''].join('|'));
  }

  /* ---------------------------------------------------------------- */
  /* Клиентский детект (ТЗ п. 4.5)                                     */
  /* ---------------------------------------------------------------- */

  /** Запасной список ключевых слов, если бандл парсера не подключился. */
  const KEYWORD_HINTS = /(посылк|бандерол|переда[мтн]|перевез|доставк|груз|вещи|коробк|документ|лекарств|возьму|везу|есть место|нужно передать|ищу|кто (?:везёт|едет|поедет|может))/i;
  const PASSENGER_HINTS = /(пассажир|подвезти|подвезёт|довезти человека|мест в машине|ищу попутку)/i;

  /**
   * Отправлять ли сообщение на сервер.
   * `parser` — бандл src/parser.ts (PoputkaParser); если его нет, работаем
   * по упрощённому списку слов (ТЗ это допускает, но тогда серверный dryRun
   * обязателен для предпросмотра).
   */
  function detect(text, parser, settings) {
    const body = String(text || '').replace(/\u00a0/g, ' ').trim();
    if (body.length < 10) return { send: false, reason: 'short' };
    if (body.length > 4000) return { send: false, reason: 'too_long' };

    const parsed = parser && typeof parser.parseTelegramMessage === 'function'
      ? parser.parseTelegramMessage(body)
      : null;

    const passenger = parser && typeof parser.isPassengerOnly === 'function'
      ? parser.isPassengerOnly(body)
      : (PASSENGER_HINTS.test(body) && !/(посылк|переда|груз|вещи|коробк|документ)/i.test(body));
    if (passenger) return { send: false, reason: 'passenger', parsed };

    const worth = parser && typeof parser.worthAiCheck === 'function'
      ? parser.worthAiCheck(body)
      : KEYWORD_HINTS.test(body);
    if (!worth) return { send: false, reason: 'chatter', parsed };

    const hasContact = Boolean(parsed && (parsed.phone || parsed.telegram)) ||
      /(\+?\d[\d\s\-()]{8,16}\d|@[A-Za-z][A-Za-z0-9_]{3,31}|t\.me\/[A-Za-z][A-Za-z0-9_]{3,31})/.test(body);
    if (settings && settings.requireContact && !hasContact) {
      return { send: false, reason: 'no_contact', parsed };
    }
    return { send: true, reason: 'ok', parsed, hasContact };
  }

  /* ---------------------------------------------------------------- */
  /* Возраст, дедупликация, батчи                                      */
  /* ---------------------------------------------------------------- */

  /** Сообщение не старше maxAgeHours (дата из DOM может быть приблизительной). */
  function withinAge(dateMs, maxAgeHours, now) {
    if (!dateMs) return true; // дату не достали — решит сервер (своя maxAgeDays)
    const ageHours = ((now || Date.now()) - dateMs) / 3600000;
    if (ageHours < -24 * 3) return false; // «дата в будущем» — явно мусор
    return ageHours <= (maxAgeHours || 72);
  }

  /** Ключ локальной отметки «уже отправлено». */
  function sentKey(chatId, messageId) { return chatId + ':' + messageId; }

  /** Отсеять то, что уже отправляли. `sent` — массив ключей из хранилища. */
  function filterUnsent(messages, sent) {
    const seen = new Set(Array.isArray(sent) ? sent : []);
    const out = [];
    for (const m of messages) {
      const key = sentKey(m.chatId, m.messageId);
      if (seen.has(key)) continue;
      seen.add(key); // защита от повторов внутри одной пачки
      out.push(m);
    }
    return out;
  }

  /** Режем на батчи не больше batchSize (серверный предел — 100). */
  function chunk(messages, size) {
    const n = Math.max(1, Math.min(100, size || 20));
    const out = [];
    for (let i = 0; i < messages.length; i += n) out.push(messages.slice(i, i + n));
    return out;
  }

  /** Не больше maxPerChat последних сообщений, по возрастанию времени. */
  function takeRecent(messages, maxPerChat) {
    const n = Math.max(1, maxPerChat || 30);
    const sorted = messages.slice().sort((a, b) => (a.dateMs || 0) - (b.dateMs || 0));
    return sorted.slice(-n);
  }

  /** Экспоненциальный backoff с джиттером и потолком (для 429/5xx/сети). */
  function backoffMs(attempt, baseMs, maxMs) {
    const base = baseMs || 5000;
    const cap = maxMs || 15 * 60 * 1000;
    const exp = Math.min(cap, base * Math.pow(2, Math.max(0, (attempt || 1) - 1)));
    const jitter = Math.round(exp * 0.2 * Math.random());
    return Math.min(cap, exp + jitter);
  }

  /**
   * Что делать с ошибкой HTTP (ТЗ п. 4.5):
   *   401/503 → остановиться и показать ошибку (токен отозван или фича выключена);
   *   429/5xx/сеть → backoff и повторить;
   *   400/413 → остановиться: клиент шлёт мусор, надо чинить контракт.
   */
  function classifyStatus(status) {
    if (status === 401 || status === 403) return 'stop_auth';
    if (status === 503) return 'stop_disabled';
    if (status === 429) return 'backoff';
    if (status >= 500) return 'backoff';
    if (status === 400 || status === 413) return 'stop_payload';
    if (status >= 200 && status < 300) return 'ok';
    return 'unknown';
  }

  /* ---------------------------------------------------------------- */
  /* Контракт POST /api/ingest                                         */
  /* ---------------------------------------------------------------- */

  /** Тело запроса из списка сообщений (поля — строго по контракту). */
  function buildPayload(messages, opts) {
    const o = opts || {};
    return {
      collector: o.collector || COLLECTOR,
      dryRun: o.dryRun === true,
      messages: messages.map((m) => {
        const out = {
          chatId: m.chatId,
          messageId: m.messageId,
          text: m.text,
        };
        if (m.chatTitle) out.chatTitle = m.chatTitle;
        if (m.chatUrl) out.chatUrl = m.chatUrl;
        // рум форум-чата: нужен серверу для ссылки t.me/<username>/<рум>/<сообщение>
        if (m.topicId) out.topicId = m.topicId;
        if (m.date) out.date = m.date;
        if (m.authorName) out.authorName = m.authorName;
        if (m.authorUsername) out.authorUsername = m.authorUsername;
        return out;
      }),
    };
  }

  /** Сообщение DOM → элемент контракта. */
  function toPayloadMessage(raw, settings) {
    const chat = raw.chat || {};
    const chatId = chat.chatId || chatKeyOf(chat);
    const text = String(raw.text || '').trim();
    const dateMs = raw.dateMs || null;
    const fromDom = Number.isInteger(raw.messageId) && raw.messageId > 0;
    const messageId = fromDom ? raw.messageId : syntheticMessageId(chatId, text, dateMs);
    const topicId = chat.topicId != null && chat.topicId !== '' ? Number(chat.topicId) : null;
    return {
      chatId,
      messageId,
      // рум (топик) форум-чата: сервер строит по нему правильную ссылку на сообщение
      topicId: Number.isInteger(topicId) && topicId > 0 ? topicId : null,
      // ссылка на само сообщение — для панели расширения и попапа (в контракт не уходит)
      link: messageLink(chat, messageId, { idSource: fromDom ? 'dom' : 'synthetic' }),
      text: text.slice(0, 4000),
      chatTitle: chat.title ? String(chat.title).slice(0, 120) : null,
      // публичная ссылка — только когда знаем юзернейм (приватные не публикуем)
      chatUrl: chat.username ? 'https://t.me/' + String(chat.username).replace(/^@/, '') : null,
      // unix-секунды, как в контракте
      date: dateMs ? Math.floor(dateMs / 1000) : null,
      authorName: raw.authorName ? String(raw.authorName).slice(0, 120) : null,
      authorUsername: raw.authorUsername ? String(raw.authorUsername).slice(0, 64) : null,
      dateMs,
      idSource: fromDom ? 'dom' : 'synthetic',
    };
  }

  /**
   * Ссылка на сообщение — чтобы открыть его в Telegram и переслать вручную.
   *
   * Формат Telegram:
   *   публичный чат            t.me/<username>[/<рум>]/<id сообщения>
   *   приватная супергруппа    t.me/c/<id без -100>[/<рум>]/<id сообщения>
   *
   * Для обычной группы и личного чата ссылок на сообщение не существует — null.
   * Синтетический id (DOM не отдал настоящий) ссылкой не снабжаем: она вела бы
   * на случайное сообщение, а не на найденное.
   */
  function messageLink(chat, messageId, opts) {
    const o = opts || {};
    const id = Number(messageId);
    if (!Number.isInteger(id) || id <= 0) return null;
    if (o.synthetic === true || o.idSource === 'synthetic') return null;

    const c = chat || {};
    const topicRaw = c.topicId != null && c.topicId !== '' ? Number(c.topicId) : null;
    const topicPart = topicRaw && Number.isInteger(topicRaw) && topicRaw > 0 ? '/' + topicRaw : '';

    const username = c.username ? String(c.username).replace(/^@/, '') : null;
    if (username) return 'https://t.me/' + username + topicPart + '/' + id;

    const peer = normalizePeerId(c.id);
    if (peer && /^-100\d+$/.test(peer.id)) {
      return 'https://t.me/c/' + peer.id.slice(4) + topicPart + '/' + id;
    }
    return null;
  }

  /** Счётчики по ответу сервера: что добавляем в локальный лог и в статистику. */
  function summarizeResponse(body, batch) {
    const out = { received: 0, created: 0, duplicate: 0, skipped: 0, invalid: 0, listings: 0, sentKeys: [] };
    const rejected = {};
    if (body && typeof body === 'object') {
      const s = body.summary || {};
      out.received = Number(s.received || 0);
      out.created = Number(s.created || 0);
      out.duplicate = Number(s.duplicate || 0);
      out.skipped = Number(s.skipped || 0);
      out.invalid = Number(s.invalid || 0);
      out.listings = Number(s.listings || 0);
      for (const r of body.results || []) {
        if (!r || !r.chatId) continue;
        if (r.status === 'invalid') {
          // такое сообщение сервер не принял — оставляем его на повтор
          if (r.messageId) rejected[sentKey(r.chatId, r.messageId)] = true;
          continue;
        }
        // duplicate/created/skipped — сообщение обработано, повторно слать не нужно
        if (r.messageId) out.sentKeys.push(sentKey(r.chatId, r.messageId));
      }
    }
    /*
     * Страховка от повторов. Ответ без results (старая версия сервера, прокси,
     * пустое тело) не повод слать тот же батч каждый проход: что отправили сами
     * и сервер принял (2xx), то считаем обработанным. Исключение — сообщения,
     * которые сервер прямо назвал invalid.
     */
    for (const m of (batch || [])) {
      if (!m || m.chatId == null || m.messageId == null) continue;
      const key = sentKey(m.chatId, m.messageId);
      if (rejected[key] || out.sentKeys.indexOf(key) !== -1) continue;
      out.sentKeys.push(key);
    }
    return out;
  }

  /**
   * Объяснить ошибку «вкладка не отвечает» так, чтобы было понятно, что делать.
   * alive — последняя отметка контент-скрипта из storage (heartbeat), её может не быть.
   */
  function explainTabError(errText, alive, now) {
    const text = String(errText || '');
    const at = now || Date.now();
    const ageMin = alive && alive.at ? Math.round((at - Number(alive.at)) / 60000) : null;
    const ageText = ageMin == null ? null : (ageMin <= 0 ? 'только что' : ageMin + ' мин назад');

    if (/Extension context invalidated/i.test(text)) {
      return 'Расширение обновлено или переустановлено, а вкладка держит старую копию. Обновите web.telegram.org (F5). ' +
        'Если не поможет — удалите расширение и загрузите папку extension/ заново: после повторного скачивания ZIP ' +
        'папка часто переезжает, и Chrome продолжает смотреть в старое место.';
    }
    if (/Receiving end does not exist|message port closed|Could not establish connection/i.test(text)) {
      if (alive && alive.ok === false && alive.error) {
        return 'Контент-скрипт загрузился, но упал при инициализации: ' + alive.error +
          '. Обновите вкладку; если повторится — пришлите этот текст.';
      }
      if (alive && ageText) {
        return 'Расширение отвечало в этой вкладке ' + ageText + ', но сейчас не отвечает. ' +
          'Нажмите «Подключить к вкладке» (или обновите web.telegram.org — F5) и повторите.';
      }
      return 'Контент-скрипт не подключён к этой вкладке: она открыта раньше установки расширения, ' +
        'восстановлена из кэша или расширению урезали доступ к сайту. Нажмите «Подключить к вкладке» — ' +
        'попап внедрит скрипт сам, без перезагрузки. Если кнопки нет (старая копия папки), обновите ' +
        'web.telegram.org (F5) и проверьте chrome://extensions → «Доступ к сайту» → «На всех сайтах».';
    }
    if (/Cannot access|Permission|not allowed|May not be permitted/i.test(text)) {
      return 'Браузер не даёт расширению доступ к вкладке: ' + text +
        '. Убедитесь, что адрес вкладки начинается с https://web.telegram.org/';
    }
    return text ? 'Вкладка не ответила: ' + text : 'Вкладка не ответила.';
  }

  /** Слить счётчики проходов. */
  function mergeCounters(a, b) {
    const base = a || {};
    const add = b || {};
    const keys = ['found', 'sent', 'received', 'created', 'duplicate', 'skipped', 'invalid', 'listings', 'runs', 'errors'];
    const out = {};
    for (const k of keys) out[k] = Number(base[k] || 0) + Number(add[k] || 0);
    out.lastRunAt = add.lastRunAt || base.lastRunAt || null;
    out.lastError = add.lastError !== undefined ? add.lastError : base.lastError || null;
    return out;
  }

  /** Обрезать лог отправленного до SENT_LOG_LIMIT (храним самые свежие). */
  function pruneSentLog(keys, limit) {
    const arr = Array.isArray(keys) ? keys : [];
    const max = limit || SENT_LOG_LIMIT;
    return arr.length > max ? arr.slice(arr.length - max) : arr;
  }

  /* ---------------------------------------------------------------- */
  /* Диагностика                                                       */
  /* ---------------------------------------------------------------- */

  /** Короткий отчёт «что вижу в вкладке» — для попапа и отладки разметки. */
  /* ---------------------------------------------------------------- */
  /* Автообход чатов и румов                                           */
  /* ---------------------------------------------------------------- */

  /**
   * План обхода — цели из белого списка, по порядку записей.
   *
   * Цель описывает, КАК её открыть: юзернейм/peer-id (переход по адресу, как если
   * бы пользователь сам вставил ссылку) или только название (тогда остаётся клик
   * по строке в боковой панели — см. dom.findChatRow).
   */
  function walkTargets(whitelist) {
    const seen = {};
    const out = [];
    for (const entry of normalizeWhitelist(whitelist)) {
      // «Граница :: Очередь BY-PL»: имя рума нужно, чтобы найти строку в списке
      const key = entry.kind + ':' + entry.value + ':' + (entry.topicId || '') + ':' + (entry.topic || '');
      if (seen[key]) continue;
      seen[key] = true;
      const label = entry.kind === 'peer'
        ? 'приватный чат ' + entry.value + (entry.topicId ? ', рум ' + entry.topicId : '')
        : (entry.value + (entry.topicId ? '/' + entry.topicId : '') + (entry.topic ? ' :: ' + entry.topic : ''));
      out.push({
        raw: entry.raw || label,
        label,
        kind: entry.kind,
        value: entry.value,
        topicId: entry.topicId != null ? entry.topicId : null,
        topic: entry.topic || null,
        /** строгая запись: нужен именно этот рум, а не весь чат */
        topicStrict: entry.topicStrict !== false || entry.topicId == null ? true : false,
        chatKey: entry.kind === 'peer' ? 'ext:' + entry.value : (entry.kind === 'username' ? 'web:' + entry.value : null),
      });
    }
    return out;
  }

  /**
   * Какой клиент Telegram Web открыт: от этого зависит форма адреса.
   * null — это вообще не Telegram Web (тогда обход адрес не трогает).
   */
  function clientFlavor(location) {
    const href = String((location && location.href) || '');
    if (!/web\.telegram\.org\//i.test(href)) return null;
    if (/web\.telegram\.org\/a\//i.test(href)) return 'a';
    if (/web\.telegram\.org\/z\//i.test(href)) return 'z';
    return 'k';
  }

  /**
   * Адрес (hash), по которому клиент откроет цель — как если бы пользователь
   * сам перешёл по ссылке. null, если по адресу открыть нельзя (цель задана
   * только названием) — тогда нужен клик по строке боковой панели.
   *
   * Web K:  #<username>[/<рум>]            #-100<id>[/<рум>]
   * Web A/Z: #/im?p=@<username>            #/im?p=g<id>[_<рум>]
   */
  function walkHashFor(target, location) {
    if (!target) return null;
    const flavor = clientFlavor(location);
    if (!flavor) return null;   // не клиент Telegram Web — адрес не переписываем
    const topic = target.topicId != null ? target.topicId : null;

    if (target.kind === 'username') {
      if (flavor === 'k') return '#' + target.value + (topic ? '/' + topic : '');
      // Web A/Z юзернейм понимает, а вот рум по адресу в них не открывается
      return topic ? null : '#/im?p=@' + target.value;
    }
    if (target.kind === 'peer') {
      const digits = String(target.value).replace(/^-100/, '');
      if (flavor === 'k') return '#' + target.value + (topic ? '/' + topic : '');
      return '#/im?p=g' + digits + (topic ? '_' + topic : '');
    }
    return null;   // цель задана названием — только клик по списку чатов
  }

  /** Случайная пауза между переходами (мс): каждый раз разная. */
  function walkPauseMs(minSec, maxSec, rand) {
    const lo = Math.max(1, Number(minSec) || 60);
    const hi = Math.max(lo, Number(maxSec) || lo);
    const r = typeof rand === 'function' ? rand() : Math.random();
    return Math.round((lo + (hi - lo) * r) * 1000);
  }

  /** Переходы за последний час (с одновременной обрезкой старых отметок). */
  function walkSwitchesInHour(stamps, now) {
    const from = (now || Date.now()) - 3600 * 1000;
    return (stamps || []).filter((t) => Number(t) > from);
  }

  /**
   * Какую цель плана мы сейчас читаем: если пользователь открыл чат руками,
   * обход продолжается с него, а не «сначала». -1 — открытый чат не из плана.
   */
  function walkIndexForChat(plan, chat) {
    const key = chatKeyOf(chat);
    if (!key) return -1;
    const topicId = chat && chat.topicId != null && chat.topicId !== '' ? Number(chat.topicId) : null;
    let sameChat = -1;
    for (let i = 0; i < (plan || []).length; i++) {
      const t = plan[i];
      if (t.chatKey !== key) continue;
      if (t.topicId == null) { if (sameChat < 0) sameChat = i; continue; }
      if (t.topicId === topicId) return i;
      if (sameChat < 0) sameChat = i;
    }
    // открытый чат показал КОНКРЕТНЫЙ рум, которого в плане нет — это не наша цель;
    // «примерно тот же чат» годится, только когда рум не прочитался вовсе
    return topicId == null ? sameChat : -1;
  }

  /**
   * Куда идти дальше: следующая по порядку цель, которую в этом круге не
   * провалили. Если не открылось всё (нет входа в аккаунт, разметка не читается),
   * список проваленных сбрасывается и обход пробует снова — с теми же паузами.
   */
  function walkNextIndex(plan, from, failed) {
    const list = plan || [];
    const n = list.length;
    if (!n) return 0;
    const bad = {};
    for (const label of (failed || [])) bad[label] = true;
    for (let step = 1; step <= n; step++) {
      const i = (((from + step) % n) + n) % n;
      if (!bad[list[i].label]) return i;
    }
    return (((from + 1) % n) + n) % n;
  }

  /**
   * Открыт ли сейчас чат/рум, соответствующий цели обхода.
   *
   * Для цели с румом достаточно и того, что клиент показывает заголовок темы,
   * но не отдал её id (см. adoptTopicFromWhitelist) — иначе обход вечно считал бы
   * переход неудачным и дёргал вкладку.
   */
  function walkTargetMatches(target, chat) {
    if (!target || !chat) return false;
    const key = chatKeyOf(chat);

    if (target.chatKey) {
      if (key !== target.chatKey) return false;
      if (target.topicId == null) return true;
      const topicId = chat.topicId != null && chat.topicId !== '' ? Number(chat.topicId) : null;
      if (topicId === target.topicId) return true;
      return topicId == null && topicCandidates(chat).length > 0;
    }

    // цель задана названием (запись «Граница :: Очередь BY-PL») — сравниваем тексты
    const wanted = squashTitle(target.topic || target.value);
    if (!wanted) return false;
    const titles = chatTitleCandidates(chat).concat(topicCandidates(chat));
    return titles.some((t) => t === wanted || t.includes(wanted) || wanted.includes(t));
  }

  /**
   * Решение одного такта обхода — вся логика «читать / ждать / переходить» здесь,
   * чистой функцией (так её можно проверить тестами без браузера).
   *
   * Ограничения, которые делают обход похожим на человека и не дают ему
   * разогнаться: случайная пауза перед каждым переходом, предел переходов в час,
   * запрет переключать чат, пока пользователь сам печатает или кликает, и
   * несколько проходов чтения на одном чате (не «пролистнуть и убежать»).
   */
  function walkDecision(input, settings) {
    const s = settings || {};
    const now = input.now || Date.now();
    const plan = input.plan || [];
    if (!s.autoWalk) return { action: 'off' };
    if (plan.length === 0) return { action: 'idle', reason: 'empty', note: 'Белый список пуст — обходить нечего.' };
    if (input.switching) {
      return { action: 'wait-load', target: plan[input.index] || plan[0], reason: 'load', note: 'Открываю чат, жду пока дорисуется…' };
    }

    const index = Number.isInteger(input.index) && input.index >= 0 && input.index < plan.length ? input.index : 0;
    const target = plan[index];
    const next = (index + 1) % plan.length;

    const nextAt = Number(input.nextAt) || 0;
    if (nextAt > now) {
      return {
        action: 'wait', reason: 'pause', target, waitSec: Math.ceil((nextAt - now) / 1000),
        note: 'Пауза перед переходом: ' + Math.ceil((nextAt - now) / 1000) + ' с (дальше «' + (plan[next] || target).label + '»).',
      };
    }
    const guardMs = (Number(s.walkIdleGuardSec) || 0) * 1000;
    const idleFor = input.lastUserActivity ? now - Number(input.lastUserActivity) : Infinity;
    if (guardMs > 0 && idleFor < guardMs) {
      return {
        action: 'wait', reason: 'user', target,
        note: 'Вы сами работаете во вкладке — чат не переключаю ещё ' + Math.ceil((guardMs - idleFor) / 1000) + ' с.',
      };
    }
    const stamps = walkSwitchesInHour(input.switches, now);
    const limit = Number(s.walkMaxPerHour) || DEFAULT_SETTINGS.walkMaxPerHour;
    if (stamps.length >= limit) {
      return {
        action: 'wait', reason: 'limit', target, switchesHour: stamps.length,
        note: 'Предел переходов в час (' + limit + ') достигнут — обход подождёт.',
      };
    }
    const reads = Number(input.reads) || 0;
    const readsPerChat = Number(s.walkReadsPerChat) || DEFAULT_SETTINGS.walkReadsPerChat;
    if (reads >= readsPerChat) {
      return {
        action: 'navigate', target: plan[next], from: target, index: next, switchesHour: stamps.length,
        note: 'Перехожу в «' + plan[next].label + '».',
      };
    }
    return { action: 'read', target, reads, reason: 'read', note: 'Читаю «' + target.label + '» (проход ' + (reads + 1) + ' из ' + readsPerChat + ').' };
  }

  /** Как подписать вердикт по сообщению в панели и в диагностике. */
  const VERDICT_LABELS = {
    listing: '🟢 объявление',
    rejected: '⚪ отсеяно',
    duplicate: '🔁 уже отправляли',
    old: '🕑 старое',
    sent: '✅ ушло на сервер',
  };

  /** Почему детект решил именно так (reason из detect()). */
  const REASON_LABELS = {
    ok: 'есть признаки объявления',
    short: 'короче 10 символов',
    too_long: 'длиннее 4000 символов',
    passenger: 'про поездку людей, без посылок',
    chatter: 'нет признаков объявления (обычная переписка)',
    no_contact: 'нет контакта для связи',
    old: 'старше окна сбора',
    duplicate: 'уже отправляли это сообщение',
  };

  function explainReason(reason) {
    if (!reason) return '';
    return REASON_LABELS[reason] || reason;
  }

  /**
   * Одна строка журнала разбора — «что расширение увидело и что решило».
   * `rec` — запись из state.recent контент-скрипта (см. rememberExamined).
   */
  function verdictLine(rec) {
    const r = rec || {};
    const label = VERDICT_LABELS[r.verdict] || r.verdict || '—';
    const who = r.author ? r.author + ': ' : '';
    const text = '"' + String(r.text || '') + '"';
    const why = r.reason ? ' — ' + explainReason(r.reason) : '';
    const link = r.link ? ' → ' + r.link : ' (ссылки нет: id сообщения не прочитался)';
    const sent = r.sent ? ' ✅ отправлено' : '';
    return label + ' · ' + who + text + why + sent + '\n    ' + link;
  }

  function diagnostic(report) {
    const r = report || {};
    const lines = [];
    lines.push('URL: ' + (r.url || '—'));
    lines.push('Чат: ' + (r.chat && r.chat.title ? r.chat.title : 'не определён') +
      (r.chat && r.chat.username ? ' (@' + r.chat.username + ')' : '') +
      ' → chatId ' + (r.chatKey || '—'));
    if (r.chat && (r.chat.topicTitle || r.chat.topicId != null)) {
      lines.push('Рум (тема): ' + (r.chat.topicTitle || '—') +
        (r.chat.topicId != null ? ' (id ' + r.chat.topicId + ')' : '') +
        (r.chat.topicIdSource === 'whitelist' ? ' — id из белого списка' : ''));
    }
    if (r.chat && r.chat.groupTitle) lines.push('Группа: ' + r.chat.groupTitle);
    lines.push('В белом списке: ' + (r.whitelisted ? 'да' : 'нет') +
      (r.whitelistNote ? ' — ' + r.whitelistNote : ''));
    lines.push('Сообщений прочитано: ' + (r.total || 0) + ' (стратегия: ' + (r.strategy || '—') + ')');
    lines.push('К отправке: ' + (r.toSend || 0) + ', уже отправлено: ' + (r.alreadySent || 0) +
      ', отсеяно детектом: ' + (r.filtered || 0));
    if (r.reasons) {
      const parts = Object.keys(r.reasons).map((k) => k + ' ' + r.reasons[k]);
      if (parts.length) lines.push('Причины отсева: ' + parts.join(', '));
    }
    if (r.unreadable) lines.push('⚠ НЕ МОГУ ПРОЧИТАТЬ СООБЩЕНИЯ: разметка Telegram Web изменилась или чат пуст.');
    // Прозрачность: показываем КАЖДОЕ просмотренное сообщение и вердикт по нему,
    // чтобы было видно, что расширение действительно работает и что оно нашло.
    if (r.recent && r.recent.length) {
      lines.push('Что разобрали (' + r.recent.length + ' последних):');
      for (const rec of r.recent) lines.push('  ' + verdictLine(rec).split('\n').join('\n  '));
    } else if (r.total) {
      lines.push('Что разобрали: — (в этом проходе сообщения не разбирались)');
    }
    return lines.join('\n');
  }

  return {
    COLLECTOR,
    DEFAULT_SETTINGS,
    SENT_LOG_LIMIT,
    chromeStore,
    localStore,
    withDefaults,
    clamp,
    serverUrlProblem,
    explainTabError,
    normalizePeerId,
    whitelistMismatch,
    adoptTopicFromWhitelist,
    chatTitleCandidates,
    topicCandidates,
    walkTargets,
    walkHashFor,
    walkPauseMs,
    walkSwitchesInHour,
    walkIndexForChat,
    walkNextIndex,
    walkTargetMatches,
    walkDecision,
    clientFlavor,
    VERDICT_LABELS,
    REASON_LABELS,
    explainReason,
    verdictLine,
    normalizeWhitelist,
    normalizeWhitelistEntry,
    matchesWhitelist,
    squashTitle,
    chatKeyOf,
    messageLink,
    stableId,
    syntheticMessageId,
    detect,
    withinAge,
    sentKey,
    filterUnsent,
    chunk,
    takeRecent,
    backoffMs,
    classifyStatus,
    buildPayload,
    toPayloadMessage,
    summarizeResponse,
    mergeCounters,
    pruneSentLog,
    diagnostic,
  };
});


/* ---- extension/dom.js ---- */
/**
 * Чтение DOM Telegram Web — ТОЛЬКО ЧТЕНИЕ (ТЗ п. 4.5).
 *
 * Никаких кликов, отправок, реакций и пересылок: мы лишь смотрим, что уже
 * отрисовано в открытой вкладке на аккаунте заказчика.
 *
 * Telegram Web существует в двух клиентах (/k/ — «K», /a/ — «A»), и разметка
 * у них разная и периодически меняется. Поэтому:
 *   1. каждое поле ищем по СПИСКУ кандидатов-селекторов (стратегии), а не по
 *      одному признаку;
 *   2. если сообщения не находятся вовсе — честно сообщаем «не могу прочитать
 *      сообщения», а не молча работаем вхолостую;
 *   3. messageId берём из атрибутов/ссылок, а если клиент их не отдаёт —
 *      синтезируем устойчивый id (core.syntheticMessageId): серверная
 *      дедупликация по (chatId, messageId) при этом продолжает работать.
 *
 * Формат UMD — как у core.js: подключается обычным <script> и тестируется
 * без браузера (tests/extension-dom.test.ts). Расширение .js обязательно:
 * .cjs Chrome не считает JavaScript и не внедряет контент-скрипт вовсе.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PoputkaDom = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- */
  /* Селекторы: кандидаты в порядке убывания надёжности                */
  /* ---------------------------------------------------------------- */

  /** Контейнеры одного сообщения (K: .bubble, A: .message-list-item, …). */
  const MESSAGE_CONTAINERS = [
    '.bubbles .bubble',
    '.bubble[data-mid]',
    '[data-mid]',
    '.message-list-item',
    '.messages .msg',
    '.im-message',
    '[class*="bubble"]',
  ];

  /** Текст сообщения внутри контейнера. */
  const TEXT_SELECTORS = [
    '.text-content',
    '.message-text',
    '.text-message-content',
    '.bubble-text',
    '.msg-content',
    '[dir="auto"]',
  ];

  /** Имя автора (в группах) внутри контейнера. */
  const AUTHOR_SELECTORS = [
    '.peer-title',
    '.author-name',
    '.user-title',
    '.message-author',
    '.from-name',
    '.sender-name',
  ];

  /** Дата/время сообщения. */
  const DATE_SELECTORS = [
    '.date-text',
    '.MessageDate',
    '.message-date',
    '.date',
    'time',
    '[title]',
  ];

  /** Атрибуты, где клиент может держать числовой id сообщения. */
  const ID_ATTRS = ['data-mid', 'data-message-id', 'data-msg-id', 'data-id', 'data-mes-id', 'data-msgid'];

  /** Заголовок текущего чата. */
  const CHAT_TITLE_SELECTORS = [
    '.chat-info .peer-title',
    '.chat-info .user-title',
    '.chat-info-title',
    '.conversation-title',
    'header .peer-title',
    '.sidebar-header .peer-title',
    '#chat-info-title',
  ];

  /** Юзернейм/ссылка чата (если клиент их показывает). */
  /**
   * Рум (топик) форум-супергруппы: в Telegram Web внутри темы шапка показывает
   * ИМЯ ТЕМЫ, а имя группы — в отдельном элементе (или не показывается вовсе).
   * Поэтому читаем оба варианта и отдаём наружу как topicTitle/groupTitle.
   */
  const TOPIC_TITLE_SELECTORS = [
    '.chat-info .topic-title',
    '[class*="topic-title"]',
    '.topics-container .peer-title',
    '.chat-info [data-topic-id]',
  ];

  /** Имя группы, когда открыт рум (кандидаты — сверху вниз). */
  const GROUP_TITLE_SELECTORS = [
    '.chat-info .group-title',
    '[class*="forum"] .peer-title',
    '.chat-info .status',
    '.sidebar-header .peer-title',
  ];

  const CHAT_USERNAME_SELECTORS = [
    '.chat-info .username',
    '.chat-info-username',
    '.user-status',
    '.peer-status',
  ];

  /* ---------------------------------------------------------------- */
  /* Утилиты по узлам (duck-typed — тестируются на простых объектах)    */
  /* ---------------------------------------------------------------- */

  /** textContent/innerText узла, нормализованный (переносы строк сохраняем). */
  function textOf(node) {
    if (!node) return '';
    const raw = typeof node.innerText === 'string' && node.innerText
      ? node.innerText
      : (typeof node.textContent === 'string' ? node.textContent : '');
    return String(raw).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** Значение первого найденного атрибута из списка. */
  function attrOf(node, names) {
    if (!node || typeof node.getAttribute !== 'function') return null;
    for (const name of names) {
      const v = node.getAttribute(name);
      if (v !== null && v !== undefined && String(v).trim() !== '') return String(v).trim();
    }
    return null;
  }

  /** Первый потомок, подходящий под один из селекторов. */
  function pickFirst(node, selectors) {
    if (!node || typeof node.querySelector !== 'function') return null;
    for (const sel of selectors) {
      let found = null;
      try { found = node.querySelector(sel); } catch { found = null; }
      if (found) return found;
    }
    return null;
  }

  /** Все потомки по списку селекторов (первый непустой результат). */
  function pickAll(root, selectors) {
    for (const sel of selectors) {
      let nodes = [];
      try { nodes = Array.from(root.querySelectorAll(sel)); } catch { nodes = []; }
      if (nodes.length) return { selector: sel, nodes };
    }
    return { selector: null, nodes: [] };
  }

  /* ---------------------------------------------------------------- */
  /* messageId: атрибут → ссылка → null (дальше синтезирует core)       */
  /* ---------------------------------------------------------------- */

  /** Числовой id сообщения из атрибутов или ссылок внутри контейнера. */
  function messageIdFromNode(node) {
    const fromAttr = attrOf(node, ID_ATTRS);
    const fromAttrId = toMessageId(fromAttr);
    if (fromAttrId !== null) return { id: fromAttrId, source: 'attr' };

    // ссылка на сообщение: t.me/<chat>/<id> или #<id> внутри контейнера
    if (node && typeof node.querySelectorAll === 'function') {
      let links = [];
      try { links = Array.from(node.querySelectorAll('a[href]')); } catch { links = []; }
      for (const a of links) {
        const href = (typeof a.getAttribute === 'function' && a.getAttribute('href')) || a.href || '';
        const m = /t\.me\/(?:s\/)?[A-Za-z][A-Za-z0-9_]*\/(\d+)/i.exec(String(href)) ||
          /^#(\d{2,}$)/.exec(String(href));
        const id = m ? toMessageId(m[1]) : null;
        if (id !== null) return { id, source: 'link' };
      }
    }
    return { id: null, source: 'none' };
  }

  /**
   * Клиент может хранить id как есть («12345»), как «12345_67890»
   * (peerId_messageId) или с префиксом («mid:12345»). Берём подходящее
   * положительное целое, а в составных форматах — ПОСЛЕДНЮЮ группу цифр:
   * первой там обычно идёт peerId, одинаковый у всех сообщений чата.
   */
  function toMessageId(raw) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    if (!s) return null;
    if (/^-\d+$/.test(s)) return null; // отрицательные — это peerId, не номер сообщения
    if (/^\d{1,15}$/.test(s)) {
      const n = Number(s);
      return n > 0 ? n : null;
    }
    const groups = s.match(/\d{1,15}/g);
    if (!groups || !groups.length) return null;
    const n = Number(groups[groups.length - 1]);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  /* ---------------------------------------------------------------- */
  /* Дата сообщения из подписи вида «14:32», «вчера», «12.09»           */
  /* ---------------------------------------------------------------- */

  const MONTHS = {
    'янв': 1, 'фев': 2, 'мар': 3, 'апр': 4, 'мая': 5, 'май': 5, 'июн': 6, 'июл': 7,
    'авг': 8, 'сен': 9, 'окт': 10, 'ноя': 11, 'дек': 12,
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
    'январ': 1, 'феврал': 2, 'март': 3, 'апрел': 4, 'июн': 6, 'июл': 7, 'август': 8,
    'сентябр': 9, 'октябр': 10, 'ноябр': 11, 'декабр': 12,
  };

  /**
   * Название месяца по любому его началу: «сентября» → 9, «мая» → 5,
   * «sept» → 9. Таблица выше хранит основы, а в разметке встречаются падежи.
   */
  function monthOf(word) {
    const w = String(word || '').toLowerCase().replace(/[^а-яёa-z]/g, '');
    for (let len = Math.min(w.length, 9); len >= 3; len--) {
      const m = MONTHS[w.slice(0, len)];
      if (m) return m;
    }
    return null;
  }

  /**
   * Подпись даты → миллисекунды. Понимает:
   *   ISO («2026-09-12T14:32:00Z» и без пояса), «14:32» (сегодня/вчера),
   *   «вчера»/«yesterday»/«позавчера», «12.09», «12.09.26», «12 сентября»,
   *   «Sep 12».
   * Не разобрал → null: тогда возраст проверит сервер (INGEST_MAX_AGE_DAYS),
   * а не «на глаз».
   */
  function parseDomDate(raw, now) {
    const s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    // в подписи даты всегда есть цифры (или слово «вчера»/«позавчера»)
    if (!/\d/.test(s) && !/(вчера|позавчера|yesterday)/i.test(s)) return null;
    const ref = now ? new Date(now) : new Date();

    /* 1. Полная ISO-дата (атрибут time[datetime]) — разбирается без догадок. */
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) {
      const direct = Date.parse(s); // с Z или ±HH:MM — абсолютное время
      if (Number.isFinite(direct)) return direct;
      const m = /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(s);
      if (m) {
        const local = Date.parse(`${m[1]}T${m[2]}:00`); // без пояса — локальное
        if (Number.isFinite(local)) return local;
      }
    }

    const lower = s.toLowerCase();
    let dayOffset = 0;
    if (/позавчера/.test(lower)) dayOffset = -2;
    else if (/(вчера|yesterday)/.test(lower)) dayOffset = -1;

    const time = /(\d{1,2}):(\d{2})/.exec(s);
    const numeric = /(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?/.exec(s);
    // «12 сентября» / «12 сен.» и английский порядок «Sep 12»
    const namedRu = /(\d{1,2})\s*([а-яёa-z]{3,9})\.?/.exec(lower);
    const namedEn = /([a-z]{3,9})\.?\s+(\d{1,2})/.exec(lower);
    let namedMonth = null;
    let namedDay = null;
    if (namedRu) {
      const m = monthOf(namedRu[2]);
      if (m) { namedMonth = m; namedDay = Number(namedRu[1]); }
    }
    if (!namedMonth && namedEn) {
      const m = monthOf(namedEn[1]);
      if (m) { namedMonth = m; namedDay = Number(namedEn[2]); }
    }

    let year = ref.getFullYear();
    let month = ref.getMonth(); // 0-based
    let day = ref.getDate();
    let explicitYear = false;

    if (numeric) {
      day = Number(numeric[1]);
      month = Number(numeric[2]) - 1;
      if (numeric[3]) {
        year = Number(numeric[3]);
        if (year < 100) year += 2000;
        explicitYear = true;
      }
    } else if (namedMonth && namedDay) {
      day = namedDay;
      month = namedMonth - 1;
    }
    const hasOwnDate = Boolean(numeric) || Boolean(namedMonth && namedDay);

    /* 2. «вчера 18:20» — своя дата важнее слова не бывает, слово и есть дата. */
    if (dayOffset && !hasOwnDate) {
      return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + dayOffset,
        time ? Number(time[1]) : 0, time ? Number(time[2]) : 0, 0, 0).getTime();
    }

    const hour = time ? Number(time[1]) : 0;
    const minute = time ? Number(time[2]) : 0;
    let result = new Date(year, month, day, hour, minute, 0, 0);
    if (Number.isNaN(result.getTime())) return null;

    if (!hasOwnDate && !dayOffset) {
      // «14:32» без даты: если время ещё не наступило — это вчера (ночные чаты)
      if (result.getTime() > ref.getTime() + 3600 * 1000) {
        return new Date(year, month, day - 1, hour, minute, 0, 0).getTime();
      }
      return result.getTime();
    }

    // «31.12» в январской ленте — это прошлый год: сообщения из будущего не приходят
    if (!explicitYear && result.getTime() > ref.getTime() + 12 * 3600 * 1000) {
      result = new Date(year - 1, month, day, hour, minute, 0, 0);
    }
    return result.getTime();
  }

  /* ---------------------------------------------------------------- */
  /* Текущий чат                                                       */
  /* ---------------------------------------------------------------- */

  /** Заголовок вкладки → название чата: «(2) Водители — Telegram Web» → «Водители». */
  function cleanDocTitle(raw) {
    return String(raw || '')
      .replace(/^\(\d+\)\s*/, '')                 // счётчик непрочитанных
      .replace(/\s*[—–|]\s*Telegram.*$/i, '')     // «… — Telegram Web»
      .replace(/\s*[-|]\s*Telegram Web.*$/i, '')
      .replace(/^Telegram Web(?:\s*\w+)?\s*[—–|:]\s*/i, '') // «Telegram Web K: …»
      .trim();
  }

  /**
   * Что за чат открыт: название, юзернейм (если виден), числовой peer-id.
   *
   * Юзернейм важен: по нему core.chatKeyOf() даёт ключ 'web:<username>' — тот же,
   * что у серверного сборщика, поэтому одно сообщение из двух источников
   * не превратится в две заявки. Ищем его в URL (#@username, t.me/…) и в шапке чата.
   *
   * `doc` — document (или его подобие в тестах), `location` — для hash/href.
   */
  function readChatInfo(doc, location) {
    const titleNode = pickFirst(doc, CHAT_TITLE_SELECTORS);
    const title = textOf(titleNode) ||
      (doc && typeof doc.title === 'string' ? cleanDocTitle(doc.title) : '');

    const usernameNode = pickFirst(doc, CHAT_USERNAME_SELECTORS);
    const fromNode = /@([A-Za-z][A-Za-z0-9_]{3,31})/.exec(textOf(usernameNode) || '');

    // Рум и группа — дополнительно к заголовку (см. TOPIC_TITLE_SELECTORS)
    const topicFromDom = cleanDocTitle(textOf(pickFirst(doc, TOPIC_TITLE_SELECTORS)) || '');
    const groupFromDom = cleanDocTitle(textOf(pickFirst(doc, GROUP_TITLE_SELECTORS)) || '');

    // URL клиента: /k/#@username, /k/#-1001234567890, /a/#/im?p=g1234567890,
    // /a/#/im?p=u123456, ?p=c123456, /a/#/im?p-1001234567890
    const hash = String((location && location.hash) || '');
    const href = String((location && location.href) || '');
    const loc = hash + ' ' + href;
    const linkUser = /t\.me\/(?:s\/)?@?([A-Za-z][A-Za-z0-9_]{3,31})(?!\/?\d)/i.exec(loc);
    const hashUser = /#@([A-Za-z][A-Za-z0-9_]{3,31})(?![A-Za-z0-9_])/.exec(loc) ||
      /#\/(?:im\/)?@([A-Za-z][A-Za-z0-9_]{3,31})(?![A-Za-z0-9_])/.exec(loc);
    // Web K держит открытый чат в хэше и без «@»: #travelersminsk, #travelersminsk/91529 (рум).
    // Хэш целиком — иначе спутаем чат со служебными экранами клиента (#settings, #contactlist).
    const bareHash = /^#\/?@?([A-Za-z][A-Za-z0-9_]{3,31})(?:\/(\d{1,12}))?$/.exec(hash.trim());
    const bareUser = bareHash && NON_CHAT_HASHES.indexOf(bareHash[1].toLowerCase()) === -1
      ? bareHash[1]
      : null;
    const bareTopic = bareHash && bareHash[2] ? Number(bareHash[2]) : null;
    const peerRaw = /[?&/#]p=([guc]-?\d{4,})/.exec(loc) ||
      /[#/]p([guc]?-?\d{4,})(?!\d)/.exec(loc) ||
      /#([guc]-?\d{4,})(?![A-Za-z0-9_])/.exec(loc) ||
      /#(-?\d{5,})(?!\d)/.exec(loc);
    const peer = normalizePeer(peerRaw && peerRaw[1]);

    // Рум (топик) по URL клиента:
    //   ?topic=12, &thread=12, p=g123_12, #/im/p-100123_12, #-100123_12,
    //   #@username/91529 и #username/91529 (публичный форум),
    //   #-1001234567890/91529 и #p-1001234567890-91529 (приватный форум)
    const topicRaw = /[?&]topic=(\d{1,12})/.exec(loc) || /[?&]thread=(\d{1,12})/.exec(loc) ||
      /p=[guc]-?\d{4,}_(\d{1,12})/.exec(loc) ||
      /[#/]p[guc]?-?\d{4,}_(\d{1,12})(?!\d)/.exec(loc) ||
      /#-?\d{5,}_(\d{1,12})(?!\d)/.exec(loc) ||
      /#@?[A-Za-z][A-Za-z0-9_]{3,31}\/(\d{1,12})(?!\d)/.exec(loc) ||
      /#-?\d{5,}\/(\d{1,12})(?!\d)/.exec(loc) ||
      /[#/]p[guc]?-?\d{4,}-(\d{1,12})(?!\d)/.exec(loc);

    // Рум по атрибуту шапки: Telegram Web помечает заголовок темы data-topic-id
    const topicAttrNode = pickFirst(doc, ['.chat-info [data-topic-id]', '[data-topic-id]', '[data-topic-id] *']);
    const topicAttrRaw = Number(attrOf(topicAttrNode, ['data-topic-id']));
    const topicFromAttr = Number.isInteger(topicAttrRaw) && topicAttrRaw > 0 ? topicAttrRaw : null;

    // Если в шапке тема, а группа прочиталась отдельно — заголовок это имя рума
    const groupTitle = groupFromDom || null;
    const topicTitle = topicFromDom || (groupTitle && title ? title : null);

    return {
      title: title || null,
      username: (linkUser && linkUser[1]) || (hashUser && hashUser[1]) ||
        (fromNode && fromNode[1]) || bareUser || null,
      id: peer ? peer.id : null,
      kind: peer ? peer.kind : null,
      groupTitle: groupTitle,
      topicTitle: topicTitle && topicTitle !== groupTitle ? topicTitle : null,
      topicId: topicRaw ? Number(topicRaw[1]) : (bareTopic || topicFromAttr),
    };
  }

  /**
   * peer-id из URL Telegram Web → канонический вид (тот же, что core.normalizePeerId).
   * Здесь своя копия: dom.js должен работать и без ядра (юзерскрипт грузит их вместе,
   * но порядок не гарантирован во всех сборках).
   */
  function normalizePeer(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    let m = /^[gG](\d{4,})$/.exec(s);
    if (m) return { id: '-100' + m[1], kind: 'supergroup' };
    m = /^[cC](\d{4,})$/.exec(s);
    if (m) return { id: '-' + m[1], kind: 'group' };
    m = /^[uU](\d{4,})$/.exec(s);
    if (m) return { id: m[1], kind: 'user' };
    if (/^-100\d{4,}$/.test(s)) return { id: s, kind: 'supergroup' };
    if (/^-\d{4,}$/.test(s)) return { id: s, kind: 'group' };
    if (/^\d{4,}$/.test(s)) return { id: s, kind: 'user' };
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* Сбор сообщений                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Прочитать сообщения открытого чата.
   * Возвращает сырые сообщения (без chatId — его добавляет core.toPayloadMessage)
   * и диагностику: какой стратегией нашли и нашли ли вообще.
   */
  function harvest(doc, opts) {
    const options = opts || {};
    const root = options.root || doc;
    const { selector, nodes } = pickAll(root, MESSAGE_CONTAINERS);
    if (!nodes.length) {
      return { messages: [], strategy: null, total: 0, unreadable: true, counts: {} };
    }

    const messages = [];
    const counts = { no_text: 0, dup: 0, service: 0, ok: 0, syntheticId: 0, idCollision: 0 };
    const seenTexts = new Set();
    const limit = Math.max(1, options.limit || 30);

    // идём с конца: в Telegram Web новые сообщения внизу списка
    for (let i = nodes.length - 1; i >= 0 && messages.length < limit; i--) {
      const node = nodes[i];
      const textNode = pickFirst(node, TEXT_SELECTORS) || node;
      const text = textOf(textNode);
      if (!text || text.length < 2) { counts.no_text++; continue; }

      // сервисные и системные строки объявлениями не являются
      const cls = String((node.className && node.className.baseVal !== undefined
        ? node.className.baseVal
        : node.className) || '');
      if (/service|date-divider|message-date-separator|empty|placeholder/i.test(cls)) { counts.service++; continue; }
      if (/joined the group|присоединил|создал канал|created the channel|изменил(?:а)? (?:название|фото)|закрепил/i.test(text)) {
        counts.service++;
        continue;
      }

      const signature = text.replace(/\s+/g, ' ').slice(0, 300);
      if (seenTexts.has(signature)) { counts.dup++; continue; }
      seenTexts.add(signature);

      const idInfo = messageIdFromNode(node);
      if (idInfo.id === null) counts.syntheticId++;

      const dateNode = pickFirst(node, DATE_SELECTORS);
      const dateRaw = (dateNode && (attrOf(dateNode, ['datetime', 'title', 'aria-label']) || textOf(dateNode))) || '';

      const authorNode = pickFirst(node, AUTHOR_SELECTORS);
      const authorName = textOf(authorNode) || null;
      const at = authorName ? /@([A-Za-z][A-Za-z0-9_]{3,31})/.exec(authorName) : null;

      messages.push({
        text,
        messageId: idInfo.id,
        idSource: idInfo.source,
        dateMs: parseDomDate(dateRaw, options.now),
        dateRaw: dateRaw || null,
        authorName: at ? null : authorName,
        authorUsername: at ? '@' + at[1] : null,
      });
      counts.ok++;
    }

    /*
     * Защита от «схлопывания» id. Если клиент отдаёт составной id и мы взяли
     * не ту его часть (например peerId вместо номера сообщения), все сообщения
     * чата получат один и тот же messageId — серверная дедупликация по паре
     * (chatId, messageId) посчитает их дублями, и сбор встанет молча.
     * Видим повтор id в пределах прочитанного окна → обнуляем его, и core
     * синтезирует устойчивый id из (chatId, текст, дата).
     */
    const idCounts = new Map();
    for (const m of messages) {
      if (m.messageId === null) continue;
      idCounts.set(m.messageId, (idCounts.get(m.messageId) || 0) + 1);
    }
    for (const m of messages) {
      if (m.messageId !== null && (idCounts.get(m.messageId) || 0) > 1) {
        m.messageId = null;
        m.idSource = 'collision';
        counts.idCollision++;
        counts.syntheticId++;
      }
    }

    // в ответе — по возрастанию времени/id, как требует контракт
    messages.reverse();
    return { messages, strategy: selector, total: nodes.length, unreadable: false, counts };
  }

  /** Жив ли клиент: видно ли хоть что-то похожее на список сообщений. */
  /**
   * Хэши Telegram Web, которые НЕ являются чатами (#settings, #contactlist и т. п.).
   * Нужно, чтобы «голое» имя в хэше не превратилось в юзернейм чата.
   */
  const NON_CHAT_HASHES = [
    'settings', 'contactlist', 'contacts', 'newgroup', 'newchannel', 'login', 'logout',
    'im', 'test', 'addstickers', 'addtheme', 'share', 'profile', 'archived', 'folders',
    'about', 'privacy', 'chatlist', 'search', 'info', 'media', 'members', 'stickers',
  ];

  /** Строки списка чатов слева: по ним автообход открывает чат кликом. */
  const CHAT_ROW_SELECTORS = [
    '.chatlist-chat',
    '[class*="chatlist-chat"]',
    '.chatlist a',
    '[class*="chatlist"] [class*="peer-title"]',
    '.sidebar [data-peer-id]',
  ];

  /** Имя внутри строки списка чатов. */
  const ROW_TITLE_SELECTORS = [
    '.peer-title',
    '[class*="peer-title"]',
    '.chatlist-chat-title',
    '[class*="chat-title"]',
  ];

  function squashText(raw) {
    return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /**
   * Найти строку чата или рума в боковой панели — для автообхода, когда открыть
   * чат по адресу нельзя (цель задана названием, либо клиент не понимает рум в адресе).
   *
   * Функция только ИЩЕТ узел: клик делает вызывающий. Читает он её так же, как
   * читает сообщения, — ничего в разметку не пишет.
   *
   * `labels` — варианты имени (название рума, юзернейм, подпись цели): берём
   * первое совпадение, полное или по включению.
   */
  function findChatRow(doc, labels) {
    const wanted = (Array.isArray(labels) ? labels : [labels]).map(squashText).filter(Boolean);
    if (!wanted.length) return null;
    const rows = pickAll(doc, CHAT_ROW_SELECTORS).nodes || [];
    for (const node of rows) {
      const titleNode = node && typeof node.querySelector === 'function'
        ? pickFirst(node, ROW_TITLE_SELECTORS)
        : null;
      const text = squashText(textOf(titleNode) || textOf(node));
      if (!text) continue;
      for (const w of wanted) {
        if (text === w || text.includes(w) || w.includes(text)) return { node, title: text };
      }
    }
    return null;
  }

  function isReadable(doc) {
    const { nodes } = pickAll(doc, MESSAGE_CONTAINERS);
    return nodes.length > 0;
  }

  /**
   * Отпечаток СОДЕРЖИМОГО ленты — без адреса вкладки: заголовок чата, имя рума
   * из шапки, сколько сообщений видно и id первого/последнего.
   *
   * Нужен автообходу: мы меняем адрес сами, поэтому по адресу нельзя понять,
   * открылся ли другой чат. Если отпечаток до и после перехода одинаковый —
   * клиент остался на прежнем чате (нет доступа, рум не понял, страница
   * зависла), и обход честно пишет «не открылся», а не перечитывает прежнее.
   */
  function contentFingerprint(doc) {
    const info = readChatInfo(doc, null);
    const { nodes } = pickAll(doc, MESSAGE_CONTAINERS);
    const firstId = nodes.length ? messageIdFromNode(nodes[0]).id : null;
    const lastId = nodes.length ? messageIdFromNode(nodes[nodes.length - 1]).id : null;
    return [info.title || '', info.topicTitle || '', nodes.length, firstId, lastId].join('|');
  }

  return {
    MESSAGE_CONTAINERS,
    TEXT_SELECTORS,
    AUTHOR_SELECTORS,
    DATE_SELECTORS,
    ID_ATTRS,
    CHAT_TITLE_SELECTORS,
    CHAT_USERNAME_SELECTORS,
    NON_CHAT_HASHES,
    CHAT_ROW_SELECTORS,
    ROW_TITLE_SELECTORS,
    findChatRow,
    squashText,
    textOf,
    attrOf,
    pickFirst,
    pickAll,
    messageIdFromNode,
    toMessageId,
    monthOf,
    parseDomDate,
    cleanDocTitle,
    readChatInfo,
    harvest,
    isReadable,
    contentFingerprint,
  };
});


/* ---- extension/content.js ---- */
/**
 * Content script сборщика для Telegram Web (ТЗ п. 4.5).
 *
 * Работает в открытой вкладке на аккаунте заказчика и ТОЛЬКО ЧИТАЕТ DOM:
 * ни кликов, ни отправки сообщений, ни реакций, ни пересылок.
 *
 * Порядок прохода:
 *   1. настройки (chrome.storage/localStorage) — нет сервера или токена → стоим;
 *   2. какой чат открыт; не входит в белый список → сообщения не читаем вовсе;
 *   3. читаем последние N сообщений (PoputkaDom.harvest);
 *   4. клиентский детект на бандле src/parser.ts: пассажирские и болтовня
 *      отсеиваются здесь, на сервер идёт только похожее на объявление;
 *   5. локальная дедупликация (лог отправленного) → батчи ≤ batchSize;
 *   6. POST /api/ingest с Bearer INGEST_TOKEN; дубли от сервера — штатный ответ;
 *   7. счётчики и ошибки — в панель; 401/503 → стоим и показываем ошибку,
 *      429/5xx → backoff, разметка не читается → «не могу прочитать сообщения».
 */
(function () {
  'use strict';

  /* Повторное внедрение не должно плодить второй слушатель и второй таймер:
   * манифест внедряет скрипт при загрузке страницы, а попап умеет подключить его
   * к уже открытой вкладке сам (chrome.scripting.executeScript). Живой экземпляр
   * есть — выходим; экземпляр мёртв (расширение обновили, контекст инвалидирован) —
   * останавливаем его таймер и запускаемся заново. */
  const scope = (typeof window !== 'undefined' && window) ? window : globalThis;
  const extId = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) || 'unknown';
  const prev = scope.__poputchkaBoot;
  if (prev && prev.extId === extId) {
    let alive = false;
    try { alive = Boolean(prev.live && prev.live()); } catch { alive = false; }
    if (alive) return;
    try { prev.stop && prev.stop(); } catch { /* старый экземпляр уже не остановить */ }
  }

  /* Слушатель сообщений регистрируется ПЕРВЫМ делом: даже если что-то ниже
   * упадёт, попап получит ответ с текстом ошибки, а не «вкладка не отвечает». */
  const boot = {
    version: '1.0.4',
    startedAt: Date.now(),
    ok: false,
    error: null,
    // true, если это повторное внедрение вместо умершего экземпляра
    reinjected: Boolean(prev),
  };

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      (async () => {
        try {
          sendResponse(await handleMessage(msg));
        } catch (e) {
          try { sendResponse({ ok: false, boot, error: String(e && e.message || e) }); } catch { /* канал закрыт */ }
        }
      })();
      return true; // ответ асинхронный
    });
  }

  let core = null;
  let dom = null;
  let parser = null;
  let store = null;

  const NS = 'poputchka';

  const state = {
    settings: { whitelist: [], intervalSec: 120, batchSize: 20, maxPerChat: 30, confirmMode: true, paused: false, maxAgeHours: 72, requireContact: false, serverUrl: '', token: '' },
    counters: {},
    sentKeys: [],
    pending: [],          // найдено, но ждёт подтверждения (confirmMode)
    recent: [],           // журнал разбора: КАЖДОЕ просмотренное сообщение и вердикт
    ui: { showRecent: true, showWalk: true },
    // автообход: расширение само открывает чаты и румы из белого списка
    walk: {
      index: 0,             // какую цель плана читаем сейчас
      reads: 0,             // сколько проходов прочитали в этом чате
      nextAt: 0,            // когда переходить дальше (мс)
      switching: null,      // цель, которую сейчас открываем
      triedClick: false,    // адрес не сработал — пробовали ли клик по списку чатов
      beforeFp: '',         // отпечаток чата ДО перехода: чтобы понять, что он правда сменился
      switches: [],         // отметки переходов (лимит в час)
      failed: [],           // цели, которые в этом круге не открылись
      prevHash: '',         // адрес вкладки ДО перехода: возвращаемся, если не вышло
      lastUserActivity: 0,  // пользователь печатает/кликает — чат не вырываем
      ourAction: false,     // это наш клик, а не пользовательский
      log: [],              // последние переходы
      note: '',
    },
    error: null,
    status: 'инициализация…',
    attempt: 0,
    backoffUntil: 0,
    timer: null,
    lastDiagnostic: null,
    unreadable: false,
    clientId: null,       // метка этого браузера для панели (heartbeat)
    lastChat: null,       // какой чат/рум видели последним
    topicNote: null,      // если id рума пришлось взять из белого списка
    configFromServer: false,
    configError: null,
  };

  /* Метка живого экземпляра: по ней повторное внедрение понимает, что работать уже не надо. */
  scope.__poputchkaBoot = {
    extId,
    boot,
    live: () => {
      try {
        // вне расширения (юзерскрипт) chrome может не быть вовсе — экземпляр при этом жив
        if (typeof chrome === 'undefined' || !chrome.runtime) return true;
        return Boolean(chrome.runtime.id);
      } catch {
        return false; // «Extension context invalidated» — экземпляр мёртв
      }
    },
    stop: () => {
      try {
        if (state.timer) clearInterval(state.timer);
        state.timer = null;
      } catch { /* таймер мог не завестись */ }
    },
  };

  try {
    core = (typeof PoputkaCore !== 'undefined') ? PoputkaCore : require('./core.js');
    dom = (typeof PoputkaDom !== 'undefined') ? PoputkaDom : require('./dom.js');
    parser = (typeof PoputkaParser !== 'undefined') ? PoputkaParser : null;
    store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
      ? core.chromeStore(NS)
      : core.localStore(NS);
    state.settings = core.withDefaults({});
  } catch (e) {
    boot.error = 'не удалось загрузить ядро сборщика: ' + String(e && e.message || e) +
      ' (переустановите расширение: chrome://extensions → «Обновить», затем F5 на web.telegram.org)';
  }

  /** Состояние для попапа — даже если часть модулей не загрузилась. */
  function safeState() {
    try { return publicState(); } catch (e) { return { error: String(e && e.message || e) }; }
  }

  /* ---------------------------------------------------------------- */
  /* Хранилище                                                         */
  /* ---------------------------------------------------------------- */

  async function loadState() {
    const saved = await store.read();
    state.settings = core.withDefaults(saved.settings);
    state.counters = saved.counters || {};
    state.sentKeys = Array.isArray(saved.sentKeys) ? saved.sentKeys : [];
    state.recent = Array.isArray(saved.recent) ? saved.recent : [];
    const w = saved.walk && typeof saved.walk === 'object' ? saved.walk : {};
    state.walk.index = Number(w.index) || 0;
    state.walk.reads = Number(w.reads) || 0;
    state.walk.nextAt = Number(w.nextAt) || 0;
    state.walk.switches = Array.isArray(w.switches) ? w.switches.map(Number).filter(Boolean) : [];
    state.walk.log = Array.isArray(w.log) ? w.log : [];
    state.clientId = saved.clientId || newClientId();
  }

  /** Метка этого браузера: панель показывает, какие аккаунты подключены. */
  function newClientId() {
    const rnd = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
    return String(rnd).slice(0, 36);
  }

  async function persist() {
    await store.write({
      settings: state.settings,
      counters: state.counters,
      sentKeys: core.pruneSentLog(state.sentKeys),
      // журнал разбора храним урезанным: он для наглядности, а не для истории
      recent: state.recent.slice(0, 40),
      // обход: где мы в плане и какие переходы уже сделали (лимит в час и журнал
      // переживают перезагрузку вкладки — иначе обход начинался бы заново и бодро)
      walk: {
        index: state.walk.index,
        reads: state.walk.reads,
        nextAt: state.walk.nextAt,
        switches: core.walkSwitchesInHour(state.walk.switches, Date.now()),
        log: state.walk.log.slice(0, 12),
      },
      clientId: state.clientId,
      // отметка «я жив» — по ней попап объясняет «вкладка не отвечает»
      alive: {
        at: Date.now(), ok: boot.ok, error: boot.error, version: boot.version,
        url: (typeof location !== 'undefined' && location.href) || null,
        status: state.status,
      },
    });
  }

  /* ---------------------------------------------------------------- */
  /* Отправка                                                          */
  /* ---------------------------------------------------------------- */

  async function postBatch(messages) {
    const url = state.settings.serverUrl + '/api/ingest';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.settings.token },
      body: JSON.stringify(core.buildPayload(messages, { collector: core.COLLECTOR })),
      // читающий режим: кэшировать нечего
      cache: 'no-store',
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: res.status, ok: res.ok, body, retryAfter: Number(res.headers.get('Retry-After')) || null };
  }

  /** Отправить всё, что накопилось (батчами). */
  async function sendPending(opts) {
    const options = opts || {};
    if (!state.settings.serverUrl || !state.settings.token) {
      state.error = 'Не заданы сервер или INGEST_TOKEN — откройте попап расширения.';
      render();
      return;
    }
    const queue = options.messages || state.pending;
    if (!queue.length) { state.status = 'нет новых сообщений'; render(); return; }

    const batches = core.chunk(queue, state.settings.batchSize);
    for (const batch of batches) {
      try {
        const { status, ok, body, retryAfter } = await postBatch(batch);
        if (!ok) {
          const kind = core.classifyStatus(status);
          state.attempt++;
          if (kind === 'backoff') {
            const wait = retryAfter ? retryAfter * 1000 : core.backoffMs(state.attempt);
            state.backoffUntil = Date.now() + wait;
            state.error = `Сервер ответил ${status}. Подождём ${Math.round(wait / 1000)} с и повторим.`;
          } else if (kind === 'stop_auth') {
            state.backoffUntil = Infinity;
            state.error = 'Токен не принят (401). Проверьте INGEST_TOKEN в настройках — сбор остановлен.';
          } else if (kind === 'stop_disabled') {
            state.backoffUntil = Infinity;
            state.error = 'Приём выключен на сервере (503): не задан INGEST_TOKEN. Сбор остановлен.';
          } else if (kind === 'stop_payload') {
            state.backoffUntil = Infinity;
            state.error = `Сервер отклонил запрос (${status}): ${body && body.error ? body.error : 'проверьте контракт'}.`;
          } else {
            state.error = `Неожиданный ответ сервера: ${status}`;
          }
          render();
          return;
        }

        // успех: счётчики, лог отправленного, сброс backoff
        state.attempt = 0;
        state.backoffUntil = 0;
        state.error = null;
        // batch передаём, чтобы повторная отправка была исключена даже тогда,
        // когда сервер не прислал разбора по сообщениям (results)
        const sum = core.summarizeResponse(body, batch);
        state.counters = core.mergeCounters(state.counters, {
          sent: batch.length, received: sum.received, created: sum.created,
          duplicate: sum.duplicate, skipped: sum.skipped, invalid: sum.invalid,
          listings: sum.listings, runs: 1, lastRunAt: new Date().toISOString(),
        });
        for (const key of sum.sentKeys) if (!state.sentKeys.includes(key)) state.sentKeys.push(key);
        markSent(batch);
        state.sentKeys = core.pruneSentLog(state.sentKeys);
        state.status = `отправлено ${batch.length}, заявок ${sum.created}, дублей ${sum.duplicate}`;
      } catch (e) {
        state.attempt++;
        const wait = core.backoffMs(state.attempt);
        state.backoffUntil = Date.now() + wait;
        state.error = 'Нет связи с сервером: ' + (e && e.message ? e.message : e) +
          `. Повтор через ${Math.round(wait / 1000)} с.`;
        render();
        return;
      }
    }

    // отправленные убираем из очереди подтверждения
    const sentIds = new Set(queue.map((m) => core.sentKey(m.chatId, m.messageId)));
    state.pending = state.pending.filter((m) => !sentIds.has(core.sentKey(m.chatId, m.messageId)));
    await persist();
    render();
  }

  /* ---------------------------------------------------------------- */
  /* Журнал разбора: видно каждое сообщение, которое посмотрело расширение
  /* ---------------------------------------------------------------- */

  /** Сколько записей журнала держать (новые вытесняют старые). */
  const RECENT_MAX = 60;

  /**
   * Записать вердикт по одному сообщению. Пользователь должен видеть не только
   * «найдено N», но и КАЖДОЕ сообщение, которое расширение прочитало и отвергло,
   * с причиной и ссылкой на первоисточник (чтобы открыть и переслать вручную).
   */
  function rememberExamined(m, verdict, reason) {
    const rec = {
      at: new Date().toISOString(),
      chatId: m.chatId,
      messageId: m.messageId,
      // чат и рум пишем в каждую запись: журнал переживает смену чата, и должно быть
      // видно, откуда сообщение (пользователь открывает чаты руками)
      chat: m.chatTitle || m.chatId || '',
      topicId: m.topicId || null,
      // юзернейм из DOM уже приходит с «@» — второй не добавляем
      author: m.authorName ||
        (m.authorUsername ? '@' + String(m.authorUsername).replace(/^@+/, '') : ''),
      text: String(m.text || '').replace(/\s+/g, ' ').slice(0, 140),
      verdict,
      reason: reason || null,
      // ссылка t.me/<чат>[/<рум>]/<сообщение>; null, если id сообщения синтетический
      link: m.link || null,
      sent: false,
    };
    const same = (r) => r.chatId === rec.chatId && r.messageId === rec.messageId;
    state.recent = [rec].concat(state.recent.filter((r) => !same(r)));
    if (state.recent.length > RECENT_MAX) state.recent = state.recent.slice(0, RECENT_MAX);
    return rec;
  }

  /** Состояние обхода наружу (попап и панель сервера): без внутренних таймеров. */
  function walkPublic() {
    const plan = state.walk.plan || core.walkTargets(state.settings.whitelist);
    const target = plan[state.walk.index] || null;
    const next = plan.length ? plan[(state.walk.index + 1) % plan.length] : null;
    return {
      on: state.settings.autoWalk === true,
      plan: plan.length,
      current: target ? target.label : null,
      next: next ? next.label : null,
      reads: state.walk.reads,
      readsPerChat: state.settings.walkReadsPerChat,
      nextInSec: state.walk.nextAt ? Math.max(0, Math.ceil((state.walk.nextAt - Date.now()) / 1000)) : 0,
      switchesHour: core.walkSwitchesInHour(state.walk.switches, Date.now()).length,
      switchesLimit: state.settings.walkMaxPerHour,
      switching: state.walk.switching ? state.walk.switching.label : null,
      note: state.walk.note || '',
      log: state.walk.log.slice(0, 12),
    };
  }

  /** Отметить в журнале, какие сообщения ушли на сервер. */
  function markSent(batch) {
    const keys = new Set((batch || []).map((m) => core.sentKey(m.chatId, m.messageId)));
    for (const rec of state.recent) {
      if (keys.has(core.sentKey(rec.chatId, rec.messageId))) rec.sent = true;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Автообход чатов и румов                                           */
  /*                                                                    */
  /* Расширение открывает чаты из белого списка само: адресом вкладки     */
  /* (как если бы пользователь вставил ссылку) или кликом по строке в     */
  /* списке чатов. Ничего не отправляет, не публикует и не печатает —     */
  /* только читает. Темп человеческий: случайная пауза перед каждым       */
  /* переходом, несколько проходов на чат, предел переходов в час и       */
  /* запрет переключать чат, пока пользователь сам работает во вкладке.   */
  /* ---------------------------------------------------------------- */

  /** Сколько записей журнала обхода держать. */
  const WALK_LOG_MAX = 25;
  /** Сколько ждём, пока клиент дорисует чат после перехода. */
  const WALK_LOAD_TIMEOUT_MS = 15000;
  /**
   * И сколько раз при этом опрашиваем вкладку. Ограничение по числу опросов
   * страхует от вечного ожидания, если часы вкладки стоят (фон, заморозка
   * вкладки, отладка) — обход обязан когда-нибудь пойти дальше.
   */
  const WALK_LOAD_POLLS = 30;

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /** Пользователь что-то делает во вкладке — обход подождёт и не вырвет чат. */
  function markUserActivity() {
    if (state.walk.ourAction) return;   // это наш собственный клик по списку чатов
    state.walk.lastUserActivity = Date.now();
  }

  function watchUserActivity() {
    if (typeof document.addEventListener !== 'function') return;
    for (const type of ['keydown', 'mousedown', 'wheel', 'touchstart']) {
      try { document.addEventListener(type, markUserActivity, { passive: true, capture: true }); } catch { /* не важно */ }
    }
  }

  function clickRow(node) {
    if (!node) return false;
    if (typeof node.click === 'function') { node.click(); return true; }
    if (typeof node.dispatch === 'function') { node.dispatch('click'); return true; }
    return false;
  }

  function walkLog(target, ok, note) {
    const rec = {
      at: new Date().toISOString(),
      label: target ? target.label : '—',
      ok: ok === true ? true : (ok === false ? false : null),
      note: note || '',
    };
    state.walk.log = [rec].concat(state.walk.log).slice(0, WALK_LOG_MAX);
    return rec;
  }

  /**
   * Открыть цель: сначала адресом (не трогает разметку и работает в Web K/A/Z),
   * клик по списку чатов — запасной путь (цель задана названием, либо клиент не
   * понимает рум в адресе).
   */
  function walkNavigate(target) {
    if (!target) return { ok: false, how: null, error: 'нет цели' };
    state.walk.prevHash = String((typeof location !== 'undefined' && location.hash) || '');
    const hash = core.walkHashFor(target, typeof location !== 'undefined' ? location : null);
    state.walk.beforeFp = chatFingerprint();
    state.walk.ourAction = true;
    // снимаем флаг не сразу: клиент дорисовывает чат асинхронно, и его внутренние
    // клики/скроллы не должны считаться «пользователь работает»
    setTimeout(() => { state.walk.ourAction = false; }, 1500);

    if (hash) {
      if (String((typeof location !== 'undefined' && location.hash) || '') === hash) {
        return { ok: true, how: 'already' };
      }
      location.hash = hash;
      return { ok: true, how: 'address', hash };
    }
    const row = dom.findChatRow(document, [target.topic, target.value, target.label]);
    if (!row) return { ok: false, how: null, error: 'нет ни адреса, ни строки «' + target.label + '» в списке чатов' };
    if (!clickRow(row.node)) return { ok: false, how: null, error: 'строка «' + row.title + '» не кликабельна' };
    return { ok: true, how: 'click', title: row.title };
  }

  /**
   * Отпечаток открытого чата. Нужен, чтобы отличить «клиент правда открыл другой
   * чат» от «мы подставили адрес, а разметка осталась прежней» (нет доступа к
   * чату, клиент не понял рум, страница зависла) — иначе обход молча перечитывал
   * бы один и тот же чат, думая, что идёт по плану.
   */
  function chatFingerprint() {
    return typeof dom.contentFingerprint === 'function' ? dom.contentFingerprint(document) : '';
  }

  /** Дождаться, пока клиент дорисует чат после перехода. */
  async function walkWaitLoaded(target) {
    const startedAt = Date.now();
    let last = null;
    let polls = 0;
    while (Date.now() - startedAt < WALK_LOAD_TIMEOUT_MS && polls < WALK_LOAD_POLLS) {
      polls++;
      const chat = dom.readChatInfo(document, typeof window !== 'undefined' ? window.location : location);
      last = chat;
      if (core.walkTargetMatches(target, chat)
        && (!state.walk.beforeFp || chatFingerprint() !== state.walk.beforeFp)) {
        state.walk.beforeFp = '';
        const topicId = chat.topicId != null && chat.topicId !== '' ? Number(chat.topicId) : null;
        return { ok: true, chat, topicUnknown: target.topicId != null && topicId !== target.topicId };
      }
      await sleep(500);
    }
    return { ok: false, chat: last };
  }

  /**
   * Один такт обхода: 'read' — читать текущий чат, 'skip' — сейчас не читаем
   * (пауза, переход, ждём загрузки, лимит или пользователь работает).
   */
  async function walkStep() {
    const plan = core.walkTargets(state.settings.whitelist);
    state.walk.plan = plan;
    if (!plan.length) {
      state.walk.note = 'Белый список пуст — обходить нечего.';
      return 'skip';
    }

    // переход сделан — ждём, пока чат дорисуется
    if (state.walk.switching) {
      const target = state.walk.switching;
      const res = await walkWaitLoaded(target);
      state.walk.switching = null;
      state.walk.reads = 0;

      if (res.ok) {
        const i = core.walkIndexForChat(plan, res.chat);
        if (i >= 0) state.walk.index = i;
        state.walk.triedClick = false;
        state.walk.failed = [];   // цель открылась — провалы этого круга забыты
        walkLog(target, true, res.topicUnknown ? 'открыт (id рума клиент не отдал — беру из белого списка)' : 'открыт');
        state.walk.note = 'Читаю «' + target.label + '».';
        return 'read';
      }
      // адресом не вышло — один раз пробуем кликом по строке в списке чатов
      if (!state.walk.triedClick) {
        const row = dom.findChatRow(document, [target.topic, target.value, target.label]);
        if (row) {
          state.walk.triedClick = true;
          state.walk.ourAction = true;
          setTimeout(() => { state.walk.ourAction = false; }, 1500);
          clickRow(row.node);
          state.walk.switching = target;
          walkLog(target, null, 'адрес не сработал — пробую кликом по «' + row.title + '»');
          state.walk.note = 'Открываю «' + target.label + '» кликом по списку чатов…';
          return 'skip';
        }
      }
      state.walk.triedClick = false;
      state.walk.beforeFp = '';
      walkLog(target, false, 'не открылся за ' + Math.round(WALK_LOAD_TIMEOUT_MS / 1000) + ' с — пропускаю');
      /*
       * Клиент не переключился, а адрес вкладки мы уже поменяли: дальше читать
       * нельзя — сообщения прежнего чата ушли бы на сервер под именем цели,
       * которую мы не открыли (неверный chatId и неверные ссылки). Возвращаем
       * прежний адрес и исключаем цель до конца круга.
       */
      const back = state.walk.prevHash;
      if (back && String(location.hash || '') !== back) location.hash = back;
      state.walk.failed = state.walk.failed.concat([target.label]);
      if (state.walk.failed.length >= plan.length) state.walk.failed = [];
      state.walk.index = core.walkNextIndex(plan, state.walk.index, state.walk.failed);
      state.walk.reads = 0;
      state.walk.nextAt = Date.now() + core.walkPauseMs(state.settings.walkMinSec, state.settings.walkMaxSec);
      state.walk.note = '«' + target.label + '» не открылся — пропускаю, дальше по плану.';
      return 'skip';
    }

    // пользователь сам открыл чат из плана — продолжаем обход с него, а не «с начала»
    const chatNow = dom.readChatInfo(document, typeof window !== 'undefined' ? window.location : location);
    const idxNow = core.walkIndexForChat(plan, chatNow);
    if (idxNow >= 0 && idxNow !== state.walk.index) {
      // пользователь сам открыл чат из плана — читаем его сразу, остаток паузы
      // от предыдущего чата ждать не нужно
      state.walk.index = idxNow;
      state.walk.reads = 0;
      state.walk.nextAt = 0;
      state.walk.note = 'Вы открыли «' + plan[idxNow].label + '» — продолжаю обход с него.';
    }

    const decision = core.walkDecision({
      plan,
      index: state.walk.index,
      reads: state.walk.reads,
      nextAt: state.walk.nextAt,
      switching: false,
      switches: state.walk.switches,
      lastUserActivity: state.walk.lastUserActivity,
      now: Date.now(),
    }, state.settings);
    state.walk.note = decision.note || '';

    if (decision.action === 'wait') {
      // лимит переходов в час: откладываем на минуту и проверяем снова
      if (decision.reason === 'limit') state.walk.nextAt = Date.now() + 60000;
      return 'skip';
    }
    if (decision.action === 'navigate') {
      const index = core.walkNextIndex(plan, state.walk.index, state.walk.failed);
      const target = plan[index];
      state.walk.triedClick = false;
      const nav = walkNavigate(target);
      state.walk.switches = core.walkSwitchesInHour(state.walk.switches, Date.now()).concat([Date.now()]);
      state.walk.index = index;
      state.walk.reads = 0;
      state.walk.nextAt = 0;
      if (nav.ok) {
        state.walk.switching = target;
        walkLog(target, null, 'перехожу (' + (nav.how === 'address' ? 'по адресу' : nav.how === 'click' ? 'клик по списку' : 'уже открыт') + ')');
        state.walk.note = 'Открываю «' + target.label + '»…';
      } else {
        walkLog(target, false, nav.error);
        state.walk.nextAt = Date.now() + core.walkPauseMs(state.settings.walkMinSec, state.settings.walkMaxSec);
        state.walk.note = 'Не смог открыть «' + target.label + '»: ' + nav.error;
      }
      return 'skip';
    }
    return 'read';
  }

  /** Проход прочитан — считаем его и планируем паузу перед следующим переходом. */
  function walkCountRead() {
    if (!state.settings.autoWalk) return;
    state.walk.reads++;
    if (state.walk.reads >= state.settings.walkReadsPerChat) {
      state.walk.nextAt = Date.now() + core.walkPauseMs(state.settings.walkMinSec, state.settings.walkMaxSec);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Один проход чтения                                                */
  /* ---------------------------------------------------------------- */

  async function tick() {
    if (!core || !dom) { state.error = boot.error; render(); return; }

    // настройки может задавать панель (белый список чатов и румов, интервал, пауза)
    await syncConfig();

    if (state.settings.paused) { state.status = 'пауза'; render(); await postHeartbeat(); return; }
    if (Date.now() < state.backoffUntil) {
      state.status = 'ждем: ' + (state.backoffUntil === Infinity ? 'остановлено' : Math.ceil((state.backoffUntil - Date.now()) / 1000) + ' с');
      render();
      await postHeartbeat();
      return;
    }

    // автообход: сам открывает следующий чат/рум из белого списка
    if (state.settings.autoWalk) {
      const step = await walkStep();
      if (step !== 'read') {
        state.status = state.walk.note || 'обход';
        state.unreadable = false;
        await persist();
        render();
        await postHeartbeat();
        return;
      }
    }

    const chat = dom.readChatInfo(document, window.location);
    // форум-чат: если клиент не отдал id рума в адресе, а белый список закрепляет
    // за этим чатом ровно один рум — берём его и честно пишем об этом в статусе
    const adoptedTopic = core.adoptTopicFromWhitelist(chat, state.settings.whitelist);
    if (adoptedTopic) {
      chat.topicId = adoptedTopic.topicId;
      chat.topicIdSource = 'whitelist';
    }
    state.topicNote = adoptedTopic ? adoptedTopic.note : null;
    const chatKey = core.chatKeyOf(chat);
    const whitelisted = core.matchesWhitelist(chat, state.settings.whitelist);
    state.lastChat = {
      chatKey: chatKey, title: chat.title, username: chat.username, kind: chat.kind,
      groupTitle: chat.groupTitle, topicTitle: chat.topicTitle, topicId: chat.topicId,
      whitelisted: whitelisted, at: new Date().toISOString(),
    };

    if (!chatKey || !whitelisted) {
      // всё, что не в белом списке, игнорируется ПОЛНОСТЬЮ — сообщения не читаем
      const note = chatKey ? core.whitelistMismatch(chat, state.settings.whitelist) : null;
      state.unreadable = false;
      state.status = !chatKey
        ? 'чат не определён (откройте диалог)'
        : (note || `чат «${chat.title || chatKey}» не в белом списке — пропускаем`);
      state.lastDiagnostic = {
        url: location.href, chat, chatKey, whitelisted, whitelistNote: note, total: 0, toSend: 0,
      };
      render();
      await persist();
      await postHeartbeat();
      return;
    }

    const harvested = dom.harvest(document, { limit: state.settings.maxPerChat, now: Date.now() });
    if (harvested.unreadable || harvested.messages.length === 0) {
      state.unreadable = true;
      state.error = 'Не могу прочитать сообщения: Telegram Web изменил разметку или чат пуст. ' +
        'Сбор paused, пока не починим селекторы (см. extension/dom.js).';
      state.counters = core.mergeCounters(state.counters, { errors: 1 });
      state.lastDiagnostic = {
        url: location.href, chat, chatKey, whitelisted: true,
        total: harvested.total, unreadable: true, strategy: harvested.strategy,
      };
      await persist();
      render();
      return;
    }
    state.unreadable = false;

    const reasons = {};
    const candidates = [];
    let alreadySent = 0;
    for (const raw of harvested.messages) {
      const m = core.toPayloadMessage(Object.assign({}, raw, { chat: Object.assign({ chatId: chatKey }, chat) }), state.settings);
      const verdict = core.detect(m.text, parser, state.settings);
      if (!verdict.send) {
        reasons[verdict.reason] = (reasons[verdict.reason] || 0) + 1;
        rememberExamined(m, 'rejected', verdict.reason);
        continue;
      }
      if (!core.withinAge(m.dateMs, state.settings.maxAgeHours, Date.now())) {
        reasons.old = (reasons.old || 0) + 1;
        rememberExamined(m, 'old', 'old');
        continue;
      }
      if (state.sentKeys.includes(core.sentKey(m.chatId, m.messageId))) {
        alreadySent++;
        rememberExamined(m, 'duplicate', 'duplicate');
        continue;
      }
      if (state.pending.some((p) => p.chatId === m.chatId && p.messageId === m.messageId)) {
        alreadySent++;
        rememberExamined(m, 'duplicate', 'duplicate');
        continue;
      }
      candidates.push(m);
      rememberExamined(m, 'listing', verdict.reason);
    }

    const fresh = core.filterUnsent(candidates, state.sentKeys);
    state.counters = core.mergeCounters(state.counters, { found: harvested.messages.length });
    state.lastDiagnostic = {
      url: location.href, chat, chatKey, whitelisted: true,
      topicNote: state.topicNote,
      total: harvested.messages.length, strategy: harvested.strategy,
      toSend: fresh.length, alreadySent, filtered: harvested.messages.length - fresh.length - alreadySent,
      reasons, counts: harvested.counts,
      // последние разобранные сообщения с вердиктами и ссылками (для диагностики и панели)
      recent: state.recent.slice(0, 12),
    };

    walkCountRead();

    if (!fresh.length) {
      state.status = `чат «${chat.title}»${chat.topicId != null ? ', рум ' + chat.topicId : ''}: ` +
        `прочитано ${harvested.messages.length}, нового нет`;
      await persist();
      render();
      await postHeartbeat();
      return;
    }

    if (state.settings.confirmMode) {
      // режим «спрашивать подтверждение» (по умолчанию включён)
      state.pending = state.pending.concat(fresh);
      state.status = `найдено ${fresh.length} — подтвердите отправку`;
      await persist();
      render();
      await postHeartbeat();
      return;
    }

    state.status = `найдено ${fresh.length} — отправляю`;
    render();
    await sendPending({ messages: fresh });
    await postHeartbeat();
  }

  /* ---------------------------------------------------------------- */
  /* Связь с панелью: настройки оттуда и отметка «аккаунт подключён»    */
  /* ---------------------------------------------------------------- */

  /**
   * Забрать настройки из панели (белый список чатов и румов, интервал, пауза).
   * Сервер без этих ручек отвечает 404 — тогда работаем на локальных настройках.
   */
  async function syncConfig() {
    if (!state.settings.serverUrl || !state.settings.token) return null;
    try {
      const res = await fetch(state.settings.serverUrl + '/api/extension/config', {
        headers: { Authorization: 'Bearer ' + state.settings.token },
        cache: 'no-store',
      });
      if (!res.ok) { state.configFromServer = false; return null; }
      const body = await res.json().catch(() => null);
      const cfg = body && body.config;
      if (!cfg) { state.configFromServer = false; return null; }
      return await applyConfig(cfg);
    } catch (e) {
      state.configError = 'Настройки из панели не получены: ' + String(e && e.message || e);
      return null;
    }
  }

  /** Применить настройки, присланные панелью (белый список чатов и румов, интервал, пауза). */
  async function applyConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') { state.configFromServer = false; return null; }
    const before = JSON.stringify(state.settings);
    if (Array.isArray(cfg.whitelist) || typeof cfg.whitelist === 'string') {
      const list = typeof cfg.whitelist === 'string' ? cfg.whitelist.split(/[\n,;]+/) : cfg.whitelist;
      state.settings.whitelist = list.map((x) => String(x).trim()).filter(Boolean);
    }
    if (cfg.intervalSec != null) {
      state.settings.intervalSec = core.clamp(Number(cfg.intervalSec) || 120, 60, 600);
      restartTimer(); // интервал мог измениться
    }
    if (typeof cfg.paused === 'boolean') state.settings.paused = cfg.paused;
    // автообход: панель может включить/выключить и задать темп переходов
    if (typeof cfg.autoWalk === 'boolean') state.settings.autoWalk = cfg.autoWalk;
    const walkLimits = {
      walkReadsPerChat: [1, 20], walkMinSec: [10, 3600], walkMaxSec: [10, 7200],
      walkMaxPerHour: [1, 600], walkIdleGuardSec: [0, 1800],
    };
    for (const key in walkLimits) {
      if (cfg[key] == null) continue;
      const range = walkLimits[key];
      state.settings[key] = core.clamp(Math.round(Number(cfg[key]) || range[0]), range[0], range[1]);
    }
    state.configFromServer = true;
    state.configError = null;
    if (JSON.stringify(state.settings) !== before) { await persist(); render(); }
    return cfg;
  }

  /** Отметка для панели: аккаунт подключён, такой-то чат/рум, такие-то счётчики. */
  async function postHeartbeat() {
    if (!state.settings.serverUrl || !state.settings.token) return;
    try {
      const res = await fetch(state.settings.serverUrl + '/api/extension/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.settings.token },
        body: JSON.stringify({
          clientId: state.clientId || newClientId(),
          collector: core.COLLECTOR,
          at: new Date().toISOString(),
          url: location.href,
          chat: state.lastChat,
          counters: state.counters,
          status: state.status,
          error: state.error,
          pending: state.pending.length,
          unreadable: state.unreadable,
          // автообход: где сейчас, куда дальше, сколько переходов в час
          walk: walkPublic(),
          whitelist: state.settings.whitelist,
          intervalSec: state.settings.intervalSec,
          paused: state.settings.paused,
          confirmMode: state.settings.confirmMode,
        }),
        cache: 'no-store',
      });
      // настройки панель отдаёт вместе с ответом на отметку — одним запросом
      if (res && res.ok) {
        const body = await res.json().catch(() => null);
        if (body && body.config) await applyConfig(body.config);
      }
    } catch {
      // панель не увидит отметку — это не повод останавливать сбор
    }
  }

  /* ---------------------------------------------------------------- */
  /* Панель (своя, в страницу ничего не пишет)                         */
  /* ---------------------------------------------------------------- */

  const STYLE = [
    '#pk-panel{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:320px;max-height:70vh;overflow:auto;',
    'background:#fff;border:1px solid #d7dde3;border-radius:12px;box-shadow:0 8px 28px rgba(15,23,42,.18);',
    'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#0f172a}',
    '#pk-panel *{box-sizing:border-box}',
    '#pk-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #eef1f4;cursor:pointer}',
    '#pk-head b{font-size:13px}',
    '#pk-body{padding:10px 12px}',
    '.pk-row{display:flex;justify-content:space-between;gap:8px;padding:2px 0}',
    '.pk-muted{color:#64748b}',
    '.pk-err{background:#fff1f2;color:#9f1239;border:1px solid #fecdd3;border-radius:8px;padding:6px 8px;margin:6px 0}',
    '.pk-warn{background:#fffbeb;color:#92400e;border:1px solid #fde68a;border-radius:8px;padding:6px 8px;margin:6px 0}',
    '.pk-ok{background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;border-radius:8px;padding:6px 8px;margin:6px 0}',
    '.pk-btn{border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:5px 9px;cursor:pointer;font-size:12px}',
    '.pk-btn:hover{background:#f8fafc}',
    '.pk-btn.primary{background:#0f172a;border-color:#0f172a;color:#fff}',
    '.pk-item{border-top:1px solid #f1f5f9;padding:6px 0;display:flex;gap:8px}',
    '.pk-item label{flex:1;display:flex;gap:6px;align-items:flex-start}',
    '.pk-item small{color:#64748b;display:block}',
    '.pk-btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
    '.pk-sec{display:flex;justify-content:space-between;gap:8px;margin-top:10px;cursor:pointer;color:#475569;font-weight:600}',
    '.pk-rec{border-top:1px solid #f1f5f9;padding:5px 0}',
    '.pk-rec-top{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}',
    '.pk-badge{font-size:11px;padding:1px 6px;border-radius:999px;border:1px solid #e2e8f0;color:#475569;background:#f8fafc;white-space:nowrap}',
    '.pk-badge.ok{background:#f0fdf4;border-color:#bbf7d0;color:#166534}',
    '.pk-badge.sent{background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8}',
    '.pk-rec-text{color:#0f172a}',
    '.pk-rec-meta{color:#94a3b8;font-size:11px}',
    '.pk-rec a{color:#2563eb;text-decoration:none;font-size:11px}',
    '.pk-rec a:hover{text-decoration:underline}',
    '#pk-panel.pk-collapsed #pk-body{display:none}',
  ].join('\n');

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const k in (attrs || {})) {
      const v = attrs[k];
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of (children || [])) if (c) node.append(c);
    return node;
  }

  function ensurePanel() {
    if (document.getElementById('pk-panel')) return document.getElementById('pk-panel');
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.documentElement.append(style);
    const panel = el('div', { id: 'pk-panel' });
    document.documentElement.append(panel);
    return panel;
  }

  function render() {
    const panel = ensurePanel();
    const c = state.counters || {};
    panel.replaceChildren();

    const head = el('div', {
      id: 'pk-head',
      onclick: () => { panel.classList.toggle('pk-collapsed'); },
    }, [
      el('b', { text: 'попутка. сбор' }),
      el('span', { class: 'pk-muted', text: state.settings.paused ? '⏸ пауза' : (state.unreadable ? '⚠ разметка' : '● работает') }),
      el('span', { class: 'pk-muted', style: 'margin-left:auto', text: 'свернуть' }),
    ]);

    const body = el('div', { id: 'pk-body' }, [
      el('div', { class: 'pk-row' }, [el('span', { class: 'pk-muted', text: 'статус' }), el('span', { text: state.status })]),
      el('div', { class: 'pk-row' }, [el('span', { class: 'pk-muted', text: 'найдено' }), el('span', { text: String(c.found || 0) })]),
      el('div', { class: 'pk-row' }, [el('span', { class: 'pk-muted', text: 'отправлено' }), el('span', { text: String(c.sent || 0) })]),
      el('div', { class: 'pk-row' }, [el('span', { class: 'pk-muted', text: 'заявок создано' }), el('span', { text: String(c.created || 0) })]),
      el('div', { class: 'pk-row' }, [el('span', { class: 'pk-muted', text: 'дублей' }), el('span', { text: String(c.duplicate || 0) })]),
      el('div', { class: 'pk-row' }, [el('span', { class: 'pk-muted', text: 'отсеяно детектом' }), el('span', { text: String(c.skipped || 0) })]),
      state.error
        ? el('div', { class: state.unreadable ? 'pk-warn' : 'pk-err', text: state.error })
        : (c.created ? el('div', { class: 'pk-ok', text: 'Последние заявки ушли в очередь модерации.' }) : null),
      state.topicNote ? el('div', { class: 'pk-warn', text: state.topicNote }) : null,
    ]);

    if (state.pending.length) {
      body.append(el('div', { class: 'pk-muted', style: 'margin-top:6px', text: 'Ждут подтверждения: ' + state.pending.length }));
      for (const m of state.pending.slice(0, 8)) {
        body.append(el('div', { class: 'pk-item' }, [
          el('label', {}, [
            el('input', { type: 'checkbox', checked: 'checked', 'data-key': core.sentKey(m.chatId, m.messageId) }),
            el('span', {}, [
              el('span', { text: m.text.replace(/\s+/g, ' ').slice(0, 110) + (m.text.length > 110 ? '…' : '') }),
              el('small', { text: m.chatId + ' · #' + m.messageId + (m.idSource === 'synthetic' ? ' · id синтетический' : '') }),
              m.link ? el('a', { href: m.link, target: '_blank', rel: 'noreferrer', style: 'color:#2563eb;font-size:11px', text: m.link.replace(/^https:\/\//, '') }) : null,
            ]),
          ]),
        ]));
      }
    }

    // Автообход: где сейчас, куда дальше, сколько переходов и чем они кончились
    const walk = walkPublic();
    if (walk.on || walk.log.length) {
      body.append(el('div', {
        class: 'pk-sec',
        onclick: () => { state.ui.showWalk = !state.ui.showWalk; render(); },
      }, [
        el('span', { text: 'Обход чатов: ' + (walk.on ? 'включён' : 'выключен') }),
        el('span', { class: 'pk-muted', text: state.ui.showWalk ? 'скрыть' : 'показать' }),
      ]));
      if (state.ui.showWalk) {
        if (walk.on) {
          body.append(el('div', { class: 'pk-row' }, [
            el('span', { class: 'pk-muted', text: 'сейчас' }),
            el('span', { text: walk.switching ? 'открываю ' + walk.switching : (walk.current || '—') }),
          ]));
          body.append(el('div', { class: 'pk-row' }, [
            el('span', { class: 'pk-muted', text: 'дальше' }), el('span', { text: walk.next || '—' }),
          ]));
          body.append(el('div', { class: 'pk-row' }, [
            el('span', { class: 'pk-muted', text: 'переход через' }),
            el('span', { text: walk.nextInSec ? walk.nextInSec + ' с' : 'как дочитаю чат' }),
          ]));
          body.append(el('div', { class: 'pk-row' }, [
            el('span', { class: 'pk-muted', text: 'переходов за час' }),
            el('span', { text: walk.switchesHour + ' из ' + walk.switchesLimit }),
          ]));
        }
        if (walk.note) body.append(el('div', { class: 'pk-muted', style: 'padding:2px 0', text: walk.note }));
        for (const rec of walk.log.slice(0, 8)) {
          const cls = rec.ok === false ? 'pk-badge' : (rec.ok ? 'pk-badge ok' : 'pk-badge sent');
          const label = rec.ok === false ? '✖ не открылся' : (rec.ok ? '✔ открыт' : '→ переход');
          body.append(el('div', { class: 'pk-rec' }, [
            el('div', { class: 'pk-rec-top' }, [
              el('span', { class: cls, text: label }),
              el('span', { class: 'pk-rec-text', text: rec.label }),
            ]),
            rec.note ? el('div', { class: 'pk-rec-meta', text: rec.note }) : null,
          ]));
        }
        if (!walk.log.length) {
          body.append(el('div', { class: 'pk-muted', style: 'padding:4px 0', text: 'Переходов ещё не было.' }));
        }
      }
    }

    // Журнал разбора: видно каждое сообщение, которое расширение прочитало,
    // вердикт, причину и ссылку на первоисточник (чтобы открыть и переслать).
    body.append(el('div', {
      class: 'pk-sec',
      onclick: () => { state.ui.showRecent = !state.ui.showRecent; render(); },
    }, [
      el('span', { text: 'Что нашлось (' + state.recent.length + ')' }),
      el('span', { class: 'pk-muted', text: state.ui.showRecent ? 'скрыть' : 'показать' }),
    ]));
    if (state.ui.showRecent) {
      if (!state.recent.length) {
        body.append(el('div', { class: 'pk-muted', style: 'padding:4px 0', text: 'Пока ни одного сообщения не разобрали. Откройте чат из белого списка и дождитесь прохода.' }));
      }
      for (const rec of state.recent.slice(0, 12)) {
        const badgeClass = rec.verdict === 'listing' ? (rec.sent ? 'pk-badge sent' : 'pk-badge ok') : 'pk-badge';
        body.append(el('div', { class: 'pk-rec' }, [
          el('div', { class: 'pk-rec-top' }, [
            el('span', { class: badgeClass, text: core.VERDICT_LABELS[rec.verdict] || rec.verdict }),
            el('span', { class: 'pk-rec-meta', text: rec.sent ? 'отправлено на сервер' : (rec.reason ? core.explainReason(rec.reason) : '') }),
          ]),
          el('div', {
            class: 'pk-rec-meta',
            text: (rec.chat || rec.chatId || '') + (rec.topicId ? ' · рум ' + rec.topicId : ''),
          }),
          el('div', { class: 'pk-rec-text', text: (rec.author ? rec.author + ': ' : '') + rec.text }),
          rec.link
            ? el('a', { href: rec.link, target: '_blank', rel: 'noreferrer', text: rec.link.replace(/^https:\/\//, '') })
            : el('div', { class: 'pk-rec-meta', text: 'ссылки нет: id сообщения не прочитался в разметке' }),
        ]));
      }
    }

    body.append(el('div', { class: 'pk-btns' }, [
      el('button', {
        class: 'pk-btn primary',
        text: state.pending.length ? `Отправить найденные (${state.pending.length})` : 'Отправить все найденные',
        onclick: () => {
          const boxes = panel.querySelectorAll('.pk-item input[type=checkbox]');
          const chosen = boxes.length
            ? state.pending.filter((m) => {
                const box = panel.querySelector(`.pk-item input[data-key="${CSS.escape(core.sentKey(m.chatId, m.messageId))}"]`);
                return !box || box.checked;
              })
            : state.pending;
          if (!chosen.length) { state.status = 'ничего не выбрано'; render(); return; }
          sendPending({ messages: chosen });
        },
      }),
      el('button', {
        class: 'pk-btn',
        text: state.settings.paused ? 'Продолжить' : 'Пауза',
        onclick: async () => {
          state.settings.paused = !state.settings.paused;
          await persist();
          render();
        },
      }),
      el('button', {
        class: 'pk-btn',
        text: state.settings.autoWalk ? 'Обход: выключить' : 'Обход: включить',
        title: 'Расширение само открывает чаты и румы из белого списка со случайными паузами',
        onclick: async () => {
          state.settings.autoWalk = !state.settings.autoWalk;
          if (state.settings.autoWalk) {
            // стартуем с того чата, который открыт сейчас (если он в плане)
            const plan = core.walkTargets(state.settings.whitelist);
            const here = core.walkIndexForChat(plan, dom.readChatInfo(document, window.location));
            state.walk.index = here >= 0 ? here : 0;
            state.walk.reads = 0;
            state.walk.nextAt = 0;
          }
          state.status = state.settings.autoWalk ? 'обход включён' : 'обход выключен';
          await persist();
          render();
        },
      }),
      el('button', { class: 'pk-btn', text: 'Диагностика', onclick: () => { showDiagnostic(); } }),
      el('button', {
        class: 'pk-btn', text: 'Настройки', onclick: () => {
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
            // открыть попап из content script нельзя — подсказываем, где он
            state.status = 'Настройки — в попапе расширения (иконка на панели браузера)';
            render();
          } else {
            state.status = 'Юзерскрипт: настройки в localStorage["poputchka"]';
            render();
          }
        },
      }),
    ]));

    panel.append(head, body);
  }

  function showDiagnostic() {
    const text = core.diagnostic(state.lastDiagnostic);
    const panel = ensurePanel();
    const pre = el('pre', {
      style: 'white-space:pre-wrap;background:#0f172a;color:#e2e8f0;padding:8px;border-radius:8px;font-size:11px;margin-top:8px',
      text,
    });
    panel.querySelector('#pk-body').append(pre);
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => undefined);
  }

  /* ---------------------------------------------------------------- */
  /* Запуск                                                            */
  /* ---------------------------------------------------------------- */

  function restartTimer() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => { tick().catch((e) => { state.error = String(e && e.message || e); render(); }); },
      state.settings.intervalSec * 1000);
  }

  /** Перечитать настройки (вызывает попап после сохранения). */
  async function reloadSettings() {
    await loadState();
    restartTimer();
    render();
  }

  /** Команды попапа. Отвечаем даже когда инициализация не удалась (boot.ok === false). */
  async function handleMessage(msg) {
    if (!msg || !msg.type) return { ok: false, boot };
    if (msg.type === 'pk:ping') return { ok: boot.ok, boot, state: safeState() };
    if (!boot.ok || !core) {
      return { ok: false, boot, error: boot.error || 'контент-скрипт не инициализирован' };
    }
    if (msg.type === 'pk:reload') { await reloadSettings(); return { ok: true, boot, state: publicState() }; }
    if (msg.type === 'pk:state') return { ok: true, boot, state: publicState() };
    if (msg.type === 'pk:diagnostic') {
      await tick();
      return { ok: true, boot, diagnostic: core.diagnostic(state.lastDiagnostic), raw: state.lastDiagnostic, state: publicState() };
    }
    if (msg.type === 'pk:pause') {
      state.settings.paused = !state.settings.paused;
      await persist(); render(); await postHeartbeat();
      return { ok: true, boot, state: publicState() };
    }
    if (msg.type === 'pk:send') { await sendPending(); await postHeartbeat(); return { ok: true, boot, state: publicState() }; }
    if (msg.type === 'pk:sync') { const cfg = await syncConfig(); return { ok: true, boot, config: cfg, state: publicState() }; }
    if (msg.type === 'pk:reset') {
      state.counters = {}; state.sentKeys = []; state.pending = []; state.error = null;
      await persist(); render();
      return { ok: true, boot, state: publicState() };
    }
    return { ok: false, boot, error: 'неизвестная команда: ' + msg.type };
  }

  function publicState() {
    return {
      settings: Object.assign({}, state.settings, { token: state.settings.token ? '***' : '' }),
      counters: state.counters,
      pending: state.pending.length,
      recent: state.recent.slice(0, 40),
      walk: walkPublic(),
      status: state.status,
      error: state.error,
      diagnostic: state.lastDiagnostic,
      clientId: state.clientId,
      chat: state.lastChat,
      configFromServer: state.configFromServer,
      configError: state.configError,
      unreadable: state.unreadable,
      version: boot.version,
    };
  }

  (async function init() {
    if (!core || !dom) { boot.ok = false; try { render(); } catch { /* панель не важна */ } return; }
    boot.ok = true;
    await loadState();
    watchUserActivity();
    render();
    restartTimer();
    await persist();          // отметка «расширение живо в этой вкладке»
    await syncConfig();
    await postHeartbeat();
    // первый проход — не сразу: даём клиенту дорисовать список сообщений
    setTimeout(() => { tick().catch(() => undefined); }, 4000);
    console.info('[попутка.] сборщик запущен: интервал', state.settings.intervalSec + 'с',
      parser ? '(детект на правилах parser.ts)' : '(детект по ключевым словам — бандл парсера не подключён)');
  })();
})();
