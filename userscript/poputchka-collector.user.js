// ==UserScript==
// @name         попутка. — сбор объявлений из чатов Telegram Web
// @namespace    https://github.com/Bergaff/bot
// @version      1.0.0
// @description  Только чтение: находит объявления о передаче посылок в открытой вкладке Telegram Web и отправляет их на сервер попутки (POST /api/ingest). Ничего не публикует от вашего имени.
// @match        https://web.telegram.org/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==
/*
 * Сгенерирован scripts/build-extension.mjs из тех же файлов, что и расширение:
 *   extension/vendor/parser.js
 *   extension/core.cjs
 *   extension/dom.cjs
 *   extension/content.js
 *
 * Настройки юзерскрипта — в localStorage["poputchka"] (попапа у юзерскрипта нет):
 *   localStorage.setItem('poputchka', JSON.stringify({ settings: {
 *     serverUrl: 'https://pop-utka.app',
 *     token: 'ВАШ_INGEST_TOKEN',
 *     whitelist: ['Водители Польша–Беларусь'],
 *     intervalSec: 120, batchSize: 20, maxPerChat: 30,
 *     confirmMode: true, paused: false, maxAgeHours: 72, requireContact: false,
 *   }}));
 *   location.reload();
 *
 * Счётчики и лог отправленного живут там же; панель — справа внизу вкладки.
 */

