/**
 * 誰が何を見ているか（開発プラン 9.5、[ADR-0018](../../../docs/adr/0018-server-sent-events.md)）。
 *
 * **ここは中身を知らない。** チケットの姿も施設の姿も組み立てない。知っている
 * のは 3 つだけである。
 *
 * 1. **どの施設を、誰が見ているか**
 * 2. 変化があったら、**それぞれに自分の姿を組み立てさせる**
 * 3. **前と同じものは送らない**
 *
 * 3 つめが効く。1 人が呼び出されたとき、施設の変化は全員に届くが、**座っている
 * 人の姿は何も変わらない。** 変わらないものを送ると、数百台の画面を無駄に
 * 起こすことになる（電池を削る）。
 *
 * ## 数について
 *
 * 変化のたびに**全員ぶん組み立て直す。** 接続数 × 変化の数だけ仕事が増えるが、
 * 配信量は小さい（9.5。施設あたり数百接続、数十イベント/分）ので、これで足りる。
 *
 * **心拍では起こさない。** それだけは接続数の二乗になるため、アクターの側で
 * 止めてある（`venue/actor.ts` の `touch`）。
 */

/**
 * 組み立てた 1 通。
 *
 * **送る中身と、同じかどうかを見る鍵を分けてある。** どの姿にもサーバ時刻が
 * 入っているので（`serverNow`）、中身をそのまま比べると**時計が動いただけで
 * 「変わった」ことになり、重複を落とせない。**
 */
export interface Rendered {
  /** 送る中身。 */
  readonly payload: string;
  /** 前と同じかを見る鍵。**時刻のように毎回変わるものを外したもの。** */
  readonly same: string;
}

/** 1 人の見ている人。 */
export interface Watcher {
  /**
   * いまの姿を組み立てる。**送るものが無ければ `null`。**
   *
   * 文字列で返すのは、**同じかどうかをここで比べる**ためである。組み立てる側が
   * 形を知っていて、こちらは知らない。
   */
  readonly render: () => Rendered | null;
  /** 届ける。**戻りを待たない**（遅い相手が、ほかの人を止めない）。 */
  readonly send: (payload: string) => void;
}

export interface Hub {
  /**
   * 見はじめる。**その場で 1 通目が届く。**
   *
   * つないだ相手に必ず現在の姿を渡すのは、**切れているあいだの変化を吸収する**
   * ためである（ADR-0018）。だから「どこから追いつくか」を決める必要がない。
   *
   * 返るのは、見おわるための手続き。
   */
  readonly watch: (venueId: string, watcher: Watcher) => () => void;
  /** 変化があった。**見ている人それぞれに、新しい姿を配る。** */
  readonly wake: (venueId: string) => void;
  /** いま何人が見ているか。**監視に出す**（CLAUDE.md 8）。 */
  readonly watching: (venueId?: string) => number;
}

export interface OpenHubParams {
  /**
   * 組み立てに失敗した人がいた。
   *
   * **1 人の不具合で、ほかの人への配信を止めない。** ただし黙って捨てない
   * （CLAUDE.md 6 の「握り潰さない」）。何を記録するかは呼ぶ側が決める。
   */
  readonly onTrouble?: (error: unknown) => void;
}

/** 見ている人と、その人に最後に送った姿の鍵。 */
type Room = Map<Watcher, string | null>;

export function openHub(params: OpenHubParams = {}): Hub {
  const rooms = new Map<string, Room>();

  const watch = (venueId: string, watcher: Watcher): (() => void) => {
    const room: Room = rooms.get(venueId) ?? new Map<Watcher, string | null>();
    room.set(watcher, null);
    rooms.set(venueId, room);
    deliver(room, watcher, params.onTrouble);
    return () => {
      room.delete(watcher);
      if (room.size === 0) rooms.delete(venueId);
    };
  };

  const wake = (venueId: string): void => {
    const room: Room | undefined = rooms.get(venueId);
    if (room === undefined) return;
    // 配っている最中に誰かが去ることがある。**写しを回す。**
    for (const watcher of [...room.keys()]) deliver(room, watcher, params.onTrouble);
  };

  return { watch, wake, watching: (venueId) => count(rooms, venueId) };
}

/** 施設を指せばその施設の、指さなければ全体の数。 */
function count(rooms: ReadonlyMap<string, Room>, venueId?: string): number {
  if (venueId !== undefined) return rooms.get(venueId)?.size ?? 0;
  return [...rooms.values()].reduce((total, room) => total + room.size, 0);
}

/** 1 人に届ける。**前と同じなら何もしない。** */
function deliver(room: Room, watcher: Watcher, onTrouble: OpenHubParams['onTrouble']): void {
  try {
    // 配っている最中に去った人に、送り直さない（**書き戻して復活させない**）。
    if (!room.has(watcher)) return;
    const shown: Rendered | null = watcher.render();
    if (shown === null || shown.same === room.get(watcher)) return;
    room.set(watcher, shown.same);
    watcher.send(shown.payload);
  } catch (error: unknown) {
    onTrouble?.(error);
  }
}
