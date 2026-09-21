/**
 * 1 画面の HTML。
 *
 * **これは `apps/web` ではない。** 画面設計（10 章）も PWA も React も、この
 * スパイクの対象外である。**外から触れて、状態が変わったことが目で見えれば
 * それでよい。** 独自ドメインで開いたときに「ちゃんと動いている」と分かる
 * ことが、9.13 の通し確認に要るだけである。
 *
 * ビューは業務の判断をしない（CLAUDE.md 3.1）。**サーバから来た状態を描くだけ**で、
 * 期限の判定も権限の判定もここには無い。
 */

import type { Table, Ticket, VenueState } from '@openseat/core';
import { activeTickets, comparePriority } from '@openseat/core';

/** 画面に添える、この一式が何かの断り書き。 */
const NOTICE =
  'Phase 2 の 1 日スパイクです（開発プラン 9.13）。Hono + SQLite + Docker + Railway が通ることだけを確かめるためのもので、製品の画面ではありません。';

export interface PageModel {
  readonly state: VenueState;
  /** 記録に残っている入力の数。再起動で取り戻せたことが目で見える。 */
  readonly inputs: number;
  /** サーバが起きてからの秒数。 */
  readonly uptimeSec: number;
  readonly version: string;
}

export function renderPage(model: PageModel): string {
  const { state } = model;
  return [
    '<!doctype html>',
    '<html lang="ja"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>OpenSeat スパイク</title>',
    `<style>${STYLE}</style>`,
    '</head><body>',
    '<h1>OpenSeat — 1 日スパイク</h1>',
    `<p class="notice">${escape(NOTICE)}</p>`,
    statusLine(model),
    joinForm(),
    tableList(state),
    waitingList(state),
    `<script>${SCRIPT}</script>`,
    '</body></html>',
    '',
  ].join('\n');
}

function statusLine(model: PageModel): string {
  const cells: readonly string[] = [
    `施設 <b>${escape(model.state.venueId)}</b>`,
    `運用 <b>${model.state.operating ? '中' : '外'}</b>`,
    `受付 <b>${model.state.joinOpen ? '開' : '閉'}</b>`,
    `記録した入力 <b>${String(model.inputs)}</b>`,
    `起動から <b>${String(model.uptimeSec)}</b> 秒`,
    `版 <b>${escape(model.version)}</b>`,
  ];
  return `<p class="status">${cells.join('｜')}</p>`;
}

function joinForm(): string {
  return [
    '<h2>受付</h2>',
    '<form method="post" action="/join" class="row">',
    '<label>人数 <input type="number" name="partySize" value="2" min="1" max="6" required></label>',
    '<button type="submit">並ぶ</button>',
    '</form>',
  ].join('\n');
}

// ---- 席 ----

function tableList(state: VenueState): string {
  const rows: readonly string[] = state.tables.map((table) => tableRow(table, state));
  return ['<h2>席</h2>', '<ul class="tables">', ...rows, '</ul>'].join('\n');
}

function tableRow(table: Table, state: VenueState): string {
  const occupant: Ticket | undefined = state.tickets.find(
    (ticket) => ticket.id === table.occupantTicketId,
  );
  const who: string = occupant === undefined ? '—' : `${occupant.code}（${String(occupant.partySize)} 名）`;
  return [
    '<li>',
    `<span class="label">${escape(table.label)}</span>`,
    `<span class="cap">${String(table.capacity)} 名席</span>`,
    `<span class="state s-${escape(table.status)}">${escape(table.status)}</span>`,
    `<span class="who">${escape(who)}</span>`,
    tableActions(table, occupant),
    '</li>',
  ].join('');
}

/**
 * その席に出す操作。
 *
 * **これは手抜きである。** 7.8 の要点は「画面が出す操作と、コマンドが通る条件を
 * 食い違わせない」ことで、そのための関数（`resolveTableScan`）が `core` にある。
 * ここでは席の状態の名前だけで出し分けている。**本物は Phase 2 で、座席 QR の
 * 秘密パラメータと `resolveTableScan` を使って書く。**
 */
function tableActions(table: Table, occupant: Ticket | undefined): string {
  if (occupant === undefined) return '<span class="actions">—</span>';
  if (table.status === 'HELD') return button(`/tickets/${occupant.id}/check-in`, '着席', table.id);
  if (table.status === 'OCCUPIED') return button(`/tickets/${occupant.id}/check-out`, '退席', null);
  return '<span class="actions">—</span>';
}

function button(action: string, label: string, tableId: string | null): string {
  const hidden: string =
    tableId === null ? '' : `<input type="hidden" name="tableId" value="${escape(tableId)}">`;
  return `<form method="post" action="${escape(action)}" class="actions">${hidden}<button type="submit">${escape(label)}</button></form>`;
}

// ---- 待ち行列 ----

function waitingList(state: VenueState): string {
  const queued: readonly Ticket[] = activeTickets(state)
    .filter((ticket) => ticket.state === 'WAITING' || ticket.state === 'CALLED')
    .toSorted(comparePriority);
  if (queued.length === 0) return '<h2>待っている組</h2>\n<p class="empty">いません。</p>';
  const rows = queued.map(
    (ticket) =>
      `<li><span class="code">${escape(ticket.code)}</span><span class="cap">${String(ticket.partySize)} 名</span><span class="state s-${escape(ticket.state)}">${escape(ticket.state)}</span></li>`,
  );
  return ['<h2>待っている組</h2>', '<ul class="queue">', ...rows, '</ul>'].join('\n');
}

// ---- 決め打ちの部分 ----

function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * 画面を勝手に更新する。
 *
 * **これが `/events` を開きっぱなしにするので、Railway のプロキシが長い接続を
 * 保てるかの確かめにもなる**（9.2 の WebSocket と同じ risk を、依存を足さずに見る）。
 */
const SCRIPT = `
  const source = new EventSource('/events');
  source.onmessage = () => { location.reload(); };
  source.onerror = () => { document.body.classList.add('disconnected'); };
`;

const STYLE = `
:root { color-scheme: light dark; --ink:#1a1a1a; --paper:#fff; --line:#d5d5d5; --muted:#666; --warn:#8a5a00; }
@media (prefers-color-scheme: dark) { :root { --ink:#eaeaea; --paper:#16181a; --line:#3a3d40; --muted:#a3a3a3; --warn:#d8b45a; } }
body { margin:0 auto; padding:24px 16px 64px; max-width:640px; background:var(--paper); color:var(--ink);
  font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif; line-height:1.7; }
body.disconnected { opacity:.6; }
h1 { font-size:1.4rem; margin:0 0 8px; }
h2 { font-size:1rem; margin:32px 0 8px; border-bottom:1px solid var(--line); padding-bottom:4px; }
.notice { color:var(--warn); font-size:.85rem; margin:0 0 16px; }
.status { color:var(--muted); font-size:.85rem; margin:0 0 8px; }
.row { display:flex; gap:12px; align-items:center; }
ul { list-style:none; padding:0; margin:0; }
li { display:flex; gap:12px; align-items:center; padding:8px 0; border-bottom:1px solid var(--line); }
.label,.code { font-weight:600; min-width:5.5em; }
.cap { color:var(--muted); min-width:5em; font-size:.9rem; }
.state { font-size:.75rem; letter-spacing:.04em; min-width:12em; }
.who { flex:1; color:var(--muted); font-size:.9rem; }
.actions { margin:0; }
.empty { color:var(--muted); }
button { font:inherit; padding:4px 12px; }
input { font:inherit; width:4em; padding:4px; }
`;
