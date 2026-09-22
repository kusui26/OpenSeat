/**
 * 道案内（10.1 の画面一覧）。
 *
 * **利用者の 3 画面だけ。** 座席 QR は PR 10、ボードは PR 11、スタッフと管理は
 * PR 12 以降で足す。
 */

import { Navigate, Route, Routes } from 'react-router';
import { JoinScreen } from './screens/join.tsx';
import { StatusScreen } from './screens/status.tsx';
import { TicketScreen } from './screens/ticket.tsx';
import { lastTicket } from './device.ts';

export function App(): React.JSX.Element {
  return (
    <Routes>
      <Route path="/v/:venue" element={<JoinScreen />} />
      <Route path="/v/:venue/status" element={<StatusScreen />} />
      <Route path="/t/:ticket" element={<TicketScreen />} />
      <Route path="*" element={<Landing />} />
    </Routes>
  );
}

/**
 * 入口が分からないときの行き先。
 *
 * **前に並んだチケットがあれば、そこへ戻す**（10.4）。ブックマークを取り損ねた人が、
 * 同じ端末で開き直したときに助かる。
 */
function Landing(): React.JSX.Element {
  const known: string | null = lastTicket();
  return known === null ? <Navigate to="/v/demo" replace /> : <Navigate to={known} replace />;
}