/* ---- extension/vendor/parser.js ---- */
"use strict";var PoputkaParser=(()=>{var p=Object.defineProperty;var C=Object.getOwnPropertyDescriptor;var q=Object.getOwnPropertyNames;var x=Object.prototype.hasOwnProperty;var A=(t,e)=>{for(var n in e)p(t,n,{get:e[n],enumerable:!0})},T=(t,e,n,r)=>{if(e&&typeof e=="object"||typeof e=="function")for(let i of q(e))!x.call(t,i)&&i!==n&&p(t,i,{get:()=>e[i],enumerable:!(r=C(e,i))||r.enumerable});return t};var F=t=>T(p({},"__esModule",{value:!0}),t);var ee={};A(ee,{isMultiRoute:()=>R,isPassengerOnly:()=>I,looksLikeListing:()=>v,normalizeCity:()=>z,parseTelegramMessage:()=>y,scoreIntent:()=>g,worthAiCheck:()=>$});var h={\u0432\u0430\u0440\u0448\u0430\u0432\u0430:"\u0412\u0430\u0440\u0448\u0430\u0432\u0430",\u0432\u0430\u0440\u0448\u0430\u0432:"\u0412\u0430\u0440\u0448\u0430\u0432\u0430",\u043A\u0440\u0430\u043A\u043E\u0432:"\u041A\u0440\u0430\u043A\u043E\u0432",\u043A\u0440\u0430\u043A\u043E\u0432\u043E\u0432:"\u041A\u0440\u0430\u043A\u043E\u0432",\u0433\u0434\u0430\u043D\u0441\u044C\u043A:"\u0413\u0434\u0430\u043D\u044C\u0441\u043A",\u0433\u0434\u0430\u043D\u0441\u043A:"\u0413\u0434\u0430\u043D\u044C\u0441\u043A",\u0433\u0434\u0430\u043D\u044C\u0441\u043A:"\u0413\u0434\u0430\u043D\u044C\u0441\u043A",\u0434\u0430\u043D\u0446\u0438\u0433:"\u0413\u0434\u0430\u043D\u044C\u0441\u043A",\u0432\u0440\u043E\u0446\u043B\u0430\u0432:"\u0412\u0440\u043E\u0446\u043B\u0430\u0432",\u0432\u0440\u043E\u0446\u043B\u0430\u0432\u043E\u0432:"\u0412\u0440\u043E\u0446\u043B\u0430\u0432",\u043F\u043E\u0437\u043D\u0430\u043D\u044C:"\u041F\u043E\u0437\u043D\u0430\u043D\u044C",\u043F\u043E\u0437\u043D\u0430\u043D\u0438:"\u041F\u043E\u0437\u043D\u0430\u043D\u044C",\u043B\u043E\u0434\u0437\u044C:"\u041B\u043E\u0434\u0437\u044C",\u043B\u043E\u0434\u0437\u0438:"\u041B\u043E\u0434\u0437\u044C",\u043A\u0430\u0442\u043E\u0432\u0438\u0446\u0435:"\u041A\u0430\u0442\u043E\u0432\u0438\u0446\u0435",\u043A\u0430\u0442\u043E\u0432\u0438\u0446\u044B:"\u041A\u0430\u0442\u043E\u0432\u0438\u0446\u0435",\u043A\u0430\u0442\u043E\u0432\u0438\u0446:"\u041A\u0430\u0442\u043E\u0432\u0438\u0446\u0435",\u043B\u044E\u0431\u043B\u0438\u043D:"\u041B\u044E\u0431\u043B\u0438\u043D",\u0431\u0435\u043B\u043E\u0441\u0442\u043E\u043A:"\u0411\u0435\u043B\u043E\u0441\u0442\u043E\u043A",\u0431\u0438\u043B\u043E\u0441\u0442\u043E\u043A:"\u0411\u0435\u043B\u043E\u0441\u0442\u043E\u043A",\u0431\u044F\u043B\u044B\u0441\u0442\u043E\u043A:"\u0411\u0435\u043B\u043E\u0441\u0442\u043E\u043A",\u043A\u0443\u0437\u043D\u0438\u0446\u0430:"\u041A\u0443\u0437\u043D\u0438\u0446\u0430",kuznica:"\u041A\u0443\u0437\u043D\u0438\u0446\u0430",ku\u017Anica:"\u041A\u0443\u0437\u043D\u0438\u0446\u0430",\u0431\u0440\u0443\u0437\u0433\u0438:"\u0411\u0440\u0443\u0437\u0433\u0438",bruzgi:"\u0411\u0440\u0443\u0437\u0433\u0438",\u0430\u0432\u0433\u0443\u0441\u0442\u043E\u0432:"\u0410\u0432\u0433\u0443\u0441\u0442\u043E\u0432",augustow:"\u0410\u0432\u0433\u0443\u0441\u0442\u043E\u0432",\u0449\u0435\u0446\u0438\u043D:"\u0429\u0435\u0446\u0438\u043D",\u0448\u0447\u0435\u0446\u0438\u043D:"\u0429\u0435\u0446\u0438\u043D",\u0431\u044B\u0434\u0433\u043E\u0449:"\u0411\u044B\u0434\u0433\u043E\u0449",\u0431\u044B\u0434\u0433\u043E\u0449\u044C:"\u0411\u044B\u0434\u0433\u043E\u0449",\u0442\u043E\u0440\u0443\u043D\u044C:"\u0422\u043E\u0440\u0443\u043D\u044C",\u0442\u043E\u0440\u0443\u043D\u0456:"\u0422\u043E\u0440\u0443\u043D\u044C",\u0447\u0435\u043D\u0441\u0442\u043E\u0445\u043E\u0432\u0430:"\u0427\u0435\u043D\u0441\u0442\u043E\u0445\u043E\u0432\u0430",\u0447\u0435\u043D\u0441\u0442\u043E\u0445\u043E\u0432\u043E:"\u0427\u0435\u043D\u0441\u0442\u043E\u0445\u043E\u0432\u0430",\u0440\u0430\u0434\u043E\u043C:"\u0420\u0430\u0434\u043E\u043C",\u0441\u043E\u0441\u043D\u043E\u0432\u0435\u0446:"\u0421\u043E\u0441\u043D\u043E\u0432\u0435\u0446",\u0441\u043E\u0441\u043D\u043E\u0432\u0454\u0446:"\u0421\u043E\u0441\u043D\u043E\u0432\u0435\u0446",\u0433\u0434\u044B\u043D\u044F:"\u0413\u0434\u044B\u043D\u044F",\u0433\u0434\u0438\u043D\u044F:"\u0413\u0434\u044B\u043D\u044F",\u043E\u043B\u044C\u0448\u0442\u044B\u043D:"\u041E\u043B\u044C\u0448\u0442\u044B\u043D",\u0436\u0435\u0448\u0443\u0432:"\u0416\u0435\u0448\u0443\u0432",\u0440\u0436\u0435\u0448\u0443\u0432:"\u0416\u0435\u0448\u0443\u0432","\u0437\u0435\u043B\u0435\u043D\u0430-\u0433\u0443\u0440\u0430":"\u0417\u0435\u043B\u0451\u043D\u0430-\u0413\u0443\u0440\u0430",\u043E\u043F\u043E\u043B\u0435:"\u041E\u043F\u043E\u043B\u0435","\u0431\u0435\u043B\u044C\u0441\u043A\u043E-\u0431\u044F\u043B\u0430":"\u0411\u0435\u043B\u044C\u0441\u043A\u043E-\u0411\u044F\u043B\u0430",\u043A\u0435\u043B\u044C\u0446\u0435:"\u041A\u0435\u043B\u044C\u0446\u0435",\u0433\u043B\u0438\u0432\u0438\u0446\u0435:"\u0413\u043B\u0438\u0432\u0438\u0446\u0435",\u0433\u043B\u0438\u0432\u0438\u0446\u044B:"\u0413\u043B\u0438\u0432\u0438\u0446\u0435",\u0437\u0430\u0431\u0436\u0435:"\u0417\u0430\u0431\u0436\u0435",\u0431\u044B\u0442\u043E\u043C:"\u0411\u044B\u0442\u043E\u043C",\u0442\u044B\u0445\u044B:"\u0422\u044B\u0445\u044B",\u043F\u043B\u043E\u0446\u043A:"\u041F\u043B\u043E\u0446\u043A",\u044D\u043B\u044C\u0431\u043B\u043E\u043D\u0433:"\u042D\u043B\u044C\u0431\u043B\u043E\u043D\u0433",\u0432\u0430\u043B\u0431\u0436\u0438\u0445:"\u0412\u0430\u043B\u0431\u0436\u0438\u0445",\u0432\u043B\u043E\u0446\u043B\u0430\u0432\u0435\u043A:"\u0412\u043B\u043E\u0446\u043B\u0430\u0432\u0435\u043A",\u0442\u0430\u0440\u043D\u0443\u0432:"\u0422\u0430\u0440\u043D\u0443\u0432",\u043A\u043E\u0448\u0430\u043B\u0438\u043D:"\u041A\u043E\u0448\u0430\u043B\u0438\u043D",\u043A\u0430\u043B\u0438\u0448:"\u041A\u0430\u043B\u0438\u0448",\u043B\u0435\u0433\u0438\u043D\u0446\u0430:"\u041B\u0435\u0433\u043D\u0438\u0446\u0430",\u043B\u0435\u0433\u043D\u0438\u0446\u0430:"\u041B\u0435\u0433\u043D\u0438\u0446\u0430",\u0433\u0440\u0443\u0434\u0437\u0451\u043D\u0434\u0437:"\u0413\u0440\u0443\u0434\u0437\u0451\u043D\u0434\u0437",\u0433\u0440\u0443\u0434\u0437\u0435\u043D\u0434\u0437:"\u0413\u0440\u0443\u0434\u0437\u0451\u043D\u0434\u0437",\u0441\u043B\u0443\u043F\u0441\u043A:"\u0421\u043B\u0443\u043F\u0441\u043A",\u0445\u043E\u0436\u0443\u0432:"\u0425\u043E\u0436\u0443\u0432",\u043A\u0438\u0435\u0432:"\u041A\u0438\u0435\u0432",\u043A\u0438\u0457\u0432:"\u041A\u0438\u0435\u0432",\u043B\u044C\u0432\u043E\u0432:"\u041B\u044C\u0432\u043E\u0432",\u043B\u044C\u0432\u0456:"\u041B\u044C\u0432\u043E\u0432",\u0445\u0430\u0440\u044C\u043A\u043E\u0432:"\u0425\u0430\u0440\u044C\u043A\u043E\u0432",\u0445\u0430\u0440\u043A\u0456\u0432:"\u0425\u0430\u0440\u044C\u043A\u043E\u0432",\u043E\u0434\u0435\u0441\u0441\u0430:"\u041E\u0434\u0435\u0441\u0441\u0430",\u043E\u0434\u0435\u0441\u0430:"\u041E\u0434\u0435\u0441\u0441\u0430",\u0434\u043D\u0435\u043F\u0440:"\u0414\u043D\u0435\u043F\u0440",\u0434\u043D\u0456\u043F\u0440\u043E:"\u0414\u043D\u0435\u043F\u0440",\u0434\u043D\u0435\u043F\u0440\u043E\u043F\u0435\u0442\u0440\u043E\u0432\u0441\u043A:"\u0414\u043D\u0435\u043F\u0440",\u0437\u0430\u043F\u043E\u0440\u043E\u0436\u044C\u0435:"\u0417\u0430\u043F\u043E\u0440\u043E\u0436\u044C\u0435",\u0437\u0430\u043F\u043E\u0440\u0456\u0436\u0436\u044F:"\u0417\u0430\u043F\u043E\u0440\u043E\u0436\u044C\u0435",\u0432\u0438\u043D\u043D\u0438\u0446\u0430:"\u0412\u0438\u043D\u043D\u0438\u0446\u0430",\u0432\u0456\u043D\u043D\u0438\u0446\u044F:"\u0412\u0438\u043D\u043D\u0438\u0446\u0430",\u043F\u043E\u043B\u0442\u0430\u0432\u0430:"\u041F\u043E\u043B\u0442\u0430\u0432\u0430",\u0447\u0435\u0440\u043D\u0438\u0433\u043E\u0432:"\u0427\u0435\u0440\u043D\u0438\u0433\u043E\u0432",\u0447\u0435\u0440\u043D\u0456\u0433\u0456\u0432:"\u0427\u0435\u0440\u043D\u0438\u0433\u043E\u0432",\u0441\u0443\u043C\u044B:"\u0421\u0443\u043C\u044B","\u0438\u0432\u0430\u043D\u043E-\u0444\u0440\u0430\u043D\u043A\u043E\u0432\u0441\u043A":"\u0418\u0432\u0430\u043D\u043E-\u0424\u0440\u0430\u043D\u043A\u043E\u0432\u0441\u043A","\u0456\u0432\u0430\u043D\u043E-\u0444\u0440\u0430\u043D\u043A\u0456\u0432\u0441\u044C\u043A":"\u0418\u0432\u0430\u043D\u043E-\u0424\u0440\u0430\u043D\u043A\u043E\u0432\u0441\u043A",\u043B\u0443\u0446\u043A:"\u041B\u0443\u0446\u043A",\u043B\u0443\u0446\u044C\u043A:"\u041B\u0443\u0446\u043A",\u0440\u043E\u0432\u043D\u043E:"\u0420\u043E\u0432\u043D\u043E",\u0440\u0456\u0432\u043D\u0435:"\u0420\u043E\u0432\u043D\u043E",\u0442\u0435\u0440\u043D\u043E\u043F\u043E\u043B\u044C:"\u0422\u0435\u0440\u043D\u043E\u043F\u043E\u043B\u044C",\u0442\u0435\u0440\u043D\u043E\u043F\u0456\u043B\u044C:"\u0422\u0435\u0440\u043D\u043E\u043F\u043E\u043B\u044C",\u0445\u043C\u0435\u043B\u044C\u043D\u0438\u0446\u043A\u0438\u0439:"\u0425\u043C\u0435\u043B\u044C\u043D\u0438\u0446\u043A\u0438\u0439",\u0445\u043C\u0435\u043B\u044C\u043D\u0438\u0446\u044C\u043A\u0438\u0439:"\u0425\u043C\u0435\u043B\u044C\u043D\u0438\u0446\u043A\u0438\u0439",\u0447\u0435\u0440\u043D\u043E\u0432\u0446\u044B:"\u0427\u0435\u0440\u043D\u043E\u0432\u0446\u044B",\u0447\u0435\u0440\u043D\u0456\u0432\u0446\u0456:"\u0427\u0435\u0440\u043D\u043E\u0432\u0446\u044B",\u0443\u0436\u0433\u043E\u0440\u043E\u0434:"\u0423\u0436\u0433\u043E\u0440\u043E\u0434",\u043C\u0443\u043A\u0430\u0447\u0435\u0432\u043E:"\u041C\u0443\u043A\u0430\u0447\u0435\u0432\u043E",\u043C\u0443\u043A\u0430\u0447\u0435\u0432\u0435:"\u041C\u0443\u043A\u0430\u0447\u0435\u0432\u043E",\u043D\u0438\u043A\u043E\u043B\u0430\u0435\u0432:"\u041D\u0438\u043A\u043E\u043B\u0430\u0435\u0432",\u043C\u0438\u043A\u043E\u043B\u0430\u0457\u0432:"\u041D\u0438\u043A\u043E\u043B\u0430\u0435\u0432",\u0445\u0435\u0440\u0441\u043E\u043D:"\u0425\u0435\u0440\u0441\u043E\u043D","\u043A\u0440\u0438\u0432\u043E\u0439 \u0440\u043E\u0433":"\u041A\u0440\u0438\u0432\u043E\u0439 \u0420\u043E\u0433","\u043A\u0440\u0438\u0432\u0438\u0439 \u0440\u0456\u0433":"\u041A\u0440\u0438\u0432\u043E\u0439 \u0420\u043E\u0433",\u043C\u0430\u0440\u0438\u0443\u043F\u043E\u043B\u044C:"\u041C\u0430\u0440\u0438\u0443\u043F\u043E\u043B\u044C",\u043C\u0430\u0440\u0456\u0443\u043F\u043E\u043B\u044C:"\u041C\u0430\u0440\u0438\u0443\u043F\u043E\u043B\u044C",\u0431\u0435\u0440\u043B\u0438\u043D:"\u0411\u0435\u0440\u043B\u0438\u043D",\u0431\u0435\u0440\u043B\u0456\u043D:"\u0411\u0435\u0440\u043B\u0438\u043D",\u043C\u044E\u043D\u0445\u0435\u043D:"\u041C\u044E\u043D\u0445\u0435\u043D",\u0433\u0430\u043C\u0431\u0443\u0440\u0433:"\u0413\u0430\u043C\u0431\u0443\u0440\u0433",\u0444\u0440\u0430\u043D\u043A\u0444\u0443\u0440\u0442:"\u0424\u0440\u0430\u043D\u043A\u0444\u0443\u0440\u0442",\u0433\u0430\u043D\u043D\u043E\u0432\u0435\u0440:"\u0413\u0430\u043D\u043D\u043E\u0432\u0435\u0440",\u0434\u0440\u0435\u0437\u0434\u0435\u043D:"\u0414\u0440\u0435\u0437\u0434\u0435\u043D",\u0434\u0440\u0435\u0437\u0434\u043D:"\u0414\u0440\u0435\u0437\u0434\u0435\u043D",\u043A\u0451\u043B\u044C\u043D:"\u041A\u0451\u043B\u044C\u043D",\u043A\u0435\u043B\u044C\u043D:"\u041A\u0451\u043B\u044C\u043D",\u0432\u0435\u043D\u0430:"\u0412\u0435\u043D\u0430",\u0432\u0456\u0434\u0435\u043D:"\u0412\u0435\u043D\u0430",\u043F\u0440\u0430\u0433\u0430:"\u041F\u0440\u0430\u0433\u0430",\u0431\u0440\u0430\u0442\u0438\u0441\u043B\u0430\u0432\u0430:"\u0411\u0440\u0430\u0442\u0438\u0441\u043B\u0430\u0432\u0430",\u0431\u0443\u0434\u0430\u043F\u0435\u0448\u0442:"\u0411\u0443\u0434\u0430\u043F\u0435\u0448\u0442",\u0430\u043C\u0441\u0442\u0435\u0440\u0434\u0430\u043C:"\u0410\u043C\u0441\u0442\u0435\u0440\u0434\u0430\u043C",\u0431\u0440\u044E\u0441\u0441\u0435\u043B\u044C:"\u0411\u0440\u044E\u0441\u0441\u0435\u043B\u044C",\u043F\u0430\u0440\u0438\u0436:"\u041F\u0430\u0440\u0438\u0436",\u043B\u043E\u043D\u0434\u043E\u043D:"\u041B\u043E\u043D\u0434\u043E\u043D",\u043C\u0438\u043B\u0430\u043D:"\u041C\u0438\u043B\u0430\u043D",\u0440\u0438\u043C:"\u0420\u0438\u043C",\u043C\u0430\u0434\u0440\u0438\u0434:"\u041C\u0430\u0434\u0440\u0438\u0434",\u0431\u0430\u0440\u0441\u0435\u043B\u043E\u043D\u0430:"\u0411\u0430\u0440\u0441\u0435\u043B\u043E\u043D\u0430",\u0432\u0438\u043B\u044C\u043D\u044E\u0441:"\u0412\u0438\u043B\u044C\u043D\u044E\u0441",\u043A\u0430\u0443\u043D\u0430\u0441:"\u041A\u0430\u0443\u043D\u0430\u0441",\u043A\u043B\u0430\u0439\u043F\u0435\u0434\u0430:"\u041A\u043B\u0430\u0439\u043F\u0435\u0434\u0430",\u043A\u043Ba\u0439\u043F\u0435\u0434\u0430:"\u041A\u043B\u0430\u0439\u043F\u0435\u0434\u0430",\u0440\u0438\u0433\u0430:"\u0420\u0438\u0433\u0430",\u0442\u0430\u043B\u043B\u0438\u043D:"\u0422\u0430\u043B\u043B\u0438\u043D",\u0442\u0430\u043B\u043B\u0438\u043D\u043D:"\u0422\u0430\u043B\u043B\u0438\u043D",\u043C\u0438\u043D\u0441\u043A:"\u041C\u0438\u043D\u0441\u043A",\u043C\u0456\u043D\u0441\u043A:"\u041C\u0438\u043D\u0441\u043A",\u0431\u0440\u0435\u0441\u0442:"\u0411\u0440\u0435\u0441\u0442",\u0433\u0440\u043E\u0434\u043D\u043E:"\u0413\u0440\u043E\u0434\u043D\u043E",\u0433\u043E\u043C\u0435\u043B\u044C:"\u0413\u043E\u043C\u0435\u043B\u044C",\u0432\u0438\u0442\u0435\u0431\u0441\u043A:"\u0412\u0438\u0442\u0435\u0431\u0441\u043A",\u043C\u043E\u0433\u0438\u043B\u0435\u0432:"\u041C\u043E\u0433\u0438\u043B\u0451\u0432",\u043C\u043E\u0433\u0438\u043B\u0451\u0432:"\u041C\u043E\u0433\u0438\u043B\u0451\u0432",\u0431\u043E\u0431\u0440\u0443\u0439\u0441\u043A:"\u0411\u043E\u0431\u0440\u0443\u0439\u0441\u043A",\u0431\u0430\u0440\u0430\u043D\u043E\u0432\u0438\u0447\u0438:"\u0411\u0430\u0440\u0430\u043D\u043E\u0432\u0438\u0447\u0438",\u043F\u0438\u043D\u0441\u043A:"\u041F\u0438\u043D\u0441\u043A",\u0436\u0438\u0442\u043E\u043C\u0438\u0440:"\u0416\u0438\u0442\u043E\u043C\u0438\u0440",\u0447\u0435\u0440\u043A\u0430\u0441\u0441\u044B:"\u0427\u0435\u0440\u043A\u0430\u0441\u0441\u044B",\u043A\u0430\u043B\u0438\u043D\u0438\u043D\u0433\u0440\u0430\u0434:"\u041A\u0430\u043B\u0438\u043D\u0438\u043D\u0433\u0440\u0430\u0434",\u043A\u0435\u043D\u0438\u0433\u0441\u0431\u0435\u0440\u0433:"\u041A\u0430\u043B\u0438\u043D\u0438\u043D\u0433\u0440\u0430\u0434",\u043C\u043E\u0441\u043A\u0432\u0430:"\u041C\u043E\u0441\u043A\u0432\u0430","\u0441\u0430\u043D\u043A\u0442-\u043F\u0435\u0442\u0435\u0440\u0431\u0443\u0440\u0433":"\u0421\u0430\u043D\u043A\u0442-\u041F\u0435\u0442\u0435\u0440\u0431\u0443\u0440\u0433",\u043F\u0438\u0442\u0435\u0440:"\u0421\u0430\u043D\u043A\u0442-\u041F\u0435\u0442\u0435\u0440\u0431\u0443\u0440\u0433",\u043F\u0435\u0442\u0435\u0440\u0431\u0443\u0440\u0433:"\u0421\u0430\u043D\u043A\u0442-\u041F\u0435\u0442\u0435\u0440\u0431\u0443\u0440\u0433",\u0432\u0430\u0440\u0430\u0448\u0430\u0432\u0430:"\u0412\u0430\u0440\u0448\u0430\u0432\u0430",\u043A\u0440\u0430\u043A\u043E\u0432\u043E\u0435:"\u041A\u0440\u0430\u043A\u043E\u0432",\u0432\u0440\u043E\u0446\u043B\u0430\u0432\u044C:"\u0412\u0440\u043E\u0446\u043B\u0430\u0432",warsawa:"\u0412\u0430\u0440\u0448\u0430\u0432\u0430",warshawa:"\u0412\u0430\u0440\u0448\u0430\u0432\u0430",warshava:"\u0412\u0430\u0440\u0448\u0430\u0432\u0430",krakov:"\u041A\u0440\u0430\u043A\u043E\u0432",krakiv:"\u041A\u0440\u0430\u043A\u043E\u0432",lwow:"\u041B\u044C\u0432\u043E\u0432",lw\u00F3w:"\u041B\u044C\u0432\u043E\u0432",warszawa:"\u0412\u0430\u0440\u0448\u0430\u0432\u0430",warsaw:"\u0412\u0430\u0440\u0448\u0430\u0432\u0430",krakow:"\u041A\u0440\u0430\u043A\u043E\u0432",krak\u00F3w:"\u041A\u0440\u0430\u043A\u043E\u0432",wroclaw:"\u0412\u0440\u043E\u0446\u043B\u0430\u0432",wroc\u0142aw:"\u0412\u0440\u043E\u0446\u043B\u0430\u0432",gdansk:"\u0413\u0434\u0430\u043D\u044C\u0441\u043A",gda\u0144sk:"\u0413\u0434\u0430\u043D\u044C\u0441\u043A",poznan:"\u041F\u043E\u0437\u043D\u0430\u043D\u044C",pozna\u0144:"\u041F\u043E\u0437\u043D\u0430\u043D\u044C",lodz:"\u041B\u043E\u0434\u0437\u044C",\u0142\u00F3d\u017A:"\u041B\u043E\u0434\u0437\u044C",katowice:"\u041A\u0430\u0442\u043E\u0432\u0438\u0446\u0435",lublin:"\u041B\u044E\u0431\u043B\u0438\u043D",bialystok:"\u0411\u0435\u043B\u043E\u0441\u0442\u043E\u043A",szczecin:"\u0429\u0435\u0446\u0438\u043D",bydgoszcz:"\u0411\u044B\u0434\u0433\u043E\u0449",torun:"\u0422\u043E\u0440\u0443\u043D\u044C",toru\u0144:"\u0422\u043E\u0440\u0443\u043D\u044C",olsztyn:"\u041E\u043B\u044C\u0448\u0442\u044B\u043D",rzeszow:"\u0416\u0435\u0448\u0443\u0432",czestochowa:"\u0427\u0435\u043D\u0441\u0442\u043E\u0445\u043E\u0432\u0430",gdynia:"\u0413\u0434\u044B\u043D\u044F",sosnowiec:"\u0421\u043E\u0441\u043D\u043E\u0432\u0435\u0446",gliwice:"\u0413\u043B\u0438\u0432\u0438\u0446\u0435",kyiv:"\u041A\u0438\u0435\u0432",kiev:"\u041A\u0438\u0435\u0432",lviv:"\u041B\u044C\u0432\u043E\u0432",lvov:"\u041B\u044C\u0432\u043E\u0432",kharkiv:"\u0425\u0430\u0440\u044C\u043A\u043E\u0432",kharkov:"\u0425\u0430\u0440\u044C\u043A\u043E\u0432",odessa:"\u041E\u0434\u0435\u0441\u0441\u0430",odesa:"\u041E\u0434\u0435\u0441\u0441\u0430",dnipro:"\u0414\u043D\u0435\u043F\u0440",zaporizhzhia:"\u0417\u0430\u043F\u043E\u0440\u043E\u0436\u044C\u0435",zhytomyr:"\u0416\u0438\u0442\u043E\u043C\u0438\u0440",vinnytsia:"\u0412\u0438\u043D\u043D\u0438\u0446\u0430","ivano-frankivsk":"\u0418\u0432\u0430\u043D\u043E-\u0424\u0440\u0430\u043D\u043A\u043E\u0432\u0441\u043A",ternopil:"\u0422\u0435\u0440\u043D\u043E\u043F\u043E\u043B\u044C",chernivtsi:"\u0427\u0435\u0440\u043D\u043E\u0432\u0446\u044B",uzhhorod:"\u0423\u0436\u0433\u043E\u0440\u043E\u0434",uzhorod:"\u0423\u0436\u0433\u043E\u0440\u043E\u0434",rivne:"\u0420\u043E\u0432\u043D\u043E",lutsk:"\u041B\u0443\u0446\u043A",khmelnytskyi:"\u0425\u043C\u0435\u043B\u044C\u043D\u0438\u0446\u043A\u0438\u0439",mykolaiv:"\u041D\u0438\u043A\u043E\u043B\u0430\u0435\u0432",kherson:"\u0425\u0435\u0440\u0441\u043E\u043D",poltava:"\u041F\u043E\u043B\u0442\u0430\u0432\u0430",cherkasy:"\u0427\u0435\u0440\u043A\u0430\u0441\u0441\u044B",chernihiv:"\u0427\u0435\u0440\u043D\u0438\u0433\u043E\u0432",sumy:"\u0421\u0443\u043C\u044B",mukachevo:"\u041C\u0443\u043A\u0430\u0447\u0435\u0432\u043E",berlin:"\u0411\u0435\u0440\u043B\u0438\u043D",munich:"\u041C\u044E\u043D\u0445\u0435\u043D",munchen:"\u041C\u044E\u043D\u0445\u0435\u043D",hamburg:"\u0413\u0430\u043C\u0431\u0443\u0440\u0433",frankfurt:"\u0424\u0440\u0430\u043D\u043A\u0444\u0443\u0440\u0442",hannover:"\u0413\u0430\u043D\u043D\u043E\u0432\u0435\u0440",dresden:"\u0414\u0440\u0435\u0437\u0434\u0435\u043D",koln:"\u041A\u0451\u043B\u044C\u043D",k\u00F6ln:"\u041A\u0451\u043B\u044C\u043D",bremen:"\u0411\u0440\u0435\u043C\u0435\u043D",stuttgart:"\u0428\u0442\u0443\u0442\u0433\u0430\u0440\u0442",dusseldorf:"\u0414\u044E\u0441\u0441\u0435\u043B\u044C\u0434\u043E\u0440\u0444",dortmund:"\u0414\u043E\u0440\u0442\u043C\u0443\u043D\u0434",leipzig:"\u041B\u0435\u0439\u043F\u0446\u0438\u0433",wien:"\u0412\u0435\u043D\u0430",prague:"\u041F\u0440\u0430\u0433\u0430",praha:"\u041F\u0440\u0430\u0433\u0430",brno:"\u0411\u0440\u043D\u043E",bratislava:"\u0411\u0440\u0430\u0442\u0438\u0441\u043B\u0430\u0432\u0430",budapest:"\u0411\u0443\u0434\u0430\u043F\u0435\u0448\u0442",vilnius:"\u0412\u0438\u043B\u044C\u043D\u044E\u0441",kaunas:"\u041A\u0430\u0443\u043D\u0430\u0441",klaipeda:"\u041A\u043B\u0430\u0439\u043F\u0435\u0434\u0430",riga:"\u0420\u0438\u0433\u0430",tallinn:"\u0422\u0430\u043B\u043B\u0438\u043D",amsterdam:"\u0410\u043C\u0441\u0442\u0435\u0440\u0434\u0430\u043C",brussels:"\u0411\u0440\u044E\u0441\u0441\u0435\u043B\u044C",paris:"\u041F\u0430\u0440\u0438\u0436",london:"\u041B\u043E\u043D\u0434\u043E\u043D",milan:"\u041C\u0438\u043B\u0430\u043D",milano:"\u041C\u0438\u043B\u0430\u043D",rome:"\u0420\u0438\u043C",roma:"\u0420\u0438\u043C",madrid:"\u041C\u0430\u0434\u0440\u0438\u0434",barcelona:"\u0411\u0430\u0440\u0441\u0435\u043B\u043E\u043D\u0430"},L=Object.keys(h).sort((t,e)=>e.length-t.length),M=[/возьму/i,/могу взять/i,/взять посылк/i,/могу передать/i,/могу забрать/i,/везу/i,/везём/i,/везем/i,/перевезу/i,/доставлю/i,/заберу/i,/отвезу/i,/повезу/i,/отвожу/i,/попутчик/i,/есть\s+мест\w*/i,/место есть/i,/мест\w*\s+свободн/i,/свободн\w* мест\w*/i,/погрузк/i,/загруж\w+\s*(?:сам|машину)/i,/выезжаю/i,/отправляю(?:сь|ю)\s+рейс/i,/еду/i,/поеду/i,/беру/i],Y=[/везёт/i,/везет/i,/отвез/i,/попутк/i,/попутно/i,/доставк/i,/перевозк/i,/перевоз/i,/перевезти/i,/груз/i,/рейс/i,/маршрут/i,/бронь/i,/бронир/i,/выезд\w*/i,/заряд/i,/отвоз/i],_=[/нужно передать/i,/надо передать/i,/нужн\w* (?:передать|отправить|забрать)/i,/необходим\w*\s*(?:передать|отправить|забрать)/i,/осталось передать/i,/ищу/i,/ищ[уе] (?:водителя|курьера|попутку)/i,/нужн\w* (?:водитель|курьер)/i,/кто[\s-]*(?:то|нибудь|либо)/i,/есть\s+кто/i,/может\s+кто/i,/кто-нибудь/i,/кто\s+(?:может|сможет|возьм[её]т|перевез[её]т|привез[её]т|едет|поедет|летит|вез[её]т|возит|занимает|помож[её]т|помогает|переда[её]т|отвез|подвез|довез|забер|доставит|отправит|приедет)/i,/(?:занимает|возит|возмёт|берет|берёт|доставляет|помогает)\s+(?:ли\s+)?кто/i,/занимает(?:есь|ся)\s+(?:ли\s+)?(?:перевоз\w*|доставк\w*|посылк\w*|передач\w*|груз\w*)/i,/(?:кто|куда|где)\s+(?:обратиться|писать|кидать)/i,/помогите/i,/помощь с передачей/i,/подскаж/i,/не\s+подскаж/i,/посоветуй/i,/передайте/i,/прошу/i,/хочу (?:передать|отправить|переслать)/i,/нужно (?:доставить|отправить|переслать)/i,/надо (?:доставить|отправить|переслать)/i],O=[/передать посылк/i,/посылк\w* (?:передать|доставить)/i,/привезти/i,/подвезти/i,/переслать/i,/помож[её]т/i,/кто передаёт/i,/кто передает/i,/перевоз\w*\s+посылок/i,/доставк\w*\s+посылок/i],D=2,P=1;function d(t,e,n){let r=0;for(let i of e)i.test(t)&&(r+=D);for(let i of n)i.test(t)&&(r+=P);return r}var N={\u043F\u043E\u043D\u0435\u0434\u0435\u043B\u044C\u043D\u0438\u043A:1,\u0432\u0442\u043E\u0440\u043D\u0438\u043A:2,\u0441\u0440\u0435\u0434\u0430:3,\u0441\u0440\u0435\u0434\u0443:3,\u0447\u0435\u0442\u0432\u0435\u0440\u0433:4,\u043F\u044F\u0442\u043D\u0438\u0446\u0430:5,\u043F\u044F\u0442\u043D\u0438\u0446\u0443:5,\u0441\u0443\u0431\u0431\u043E\u0442\u0430:6,\u0441\u0443\u0431\u0431\u043E\u0442\u0443:6,\u0432\u043E\u0441\u043A\u0440\u0435\u0441\u0435\u043D\u044C\u0435:0,\u0432\u043E\u0441\u043A\u0440\u0435\u0441\u0435\u043D\u044C\u044F:0},G=[["\u044F\u043D\u0432\u0430\u0440",1],["\u0444\u0435\u0432\u0440\u0430\u043B",2],["\u043C\u0430\u0440\u0442",3],["\u0430\u043F\u0440\u0435\u043B",4],["\u043C\u0430[\u0439\u0435\u044F]",5],["\u0438\u044E\u043D",6],["\u0438\u044E\u043B",7],["\u0430\u0432\u0433\u0443\u0441\u0442",8],["\u0441\u0435\u043D\u0442\u044F\u0431\u0440",9],["\u043E\u043A\u0442\u044F\u0431\u0440",10],["\u043D\u043E\u044F\u0431\u0440",11],["\u0434\u0435\u043A\u0430\u0431\u0440",12],["\u0441\u0456\u0447\u0435\u043D",1],["\u043B\u044E\u0442",2],["\u0431\u0435\u0440\u0435\u0437\u043D",3],["\u043A\u0432\u0456\u0442\u043D",4],["\u0442\u0440\u0430\u0432\u043D",5],["\u0447\u0435\u0440\u0432",6],["\u043B\u0438\u043F",7],["\u0441\u0435\u0440\u043F",8],["\u0432\u0435\u0440\u0435\u0441\u043D",9],["\u0436\u043E\u0432\u0442\u043D",10],["\u043B\u0438\u0441\u0442\u043E\u043F\u0430\u0434",11],["\u0433\u0440\u0443\u0434\u043D",12]];var u="\u0430-\u044F\u0451a-z";function w(t){let e=[],n=t.toLowerCase().replace(/ё/g,"\u0435");for(let r of L){let i=r.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),s=new RegExp(`(?<![${u}0-9])${i}[${u}]?(?![${u}0-9])`,"g"),a;for(;(a=s.exec(n))!==null;)e.push({city:h[r],index:a.index,end:a.index+a[0].length})}return e.sort((r,i)=>r.index-i.index)}var W=/^(?:\s*(?:->|=>|>>|→|⇒|—|–|−|-|до|в|на|из|с|от)\s*(?:[а-яёa-z]{0,12}\s*)?)$/;function z(t){let e=t.toLowerCase().replace(/ё/g,"\u0435").replace(/[^\p{L}\- ]/gu," ").replace(/\s+/g," ").trim();if(!e)return t.trim();let n=h[e];if(n)return n;let r=w(e);return r.length>0?r[0].city:e.split(" ").map(s=>s.length>0?s[0].toUpperCase()+s.slice(1):s).join(" ").slice(0,60)}function H(t){let e=w(t);for(let n=0;n<e.length;n++)for(let r=n+1;r<e.length;r++){let i=e[n],s=e[r];if(s.index<i.end||i.city===s.city)continue;let a=t.slice(i.end,s.index);if(a.length>40)continue;let o=a.trim();if(o===""||W.test(o))return{from:i.city,to:s.city}}return null}function m(t,e){return new RegExp(`(^|[^${u}0-9])${e}([^${u}0-9]|$)`).test(t)}function U(t,e=new Date){let n=t.toLowerCase().replace(/ё/g,"\u0435");if(m(n,"\u043F\u043E\u0441\u043B\u0435\u0437\u0430\u0432\u0442\u0440\u0430"))return l(k(e,2));if(m(n,"\u0437\u0430\u0432\u0442\u0440\u0430"))return l(k(e,1));if(m(n,"\u0441\u0435\u0433\u043E\u0434\u043D\u044F"))return l(e);for(let[i,s]of Object.entries(N))if(new RegExp(`(^|[^${u}0-9])${i}([^${u}0-9]|$)`).test(n)){let o=new Date(e),c=(s-o.getDay()+7)%7||7;return o.setDate(o.getDate()+c),l(o)}let r=n.match(/(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/);if(r){let i=parseInt(r[1],10),s=parseInt(r[2],10);if(i>=1&&i<=31&&s>=1&&s<=12){let a=r[3]?parseInt(r[3],10):e.getFullYear();a<100&&(a+=2e3);let o=new Date(a,s-1,i);if(o.getDate()===i&&o.getMonth()===s-1)return!r[3]&&o<b(e)&&o.setFullYear(o.getFullYear()+1),l(o)}}for(let[i,s]of G){let a=new RegExp(`(\\d{1,2})[^\\d\u0430-\u044F\u0451]{0,3}${i}`),o=n.match(a);if(o){let c=parseInt(o[1],10);if(c>=1&&c<=31){let f=new Date(e.getFullYear(),s-1,c);if(f.getDate()===c)return f<b(e)&&f.setFullYear(f.getFullYear()+1),l(f)}}}return null}function k(t,e){let n=new Date(t);return n.setDate(n.getDate()+e),n}function b(t){return new Date(t.getFullYear(),t.getMonth(),t.getDate())}function l(t){let e=t.getFullYear(),n=String(t.getMonth()+1).padStart(2,"0"),r=String(t.getDate()).padStart(2,"0");return`${e}-${n}-${r}`}function K(t){let e=t.match(/(?:до\s*)?(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:кг|kg|кило|килограмм)/i);if(!e)return null;let n=parseFloat(e[1].replace(",","."));return!Number.isFinite(n)||n<=0||n>1e3?null:Math.round(n*100)/100}function j(t){let e=t.match(/(\d{1,3}(?:\s?\d{3})*(?:[.,]\d{1,2})?)\s*(зл|злот|zl|zł|pln|евро|eur|€|\$|грн|грив|uah|руб|₽|р\.)/i);if(!e)return null;let n=e[1].trim(),r=e[2].trim().toUpperCase();return`${n} ${r==="\u0417\u041B"||r==="Z\u0141"||r==="ZL"||r==="PLN"?"z\u0142":r==="\u0415\u0412\u0420\u041E"||r==="EUR"||r==="\u20AC"?"\u20AC":r==="$"?"$":r==="\u0413\u0420\u041D"||r==="\u0413\u0420\u0418\u0412"||r==="UAH"?"\u0433\u0440\u043D":r==="\u0420\u0423\u0411"||r==="RUB"||r==="\u20BD"||r==="\u0420."?"\u20BD":""}`.trim()}function Z(t){let e=t.match(/\+?[\d][\d\s\-()]{8,17}[\d]/);if(!e)return null;let n=e[0].replace(/[^\d+]/g,"");return n.replace(/\D/g,"").length<9||n.replace(/\D/g,"").length>16?null:e[0].trim()}function Q(t){let e=t.match(/(?:t\.me\/|https?:\/\/t\.me\/|@)([a-zA-Z0-9_]{4,32})/);return e?`@${e[1]}`:null}function g(t){let e=d(t,M,[]),n=d(t,_,[]);return{offerStrong:e,requestStrong:n,offer:e+d(t,[],Y),request:n+d(t,[],O)}}function S(t,e){let{offer:n,request:r}=t;return n===r?n===0?null:/\?/.test(e)||/передать/i.test(e)?"request":"offer":n>r?"offer":"request"}function B(t){return S(g(t),t)}function J(t){let e=typeof t=="string"?g(t):t;if(e.offer===0&&e.request===0)return!0;if(e.offer===e.request)return!1;let n=e.offer>e.request?"offer":"request";return n==="offer"&&e.offerStrong>0&&e.requestStrong===0||n==="request"&&e.requestStrong>0&&e.offerStrong===0?!0:Math.abs(e.offer-e.request)>=D}function R(t){return/обратно|туда[-\u2013 ]?обратно/i.test(t)?!0:(t.match(/(?<!\d)\d{1,2}[-\u2013.]\d{1,2}(?:\.\d{1,2})?(?!\d)(?!\s*(?:кг|kg|тонн))/gi)??[]).length>=2}function y(t,e=new Date){let n=H(t),r=g(t),i=S(r,t)??(n?"offer":null),s=!J(r);return{intent:i,fromCity:n?.from??null,toCity:n?.to??null,departureDate:U(t,e),weightKg:K(t),price:j(t),telegram:Q(t),phone:Z(t),confidence:n&&i?s?.6:.9:n?.7:i?.5:0}}var V=[/пассажир/i,/(?:довез|подвез|подброс|доехать|проехать)/i,/ищ[уе]\s+попутк/i],E=/посылк|бандерол|переда|груз|вещи|коробк|документ|печат|лекарств|медикамент|запечат/i;function I(t){return V.some(e=>e.test(t))?!E.test(t):!1}var X=/(?:\bкто\b|ищ[уи]|надо|нужн|можно|переда[йът]|отвез|забер|привез|подвез|довез|мест[ао]?\b)/i;function $(t){return B(t)!==null||E.test(t)||w(t).length>0?!0:X.test(t)}function v(t,e=new Date){let n=y(t,e);return n.intent!==null&&(n.fromCity!==null||n.toCity!==null)}return F(ee);})();


