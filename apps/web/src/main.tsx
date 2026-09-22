/**
 * 画面の入口。
 *
 * **ここだけがブラウザに触る。** ほかは受け取った値を描くだけである
 * （CLAUDE.md 3.1 の「ビューは業務判断をしない」）。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './app.tsx';
import './index.css';

/**
 * 取り直しの決まりごと。
 *
 * **画面を戻したら、すぐ取り直す。** 順番待ちは数秒で変わるので、古い数字を
 * 見せたままにしない。配信（PR 7）が入るまでは、これが唯一の追随手段である。
 */
const client = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: true, retry: 1, staleTime: 0 },
  },
});

const root = document.getElementById('root');
if (root === null) throw new Error('#root が見つかりません');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
