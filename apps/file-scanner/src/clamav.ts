/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { createConnection } from 'node:net';

export function scanWithClamd(
  content: Buffer,
  host: string,
  port = 3310,
  timeoutMs = 15_000,
): Promise<'clean' | 'rejected'> {
  if (!host.trim()) {
    return Promise.reject(new Error('Invalid ClamAV host'));
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.reject(new Error('Invalid ClamAV port'));
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    let response = '';
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    const succeed = (outcome: 'clean' | 'rejected') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(outcome);
    };

    socket.setTimeout(timeoutMs, () => fail(new Error('Scanner timeout')));
    socket.on('error', (error) => fail(error instanceof Error ? error : new Error('Scanner error')));

    socket.on('connect', () => {
      const header = Buffer.from('zINSTREAM\0');
      const terminator = Buffer.alloc(4);
      if (content.length === 0) {
        socket.write(Buffer.concat([header, terminator]));
        return;
      }
      const size = Buffer.alloc(4);
      size.writeUInt32BE(content.length);
      socket.write(Buffer.concat([header, size, content, terminator]));
    });

    socket.on('data', (chunk) => {
      if (settled) return;
      response += chunk.toString();
      if (response.length > 4096) {
        fail(new Error('Invalid scanner response'));
        return;
      }
      const nullIdx = response.indexOf('\0');
      if (nullIdx === -1) return;
      const line = response.slice(0, nullIdx);
      if (line === 'stream: OK') {
        succeed('clean');
      } else if (/^stream: .+ FOUND$/.test(line)) {
        succeed('rejected');
      } else {
        fail(new Error('Scanner failed'));
      }
    });

    socket.on('end', () => {
      if (!settled && !response.includes('\0')) {
        fail(new Error('Incomplete scanner response'));
      }
    });
  });
}
