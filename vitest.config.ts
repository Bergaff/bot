import { defineConfig } from 'vitest/config';

/**
 * Vitest/Vite-конфиг.
 *
 * `node:sqlite` (локальная замена D1/KV для CLI и тестов) — встроенный модуль
 * Node, его нельзя пропускать через бандлер. Кода из src/ это не касается:
 * src/*.ts не импортирует ничего из node:* и переносится в Cloudflare Worker
 * проекта Bergaff/parcel без изменений.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    server: {
      deps: {
        external: [/^node:/],
      },
    },
  },
});