/* ---- extension/core.cjs ---- */
/**
 * Ядро сборщика для Telegram Web — ЧИСТАЯ логика, без DOM и без fetch.
 *
 * Файл намеренно в формате UMD и с расширением .cjs:
 *   - в расширении/юзерскрипте подключается обычным <script> (content scripts
 *     в MV3 не умеют ES-модули) и кладёт API в globalThis.PoputkaCore;
 *   - в тестах импортируется как CommonJS (tests/extension-core.test.ts).
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
  const COLLECTOR = 'tg-web-ext/1.0.0';

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
  function normalizeWhitelistEntry(raw) {
    const value = String(raw || '').trim();
    if (!value) return null;
    const link = /t\.me\/(?:s\/)?@?([A-Za-z][A-Za-z0-9_]{3,31})/i.exec(value);
    if (link) return { kind: 'username', value: link[1].toLowerCase() };
    const at = /^@([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(value);
    if (at) return { kind: 'username', value: at[1].toLowerCase() };
    return { kind: 'title', value: squashTitle(value) };
  }

  function normalizeWhitelist(list) {
    return (list || []).map(normalizeWhitelistEntry).filter(Boolean);
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
    const title = squashTitle(chat && chat.title);
    const username = String((chat && chat.username) || '').toLowerCase();
    for (const e of entries) {
      if (e.kind === 'username') {
        if (username && username === e.value) return true;
        // в названии чата иногда пишут юзернейм — считаем совпадением
        if (title && title.includes(e.value)) return true;
      } else if (title && (title === e.value || title.includes(e.value) || e.value.includes(title))) {
        return true;
      }
    }
    return false;
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
    const messageId = Number.isInteger(raw.messageId) && raw.messageId > 0
      ? raw.messageId
      : syntheticMessageId(chatId, text, dateMs);
    return {
      chatId,
      messageId,
      text: text.slice(0, 4000),
      chatTitle: chat.title ? String(chat.title).slice(0, 120) : null,
      // публичная ссылка — только когда знаем юзернейм (приватные не публикуем)
      chatUrl: chat.username ? 'https://t.me/' + String(chat.username).replace(/^@/, '') : null,
      // unix-секунды, как в контракте
      date: dateMs ? Math.floor(dateMs / 1000) : null,
      authorName: raw.authorName ? String(raw.authorName).slice(0, 120) : null,
      authorUsername: raw.authorUsername ? String(raw.authorUsername).slice(0, 64) : null,
      dateMs,
      idSource: Number.isInteger(raw.messageId) && raw.messageId > 0 ? 'dom' : 'synthetic',
    };
  }

  /** Счётчики по ответу сервера: что добавляем в локальный лог и в статистику. */
  function summarizeResponse(body) {
    const out = { received: 0, created: 0, duplicate: 0, skipped: 0, invalid: 0, listings: 0, sentKeys: [] };
    if (!body || typeof body !== 'object') return out;
    const s = body.summary || {};
    out.received = Number(s.received || 0);
    out.created = Number(s.created || 0);
    out.duplicate = Number(s.duplicate || 0);
    out.skipped = Number(s.skipped || 0);
    out.invalid = Number(s.invalid || 0);
    out.listings = Number(s.listings || 0);
    for (const r of body.results || []) {
      if (!r || !r.chatId) continue;
      // duplicate/created/skipped — сообщение обработано, повторно слать не нужно
      if (r.status !== 'invalid' && r.messageId) out.sentKeys.push(sentKey(r.chatId, r.messageId));
    }
    return out;
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
  function diagnostic(report) {
    const r = report || {};
    const lines = [];
    lines.push('URL: ' + (r.url || '—'));
    lines.push('Чат: ' + (r.chat && r.chat.title ? r.chat.title : 'не определён') +
      (r.chat && r.chat.username ? ' (@' + r.chat.username + ')' : '') +
      ' → chatId ' + (r.chatKey || '—'));
    lines.push('В белом списке: ' + (r.whitelisted ? 'да' : 'нет'));
    lines.push('Сообщений прочитано: ' + (r.total || 0) + ' (стратегия: ' + (r.strategy || '—') + ')');
    lines.push('К отправке: ' + (r.toSend || 0) + ', уже отправлено: ' + (r.alreadySent || 0) +
      ', отсеяно детектом: ' + (r.filtered || 0));
    if (r.reasons) {
      const parts = Object.keys(r.reasons).map((k) => k + ' ' + r.reasons[k]);
      if (parts.length) lines.push('Причины отсева: ' + parts.join(', '));
    }
    if (r.unreadable) lines.push('⚠ НЕ МОГУ ПРОЧИТАТЬ СООБЩЕНИЯ: разметка Telegram Web изменилась или чат пуст.');
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
    normalizeWhitelist,
    normalizeWhitelistEntry,
    matchesWhitelist,
    squashTitle,
    chatKeyOf,
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


/* ---- extension/dom.cjs ---- */
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
 * Формат UMD/.cjs — как у core.cjs: подключается обычным <script> и
 * тестируется без браузера (tests/extension-core.test.ts).
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

    // URL клиента: /k/#@username, /a/#/im/p-1001234567890, /k/#-1001234567890
    const hash = String((location && location.hash) || '');
    const href = String((location && location.href) || '');
    const loc = hash + ' ' + href;
    const linkUser = /t\.me\/(?:s\/)?@?([A-Za-z][A-Za-z0-9_]{3,31})(?!\/?\d)/i.exec(loc);
    const hashUser = /#@([A-Za-z][A-Za-z0-9_]{3,31})(?![A-Za-z0-9_])/.exec(loc) ||
      /#\/(?:im\/)?@([A-Za-z][A-Za-z0-9_]{3,31})(?![A-Za-z0-9_])/.exec(loc);
    const peer = /[#/]p(-?\d{4,})(?!\d)/.exec(loc) || /#(-?\d{5,})(?!\d)/.exec(loc);

    return {
      title: title || null,
      username: (linkUser && linkUser[1]) || (hashUser && hashUser[1]) || (fromNode && fromNode[1]) || null,
      id: peer ? peer[1] : null,
    };
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
  function isReadable(doc) {
    const { nodes } = pickAll(doc, MESSAGE_CONTAINERS);
    return nodes.length > 0;
  }

  return {
    MESSAGE_CONTAINERS,
    TEXT_SELECTORS,
    AUTHOR_SELECTORS,
    DATE_SELECTORS,
    ID_ATTRS,
    CHAT_TITLE_SELECTORS,
    CHAT_USERNAME_SELECTORS,
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

  const core = (typeof PoputkaCore !== 'undefined') ? PoputkaCore : require('./core.cjs');
  const dom = (typeof PoputkaDom !== 'undefined') ? PoputkaDom : require('./dom.cjs');
  const parser = (typeof PoputkaParser !== 'undefined') ? PoputkaParser : null;

  const NS = 'poputchka';
  const store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
    ? core.chromeStore(NS)
    : core.localStore(NS);

  const state = {
    settings: core.withDefaults({}),
    counters: {},
    sentKeys: [],
    pending: [],          // найдено, но ждёт подтверждения (confirmMode)
    error: null,
    status: 'инициализация…',
    attempt: 0,
    backoffUntil: 0,
    timer: null,
    lastDiagnostic: null,
    unreadable: false,
  };

  /* ---------------------------------------------------------------- */
  /* Хранилище                                                         */
  /* ---------------------------------------------------------------- */

  async function loadState() {
    const saved = await store.read();
    state.settings = core.withDefaults(saved.settings);
    state.counters = saved.counters || {};
    state.sentKeys = Array.isArray(saved.sentKeys) ? saved.sentKeys : [];
  }

  async function persist() {
    await store.write({
      settings: state.settings,
      counters: state.counters,
      sentKeys: core.pruneSentLog(state.sentKeys),
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
        const sum = core.summarizeResponse(body);
        state.counters = core.mergeCounters(state.counters, {
          sent: batch.length, received: sum.received, created: sum.created,
          duplicate: sum.duplicate, skipped: sum.skipped, invalid: sum.invalid,
          listings: sum.listings, runs: 1, lastRunAt: new Date().toISOString(),
        });
        for (const key of sum.sentKeys) if (!state.sentKeys.includes(key)) state.sentKeys.push(key);
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
  /* Один проход чтения                                                */
  /* ---------------------------------------------------------------- */

  async function tick() {
    if (state.settings.paused) { state.status = 'пауза'; render(); return; }
    if (Date.now() < state.backoffUntil) {
      state.status = 'ждем: ' + (state.backoffUntil === Infinity ? 'остановлено' : Math.ceil((state.backoffUntil - Date.now()) / 1000) + ' с');
      render();
      return;
    }

    const chat = dom.readChatInfo(document, window.location);
    const chatKey = core.chatKeyOf(chat);
    const whitelisted = core.matchesWhitelist(chat, state.settings.whitelist);

    if (!chatKey || !whitelisted) {
      // всё, что не в белом списке, игнорируется ПОЛНОСТЬЮ — сообщения не читаем
      state.unreadable = false;
      state.status = chat.title
        ? `чат «${chat.title}» не в белом списке — пропускаем`
        : 'чат не определён (откройте диалог)';
      state.lastDiagnostic = { url: location.href, chat, chatKey, whitelisted, total: 0, toSend: 0 };
      render();
      return;
    }

    const harvested = dom.harvest(document, { limit: state.settings.maxPerChat, now: Date.now() });
    if (harvested.unreadable || harvested.messages.length === 0) {
      state.unreadable = true;
      state.error = 'Не могу прочитать сообщения: Telegram Web изменил разметку или чат пуст. ' +
        'Сбор paused, пока не починим селекторы (см. extension/dom.cjs).';
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
      if (!verdict.send) { reasons[verdict.reason] = (reasons[verdict.reason] || 0) + 1; continue; }
      if (!core.withinAge(m.dateMs, state.settings.maxAgeHours, Date.now())) { reasons.old = (reasons.old || 0) + 1; continue; }
      if (state.sentKeys.includes(core.sentKey(m.chatId, m.messageId))) { alreadySent++; continue; }
      if (state.pending.some((p) => p.chatId === m.chatId && p.messageId === m.messageId)) { alreadySent++; continue; }
      candidates.push(m);
    }

    const fresh = core.filterUnsent(candidates, state.sentKeys);
    state.counters = core.mergeCounters(state.counters, { found: harvested.messages.length });
    state.lastDiagnostic = {
      url: location.href, chat, chatKey, whitelisted: true,
      total: harvested.messages.length, strategy: harvested.strategy,
      toSend: fresh.length, alreadySent, filtered: harvested.messages.length - fresh.length - alreadySent,
      reasons, counts: harvested.counts,
    };

    if (!fresh.length) {
      state.status = `чат «${chat.title}»: прочитано ${harvested.messages.length}, нового нет`;
      await persist();
      render();
      return;
    }

    if (state.settings.confirmMode) {
      // режим «спрашивать подтверждение» (по умолчанию включён)
      state.pending = state.pending.concat(fresh);
      state.status = `найдено ${fresh.length} — подтвердите отправку`;
      await persist();
      render();
      return;
    }

    state.status = `найдено ${fresh.length} — отправляю`;
    render();
    await sendPending({ messages: fresh });
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
            ]),
          ]),
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

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      (async () => {
        if (!msg || !msg.type) return sendResponse({ ok: false });
        if (msg.type === 'pk:reload') { await reloadSettings(); return sendResponse({ ok: true, state: publicState() }); }
        if (msg.type === 'pk:state') return sendResponse({ ok: true, state: publicState() });
        if (msg.type === 'pk:diagnostic') { await tick(); return sendResponse({ ok: true, diagnostic: core.diagnostic(state.lastDiagnostic), raw: state.lastDiagnostic }); }
        if (msg.type === 'pk:pause') { state.settings.paused = !state.settings.paused; await persist(); render(); return sendResponse({ ok: true, state: publicState() }); }
        if (msg.type === 'pk:send') { await sendPending(); return sendResponse({ ok: true, state: publicState() }); }
        if (msg.type === 'pk:reset') {
          state.counters = {}; state.sentKeys = []; state.pending = []; state.error = null;
          await persist(); render(); return sendResponse({ ok: true, state: publicState() });
        }
        return sendResponse({ ok: false });
      })();
      return true; // ответ асинхронный
    });
  }

  function publicState() {
    return {
      settings: Object.assign({}, state.settings, { token: state.settings.token ? '***' : '' }),
      counters: state.counters,
      pending: state.pending.length,
      status: state.status,
      error: state.error,
      diagnostic: state.lastDiagnostic,
    };
  }

  (async function init() {
    await loadState();
    render();
    restartTimer();
    // первый проход — не сразу: даём клиенту дорисовать список сообщений
    setTimeout(() => { tick().catch(() => undefined); }, 4000);
    console.info('[попутка.] сборщик запущен: интервал', state.settings.intervalSec + 'с',
      parser ? '(детект на правилах parser.ts)' : '(детект по ключевым словам — бандл парсера не подключён)');
  })();
})();
