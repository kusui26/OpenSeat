/**
 * 決定的な擬似乱数。
 *
 * **同じシードから必ず同じ列が出ること**が、このファイルの唯一の要件である。
 * `Math.random()` は使わない（`scripts/check-architecture.mjs` が検査する）。
 * 再現できなければ、方針の比較（全体プラン 8.2）も、不具合の再現も成り立たない。
 *
 * ## なぜ「流れ」を分けるのか
 *
 * 8.2 は同じ負荷に対して方針を取り替えて比べる。このとき **到着も人数も滞在
 * 時間も、方針によらず同じであってほしい。** 1 本の列を全員で使うと、方針に
 * よって乱数を引く回数が変わり、そこから先がすべてずれる。「待ち時間が縮んだ
 * のは方針のおかげか、たまたま空いていた日だからか」が区別できなくなる。
 *
 * そこで **目的ごとに独立した流れ**（`streamFor`）を作る。さらに、1 組の性質
 * （人数・滞在時間・歩く速さ・ノーショーするか）は **その組だけの流れ**から
 * まとめて引く。こうすると、何組目の誰がどんな人かが方針によらず固定される。
 * シミュレーションではこれを「共通乱数」と呼び、比較の分散を大きく下げる。
 *
 * ## 中身
 *
 * `sfc32`（Small Fast Counter）を使う。32 ビットの整数演算だけで書けて速く、
 * 統計的な質も十分である。種の展開には `splitmix32` を使い、近いシード
 * （1 と 2 など）でも無関係な列になるようにする。
 */

/** 擬似乱数の流れ。`next()` は 0 以上 1 未満を返す。 */
export interface Rng {
  next(): number;
}

const UINT32 = 4_294_967_296;

/**
 * 種を混ぜて広げる。
 *
 * 近いシードから近い列が出ると、シードを 1 ずつ変えて回したときに独立な試行に
 * ならない。`splitmix32` はこれをほぐすために使う。
 */
function splitmix32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x9e3779b9) | 0;
    let mixed = state ^ (state >>> 16);
    mixed = Math.imul(mixed, 0x21f0aaad);
    mixed = mixed ^ (mixed >>> 15);
    mixed = Math.imul(mixed, 0x735a2d97);
    return (mixed ^ (mixed >>> 15)) >>> 0;
  };
}

/** 4 つの 32 ビット整数を状態に持つ生成器。 */
function sfc32(a: number, b: number, c: number, d: number): Rng {
  let x = a | 0;
  let y = b | 0;
  let z = c | 0;
  let counter = d | 0;

  return {
    next(): number {
      const sum = (((x + y) | 0) + counter) | 0;
      counter = (counter + 1) | 0;
      x = y ^ (y >>> 9);
      y = (z + (z << 3)) | 0;
      z = (z << 21) | (z >>> 11);
      z = (z + sum) | 0;
      return (sum >>> 0) / UINT32;
    },
  };
}

/** 生成器を作り、最初の数回を捨てて状態をほぐす。 */
function fromSeeds(expand: () => number): Rng {
  const rng = sfc32(expand(), expand(), expand(), expand());
  for (let warmup = 0; warmup < 12; warmup += 1) rng.next();
  return rng;
}

/** シードから 1 本の流れを作る。 */
export function createRng(seed: number): Rng {
  return fromSeeds(splitmix32(seed));
}

/**
 * 文字列を 32 ビットの数に畳む（FNV-1a）。
 *
 * 流れの名前をシードに混ぜるために使う。暗号用途ではない。
 */
export function hashName(name: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash = hash ^ name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * シードと「目的」から独立した流れを作る。
 *
 * 同じ `(seed, name, index)` からは必ず同じ列が出る。名前が違えば無関係な列に
 * なるので、ある目的で乱数を引く回数が変わっても、ほかの目的には影響しない。
 *
 * @param name 目的の名前（`arrivals`、`party` など）
 * @param index 同じ目的の中で区別したいときの番号（何組目か、など）
 */
export function streamFor(seed: number, name: string, index: number): Rng {
  const mixed: number = (Math.imul(hashName(name), 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca6b)) | 0;
  return fromSeeds(splitmix32((seed ^ mixed) | 0));
}
