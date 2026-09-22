#!/usr/bin/env node
/**
 * ホーム画面に置くアイコンを作る（開発プラン 6.6、9.2）。
 *
 * **iOS の Web Push は「ホーム画面に追加」した場合だけ届く**（6.6）。追加して
 * もらうには、まともなアイコンが要る。
 *
 *   node tools/make-icons.mjs
 *
 * **道具を増やさずに作る。** 画像の変換器を入れるほどの絵ではないので、PNG を
 * 直に組み立てる（`zlib` は Node に入っている）。**出力はコミットする** ——
 * 絵は生成物だが、作り直す機会がほとんど無く、無いと画面が壊れるためである。
 */

import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

/** 卓の色。`vite.config.ts` の `theme_color` と揃える。 */
const INK = [31, 41, 55];
const PAPER = [255, 255, 255];

/**
 * 1 枚ぶんの絵。
 *
 * 角を丸めた濃い四角に、白い「卓」と「2 つの席」を置く。**小さくしても
 * それと分かる形**にしてある（ホーム画面では 60px ほどで表示される）。
 */
function pixels(size) {
  const rows = [];
  const radius = size * 0.22;
  const table = { x0: size * 0.22, x1: size * 0.78, y0: size * 0.44, y1: size * 0.56 };
  const seat = size * 0.1;

  for (let y = 0; y < size; y += 1) {
    const row = [];
    for (let x = 0; x < size; x += 1) {
      row.push(colorAt({ x, y, size, radius, table, seat }));
    }
    rows.push(row);
  }
  return rows;
}

function colorAt({ x, y, size, radius, table, seat }) {
  if (outsideRounded(x, y, size, radius)) return [0, 0, 0, 0];
  const onTable = x >= table.x0 && x <= table.x1 && y >= table.y0 && y <= table.y1;
  const onSeat =
    near(x, y, size * 0.32, size * 0.3, seat) || near(x, y, size * 0.68, size * 0.3, seat);
  return onTable || onSeat ? [...PAPER, 255] : [...INK, 255];
}

/** 角の外か。四隅だけ円で落とす。 */
function outsideRounded(x, y, size, radius) {
  const dx = Math.max(radius - x, x - (size - radius), 0);
  const dy = Math.max(radius - y, y - (size - radius), 0);
  return dx * dx + dy * dy > radius * radius;
}

function near(x, y, cx, cy, r) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// ---- PNG に組み立てる ----

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const payload = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function png(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // 1 色 8 ビット
  header[9] = 6; // RGBA
  const raw = Buffer.concat(
    pixels(size).map((row) => Buffer.from([0, ...row.flat()])),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = join(process.cwd(), 'apps', 'web', 'public');
for (const size of [192, 512]) {
  const file = join(out, `icon-${String(size)}.png`);
  await writeFile(file, png(size));
  console.log(`${file} を書き出しました（${String(size)}×${String(size)}）`);
}
