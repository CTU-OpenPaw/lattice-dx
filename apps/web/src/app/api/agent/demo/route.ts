/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { isDemoResult, parseDemoRequest } from '@dx/contracts';
export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: 'Dữ liệu JSON không hợp lệ.' }, { status: 400 }); }
  const input = parseDemoRequest(body);
  if (!input) return Response.json({ error: 'Nhập yêu cầu từ 1 đến 2000 ký tự.' }, { status: 400 });
  try {
    const response = await fetch(new URL('/v1/agent/demo', process.env.API_URL ?? 'http://127.0.0.1:4000'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) throw new Error('Upstream unavailable');
    const data: unknown = await response.json();
    if (!isDemoResult(data)) throw new Error('Invalid response');
    return Response.json(data);
  } catch { return Response.json({ error: 'Dịch vụ xử lý chưa sẵn sàng. Vui lòng thử lại.' }, { status: 503 }); }
}
