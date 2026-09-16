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
  'extension/core.cjs',
  'extension/dom.cjs',
  'extension/content.js',
];

const header = `// ==UserScript==
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
 *   ${parts.join('\n *   ')}
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
