/**
 * 端末が覚えておくもの（9.8、[ADR-0015](../../../docs/adr/0015-idempotency-key.md)）。
 *
 * **どれも画面が作る。** サーバは作らない。
 *
 * | | 何のため | どこに置くか |
 * |---|---|---|
 * | 匿名トークン | 同じ端末だと分かるため（受付の回数制限） | `localStorage`（Cookie にも控えが返る） |
 * | チケットの秘密 | そのチケットの本人だと示すため | `localStorage`（URL にも乗る） |
 * | 冪等キー | 送り直しで二度適用しないため | 送るたびに新しく作る |
 *
 * **秘密をサーバに預け直さない。** 受付のときに 1 度ハッシュを渡すだけで、
 * 以後は URL の `?k=` で示す。
 */

const TOKEN_KEY = 'openseat.client';

/** 推測不能な値。**`Math.random()` は使わない。** */
function random(bytes = 16): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * この端末の匿名トークン。
 *
 * **消えても困らない。** 消えたら新しく作るだけで、順番は URL のほうが持っている。
 * 受付の回数制限が数え直しになるが、そこは厳密さより使いやすさを採る（7.16）。
 */
export function clientToken(): string {
  const known: string | null = read(TOKEN_KEY);
  if (known !== null) return known;
  const made: string = random();
  write(TOKEN_KEY, made);
  return made;
}

/** 新しいチケットの秘密。**受付のたびに作る。** */
export function newSecret(): string {
  return random(24);
}

/** 送り直しを見分ける鍵。**操作のたびに作る。** */
export function newIdempotencyKey(): string {
  return random(12);
}

/**
 * 自分のチケットの URL を覚えておく。
 *
 * **画面を閉じても戻れるように**（10.4）。ブックマークを勧めるが、勧めただけでは
 * 押さない人のほうが多い。
 */
export function rememberTicket(url: string): void {
  write('openseat.ticket', url);
}

export function lastTicket(): string | null {
  return read('openseat.ticket');
}

/** 置き場が使えないことがある（無効化・容量切れ）。**読めなくても止まらない。** */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 覚えておけないだけで、いまの操作は続けられる。
  }
}
