/**
 * 「何か起きた」を、開きっぱなしの接続へ知らせるだけの仕掛け。
 *
 * **本番の配信ではない。** 9.2 は WebSocket（SSE へフォールバック）で、施設ごと・
 * 画面ごとに何を送るかを選ぶ。ここは**全員に「更新があった」とだけ伝える**。
 *
 * これを置いてあるのは、**長く開いたままの接続が Railway のプロキシ越しに
 * 保てるか**を、依存を 1 つも足さずに確かめるためである（9.2 のいちばん大きな
 * 未知のひとつ）。
 */

export class Hub {
  private readonly listeners = new Set<() => void>();

  /** 購読する。戻り値を呼ぶと解除できる。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 全員に知らせる。**1 つが失敗しても残りには届ける。** */
  publish(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        this.listeners.delete(listener);
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
