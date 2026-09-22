/**
 * 日本語の文言。
 *
 * **6.5 の原則に従う。**
 *
 * - **「予約」と言わない。** 空席を保証できないためである（7.1）。「順番待ち」「ご案内」を使う
 * - 命令形を避け、**理由を添える**（「次の方のために」）
 * - 時間上限は**「目安」**と書く。強制の印象を与えない（7.10、[ADR-0009](../../../../docs/adr/0009-seating-time-limit.md)）
 *
 * 「予約」が混ざっていないことは `i18n.test.ts` が見ている。
 */

import type { Bundle } from './bundle.js';

export const ja: Bundle = {
  locale: 'ja',

  messages: {
    // ---- 通知（17.3） ----
    'notify.joined':
      '順番待ちに登録しました（{code}）。前に {ahead} 組、目安 {etaFrom}〜{etaTo} 分です。この画面は閉じないでください。',
    'notify.called':
      'お席が決まりました。{table}（{capacity} 名席）へどうぞ。{holdMin} 分以内に席の QR を読み取ってください。',
    'notify.remind':
      'あと {minutes} 分で呼び出しが無効になります。向かっている場合は「向かっています」を押してください（+{extendMin} 分）。',
    'notify.noShowFirst':
      '呼び出しの時間を過ぎました。順番は保持しています。席に向かえるようになったら「準備OK」を押してください。',
    'notify.conflict': 'お手数をおかけしました。最優先で次の席をご案内します。',
    'notify.timeLimitSoon':
      'お席のご利用は {limitMin} 分を目安にお願いしています。現在 {waiting} 組がお待ちです。',
    'notify.stillHere': 'まだご利用中ですか？ 退席済みの場合は「退席しました」を押してください。',
    'notify.checkedOut':
      'ご協力ありがとうございました。次の方にお席をお渡ししました。よろしければ 3 問のアンケートにお答えください。',

    // ---- 座席 QR の分岐（7.8） ----
    'scan.check_in': '{table} にご案内しています。「着席しました」を押してください。',
    'scan.swap_offer':
      'この席は {table} です。ご案内しているのは {assigned} ですが、{table} が空いているのでこちらに変更できます。',
    'scan.other_table':
      'この席は {table} です。あなたのお席は {assigned} です。{table} が空いていて人数が合う場合は、この席に変更できます。',
    'scan.early_check_in':
      '{table} が空いています。順番を崩さずに座れるので、このままご利用いただけます。',
    'scan.keep_waiting':
      'まだ順番をお待ちください。前に {ahead} 組いらっしゃいます。お席が決まるとお知らせします。',
    'scan.resume_first':
      'いま呼び出しをお休みしています。席に向かえるようになったら「準備OK」を押してください。',
    'scan.seated_here': 'ご利用中のお席（{table}）です。お帰りの際は「退席しました」を押してください。',
    'scan.seated_elsewhere': 'ご利用中のお席は {assigned} です。',
    'scan.walk_in_offer':
      '{table}（{capacity} 名席）が空いています。お待ちの方がいないので、このままご利用いただけます。',
    'scan.queue_first':
      'この席は空いていますが、{waiting} 組がお待ちです。入口で順番待ちにご登録ください。',
    'scan.held_for_other': 'この席は、いま呼び出し中の方のために確保しています。',
    'scan.in_use': 'この席はご利用中です。入口で順番待ちにご登録ください。',
    'scan.needs_check':
      'この席は空いている可能性がありますが、確認できていません。ご利用中の方がいなければ「空いていました」を押してください。',
    'scan.turnover': 'この席は片付け中です。まもなくご案内できます。',
    'scan.not_managed': 'この席は順番待ちの対象外です。空いていればご自由にご利用ください。',

    // ---- 画面の骨組み ----
    'venue.closed': 'ただいま順番待ちのご案内を行っていません。空いている席をご自由にご利用ください。',
    'venue.joinClosed': '本日の受付は終了しました。空いている席をご自由にご利用ください。',
    'ticket.staleCall': 'この呼び出しは無効になっています。お手数ですが、もう一度ご登録ください。',
    'ticket.longWaitConfirm': 'いまお待ちいただく目安は {minutes} 分です。それでも並びますか。',

    // ---- 受付の画面（10.1） ----
    'join.heading': '{venue} の順番待ち',
    'join.partySize': '何名さまですか',
    'join.decrease': '人数を 1 減らす',
    'join.increase': '人数を 1 増やす',
    'join.submit': '順番待ちに登録する',
    'join.sending': '登録しています…',
    'join.watchOnly': '登録せずに、混み具合だけ見る',
    'join.eta': '目安 {fromMin}〜{toMin} 分',
    'join.etaUnknown': '目安をお出しできません',
    'join.noSeat': 'この人数でご案内できるお席がありません',

    // ---- チケットの画面（7.3、10.4） ----
    'ticket.heading': '{code} 番',
    'ticket.keepOpen': 'この画面は閉じないでください。',
    'ticket.comeBack': '閉じてしまっても、この URL から戻れます。ブックマークかホーム画面への追加をおすすめします。',
    'ticket.copyLink': 'この画面の URL をコピー',
    'ticket.copied': 'コピーしました',
    'ticket.table': 'お席は {table} です',
    'ticket.remaining': 'あと {minutes} 分 {seconds} 秒',
    'ticket.expired': '時間が過ぎました',
    'ticket.ahead': '前に {ahead} 組お待ちです',
    'ticket.reload': '読み込み直す',

    // ---- 状態ごとの一言（7.3 の 8 状態） ----
    'state.WAITING': '順番をお待ちください。お席が決まるとお知らせします。',
    'state.PAUSED': '呼び出しをお休みしています。順番は保持しているので、戻れるようになったら「準備OK」を押してください。',
    'state.CALLED': 'お席が決まりました。お席の QR を読み取って、着席をお知らせください。',
    'state.SEATED': 'ご利用中です。お帰りの際は「退席しました」を押していただけると、次の方をご案内できます。',
    'state.DONE': 'ご協力ありがとうございました。',
    'state.CANCELLED': '順番待ちを取り消しました。またのご利用をお待ちしています。',
    'state.NO_SHOW': '呼び出しの時間を過ぎたため、順番待ちを終了しました。お手数ですが、もう一度ご登録ください。',
    'state.EXPIRED': '順番待ちの期限が過ぎました。お手数ですが、もう一度ご登録ください。',

    // ---- 押せる操作の名前（22 コマンド） ----
    'action.JOIN': '順番待ちに登録する',
    'action.WALK_IN': 'このお席を使う',
    'action.CANCEL': '順番待ちをやめる',
    'action.PAUSE': 'あとにする',
    'action.READY': '準備OK',
    'action.EXTEND': '向かっています',
    'action.PASS': '次の方へ譲る',
    'action.CHECK_IN': '着席しました',
    'action.CHECK_IN_EARLY': 'このお席に座る',
    'action.SWAP_TABLE': 'このお席に変更する',
    'action.CHECK_OUT': '退席しました',
    'action.STILL_HERE': 'まだ利用中です',
    'action.REPORT_TAKEN': '誰か座っています',
    'action.REPORT_IN_USE': '使用中でした',
    'action.CONFIRM_FREE': '空いていました',
    'action.CHANGE_PARTY_SIZE': '人数を変える',
    'action.HEARTBEAT': '接続を知らせる',
    'action.OPEN': '運用を開始する',
    'action.CLOSE': '運用を終了する',
    'action.RELEASE_ALL': '全席を解放する',
    'action.DISABLE_TABLE': '対象外にする',
    'action.ENABLE_TABLE': '対象に戻す',

    // ---- 空き状況の画面（10.1） ----
    'status.heading': '{venue} の混み具合',
    'status.waiting': '{count} 組がお待ちです',
    'status.free': '空いているお席 {free} / {managed}',
    'status.notOperating': 'ただいま順番待ちのご案内を行っていません。空いているお席をご自由にご利用ください。',
    'status.joinHere': '順番待ちに登録する',
    'status.forParty': '{partySize} 名',
  },

  /**
   * 断りの文言。
   *
   * **打つ手を添える。** 「できません」だけでは、利用者は次に何をすればよいか
   * 分からない。
   *
   * 最後の 4 つ（`GUARD_NOT_IMPLEMENTED` から下）は**実装の誤り**で、利用者に
   * 伝えても打つ手がない。外には出さず、`apiErrorFor` が `INTERNAL` に潰す。
   * それでも文言を持つのは、**網羅を型で確かめるため**である。
   */
  errors: {
    // 入力
    PARTY_SIZE_INVALID: '人数を数字で入力してください。',
    PARTY_TOO_SMALL: '人数は 1 名からご登録いただけます。',
    PARTY_TOO_LARGE:
      'この人数のお席をご用意できません。お手数ですが、分けてご登録いただけますか。',
    REASON_REQUIRED: '理由を選んでください。',
    INVALID_REQUEST: '入力の形式が正しくありません。',

    // 見つからない
    TICKET_NOT_FOUND: 'この順番待ちは見つかりませんでした。お手数ですが、もう一度ご登録ください。',
    TABLE_NOT_FOUND: 'このお席は見つかりませんでした。席番号をご確認ください。',
    NOT_FOUND: 'お探しのページは見つかりませんでした。',

    // 資格
    UNAUTHORIZED: 'この操作にはログインが必要です。',
    FORBIDDEN: 'この操作を行う権限がありません。',
    STAFF_ONLY: 'この操作はスタッフにお声がけください。',

    // いまはできない
    TICKET_ALREADY_EXISTS: 'すでにご登録いただいています。',
    QUEUE_FULL: 'ただいま順番待ちが大変混み合っています。しばらくしてからお試しください。',
    JOIN_CLOSED: '本日の受付は終了しました。空いている席をご自由にご利用ください。',
    NOT_ALLOWED_IN_STATE: 'いまはこの操作を行えません。画面を更新してお確かめください。',
    BLOCKED_BY_GUARD: 'いまはこの操作を行えません。画面を更新してお確かめください。',
    NO_CODE_AVAILABLE: 'ただいま順番待ちが大変混み合っています。しばらくしてからお試しください。',
    RATE_LIMITED: '短い時間に何度もご登録いただいています。しばらくしてからお試しください。',

    // こちらの落ち度（外には出ない）
    ACTOR_MISMATCH: '申し訳ありません。うまく処理できませんでした。',
    GUARD_NOT_IMPLEMENTED: '申し訳ありません。うまく処理できませんでした。',
    CLOCK_WENT_BACKWARD: '申し訳ありません。うまく処理できませんでした。',
    INVARIANT_VIOLATED: '申し訳ありません。うまく処理できませんでした。',
    INTERNAL: '申し訳ありません。うまく処理できませんでした。',
  },
};
