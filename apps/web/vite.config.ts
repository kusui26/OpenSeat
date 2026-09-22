/**
 * 画面の組み立て（開発プラン 9.2、9.3）。
 *
 * **成果物は 1 つのコンテナのまま。** ここで作った静的ファイルを `apps/server` が
 * 配る（ADR-0005）。別のホスティングに置かない。
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwind(),
    VitePWA({
      // **古い画面を配り続けない。** 実証実験の最中に直したものが、端末に
      // 残ったままになるのがいちばん困る（12.5）。
      registerType: 'autoUpdate',
      manifest: {
        name: 'OpenSeat',
        short_name: 'OpenSeat',
        description: 'フードコートの座席順番待ち',
        lang: 'ja',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#1f2937',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        // **API は絶対に溜め込まない。** 待ち時間も呼び出しも、古い答えを
        // 見せたら意味が無い。溜めるのは画面そのものだけ。
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    // 手元では、API だけをサーバへ回す。
    proxy: { '/api': 'http://127.0.0.1:8080' },
  },
  build: { outDir: 'dist', sourcemap: true },
});
