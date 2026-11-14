/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'LatticeDX · Workspace', description: 'Nền tảng chuyển đổi số của nhóm' };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="vi"><body>{children}</body></html>;
}
