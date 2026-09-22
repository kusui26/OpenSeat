/**
 * 配信につなぎ続ける（開発プラン 9.5、[ADR-0018](../../../docs/adr/0018-server-sent-events.md)）。
 *
 * **React を知らない。** つなぎ直しも見張りも、画面の都合とは関係が無いので
 * ここに閉じてある（フックは [`use-live.ts`](use-live.ts)）。偽の接続を差し込めば
 * そのまま試せる。
 *
 * ## つながらないときに何が起きるか（9.5 の階段）
 *
 * 1. **切れたら、時間を倍にしながらつなぎ直す。** 施設の機械が落ちているときに
 *    数百台が 1 秒ごとに叩くと、戻ってきた瞬間にまた落ちる
 * 2. **つながっていないあいだは、画面が 5 秒ごとに取りに行く**（フックの仕事）
 *
 * ## 生きていることをどう確かめるか
 *
 * **黙って死ぬ接続がある。** 携帯回線では、切れたのに切れたと知らされない
 * （片側だけ閉じた）状態が起きる。そのままだと、こちらは「つながっている」と
 * 思い込んだまま何も受け取らない。
 *
 * だからサーバは何も無くても `ping` を流し、こちらは**来なくなったら切れたとみなす。**
 */

import { STREAM_PING_MS, STREAM_RETRY_MS } from '@openseat/shared';

/**
 * 接続。**`EventSource` のうち、ここで使うぶんだけ。**
 *
 * 狭くしてあるのは、テストで偽物を渡せるようにするためである。
 */
export interface Socket {
  readonly addEventListener: (type: string, listener: (event: MessageEvent<string>) => void) => void;
  readonly close: () => void;
}

export type OpenSocket = (url: string) => Socket;

export interface LiveParams {
  readonly url: string;
  /** 受け取る名前（`ticket` / `venue`）。 */
  readonly event: string;
  /** 1 通届いた。**中身の検証は呼ぶ側が行う。** */
  readonly onMessage: (data: string) => void;
  /** つながっているかが変わった。**退避を止めたり動かしたりするのに使う。** */
  readonly onLive: (live: boolean) => void;
  /** 接続の作り方。**テストでは偽物を渡す。** */
  readonly open?: OpenSocket;
}

/** 何も来なくなってから、切れたとみなすまで。**`ping` の 2 回ぶん待つ。** */
const SILENCE_MS = STREAM_PING_MS * 2;

/**
 * つなぎ続ける。返るのは、やめるための手続き。
 *
 * **`EventSource` の自動再接続は使わない。** あちらは固定の間隔でつなぎ直すので、
 * 倍にしていく決まり（9.5）を守れない。
 */
export function connect(params: LiveParams): () => void {
  const live = new Live(params);
  live.start();
  return () => {
    live.stop();
  };
}

type Timer = ReturnType<typeof setTimeout>;

class Live {
  private socket: Socket | null = null;
  private wait: number = STREAM_RETRY_MS.first;
  private again: Timer | null = null;
  private silence: Timer | null = null;
  private stopped = false;

  constructor(private readonly params: LiveParams) {}

  start(): void {
    if (this.stopped) return;
    const open: OpenSocket | null = this.opener();
    // **配信を持たない環境がある**（古いブラウザ、描き出しの途中）。そこでは
    // つながらないままにしておけば、画面が 5 秒ごとに取りに行く（9.5 の退避）。
    if (open === null) return;
    this.socket = open(this.params.url);
    this.wire(this.socket);
  }

  /** 4 つだけ聞く。**開いた・切れた・息・中身。** */
  private wire(socket: Socket): void {
    socket.addEventListener('open', () => {
      this.wait = STREAM_RETRY_MS.first;
      this.listen();
    });
    socket.addEventListener('error', () => {
      this.drop();
    });
    socket.addEventListener('ping', () => {
      this.listen();
    });
    socket.addEventListener(this.params.event, (message) => {
      this.listen();
      this.params.onMessage(message.data);
    });
  }

  /** 接続の作り方。**持たない環境では `null`。** */
  private opener(): OpenSocket | null {
    if (this.params.open !== undefined) return this.params.open;
    if (typeof EventSource === 'undefined') return null;
    return (url) => new EventSource(url);
  }

  /**
   * 何か届いた。**黙り込んだら切れたとみなす**ので、見張りを仕掛け直す。
   *
   * 1 通目が届いた時点でつながっている。`open` を待たない ——
   * **順序は置き場によって前後する。**
   */
  private listen(): void {
    this.params.onLive(true);
    if (this.silence !== null) clearTimeout(this.silence);
    this.silence = setTimeout(() => {
      this.drop();
    }, SILENCE_MS);
  }

  /** 切れた。**時間を倍にしながらつなぎ直す。** */
  private drop(): void {
    if (this.stopped) return;
    this.shut();
    this.params.onLive(false);
    this.again = setTimeout(() => {
      this.start();
    }, this.wait);
    this.wait = Math.min(this.wait * 2, STREAM_RETRY_MS.max);
  }

  stop(): void {
    this.stopped = true;
    this.shut();
    if (this.again !== null) clearTimeout(this.again);
    this.again = null;
  }

  /** いまの接続と見張りを片づける。**つなぎ直す予定には触らない。** */
  private shut(): void {
    this.socket?.close();
    this.socket = null;
    if (this.silence !== null) clearTimeout(this.silence);
    this.silence = null;
  }
}
