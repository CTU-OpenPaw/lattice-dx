/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { FileReadError, loadFileContentWithClient } from './content.js';
import { MAX_FILE_BYTES, type ObjectStore } from './object-store.js';

const columns = 'id AS "fileId", filename, size, scan_status AS "scanStatus"';
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const name = /^[A-Za-z0-9_-]{1,80}$/;
const decimal = /^[1-9]\d{0,18}$/;
type Scope = { instance: string; organizationId: string; requestId: string; userId: string };

export function nativeRequestStorage(pool: Pool, store?: ObjectStore) {
  const key = (scope: Scope) => [scope.instance, scope.organizationId, scope.requestId];
  return {
    async acceptNonce(nonce: string, at: number) {
      const result = await pool.query(`WITH expired AS (
        DELETE FROM native_file_request_nonces WHERE expires_at < now()
      ) INSERT INTO native_file_request_nonces(nonce, expires_at)
        VALUES ($1, $2) ON CONFLICT DO NOTHING`, [nonce, new Date(at + 15000)]);
      return result.rowCount === 1;
    },
    async list(scope: Scope, limit: number, offset: number) {
      return (await pool.query(`SELECT ${columns} FROM foundation_files
        WHERE native_instance=$1 AND organization_id=$2 AND native_request_id=$3 ORDER BY id LIMIT $4 OFFSET $5`,
      [...key(scope), limit, offset])).rows;
    },
    async uploaded(scope: Scope, idempotencyKey: string) {
      return (await pool.query(`SELECT ${columns}, native_content_digest AS digest FROM foundation_files
        WHERE native_instance=$1 AND organization_id=$2 AND native_request_id=$3 AND owner_id=$4 AND native_upload_key=$5`,
      [...key(scope), scope.userId, idempotencyKey])).rows[0];
    },
    async store(scope: Scope, idempotencyKey: string, filename: string, content: Buffer, digest: string) {
      return (await pool.query(`INSERT INTO foundation_files
        (id,filename,owner_id,organization_id,content,size,scan_status,native_request_id,native_instance,native_upload_key,native_content_digest)
        VALUES($1,$2,$3,$4,$5,$6,'clean',$7,$8,$9,$10)
        ON CONFLICT (native_instance,organization_id,native_request_id,owner_id,native_upload_key)
        WHERE native_request_id IS NOT NULL DO NOTHING RETURNING ${columns}`,
      [randomUUID(), filename, scope.userId, scope.organizationId, content, content.length, scope.requestId, scope.instance, idempotencyKey, digest])).rows[0];
    },
    async download(scope: Scope, id: string) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const file = await loadFileContentWithClient(client, { subject: scope.userId, organizationId: scope.organizationId, roles: [] },
          id, { kind: 'nativeRequest', requestId: scope.requestId, instance: scope.instance }, store);
        await client.query('COMMIT');
        return file;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export function registerNativeRequestStorage(app: FastifyInstance, options: {
  secret: string;
  instance: string;
  repository: ReturnType<typeof nativeRequestStorage>;
  scan: (content: Buffer) => Promise<'clean' | 'rejected'>;
}) {
  if (!/^[a-f0-9]{64}$/i.test(options.secret) || !name.test(options.instance)) throw Error('Invalid native file service configuration');
  const { repository } = options;
  app.post<{Body: string}>('/internal/native-request-files', { bodyLimit: 1_450_000 }, async (req, reply) => {
    const raw = req.body;
    const signature = req.headers['x-dx-native-signature'];
    if (typeof raw !== 'string' || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature) ||
        !timingSafeEqual(Buffer.from(signature, 'hex'), createHmac('sha256', Buffer.from(options.secret, 'hex')).update(raw).digest())) {
      return reply.code(401).send({ error: 'Yêu cầu nội bộ không hợp lệ.' });
    }
    let input;
    try { input = JSON.parse(raw); }
    catch { return reply.code(400).send({ error: 'Yêu cầu nội bộ không hợp lệ.' }); }
    if (!input || !Number.isSafeInteger(input.at) || Math.abs(Date.now() - input.at) > 15000 ||
        typeof input.nonce !== 'string' || !uuid.test(input.nonce)) {
      return reply.code(401).send({ error: 'Yêu cầu nội bộ đã hết hạn.' });
    }
    const { operation, organizationId, requestId, userId } = input;
    if (input.instance !== options.instance || typeof organizationId !== 'string' || !name.test(organizationId) ||
        typeof requestId !== 'string' || !decimal.test(requestId) || typeof userId !== 'string' || !decimal.test(userId)) {
      return reply.code(400).send({ error: 'Phạm vi tệp không hợp lệ.' });
    }
    if (!await repository.acceptNonce(input.nonce, input.at)) {
      return reply.code(401).send({ error: 'Yêu cầu nội bộ đã được sử dụng.' });
    }
    const scope = { instance: options.instance, organizationId, requestId, userId };
    reply.header('Cache-Control', 'private, no-store');
    if (operation === 'list') {
      const { limit, offset } = input;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0 || offset > 999999) {
        return reply.code(400).send({ error: 'Phân trang không hợp lệ.' });
      }
      return repository.list(scope, limit, offset);
    }
    if (operation === 'download') {
      if (typeof input.fileId !== 'string' || !uuid.test(input.fileId)) return reply.code(400).send({ error: 'Mã tệp không hợp lệ.' });
      try {
        const file = await repository.download(scope, input.fileId);
        if (!file) return reply.code(404).send({ error: 'Không tìm thấy tệp.' });
        return reply.type('application/octet-stream').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`).send(file.content);
      } catch (error) {
        if (error instanceof FileReadError) return reply.code(error.statusCode).send({ error: error.message });
        throw error;
      }
    }
    if (operation !== 'upload') return reply.code(400).send({ error: 'Thao tác không hợp lệ.' });
    const { key, filename, contentBase64 } = input;
    if (typeof key !== 'string' || !uuid.test(key) || typeof filename !== 'string' || !filename.trim() || filename.length > 200 ||
        /[\x00-\x1f\x7f/\\]/.test(filename) || typeof contentBase64 !== 'string') {
      return reply.code(400).send({ error: 'Tệp hoặc khóa gửi lại không hợp lệ.' });
    }
    try { encodeURIComponent(filename); }
    catch { return reply.code(400).send({ error: 'Tên tệp chứa Unicode không hợp lệ.' }); }
    const content = Buffer.from(contentBase64, 'base64');
    if (content.length > MAX_FILE_BYTES) return reply.code(413).send({ error: 'Giới hạn tệp 1 MiB.' });
    if (!content.length || content.toString('base64') !== contentBase64) return reply.code(400).send({ error: 'Base64 không hợp lệ.' });
    const digest = createHash('sha256').update(content).digest('hex');
    const replay = async (row: { filename: string; digest: string }) => {
      if (row.filename !== filename.trim() || row.digest !== digest) return reply.code(409).send({ error: 'Khóa gửi lại đã dùng cho tệp khác.' });
      const { digest: _digest, ...file } = row;
      return reply.send(file);
    };
    const previous = await repository.uploaded(scope, key);
    if (previous) return replay(previous);
    let scan;
    try { scan = await options.scan(content); }
    catch { return reply.code(503).send({ error: 'Bộ quét tệp chưa sẵn sàng.' }); }
    if (scan !== 'clean') return reply.code(409).send({ error: 'Tệp bị bộ quét từ chối.' });
    const inserted = await repository.store(scope, key, filename.trim(), content, digest);
    if (inserted) return reply.code(201).send(inserted);
    const concurrent = await repository.uploaded(scope, key);
    return concurrent ? replay(concurrent) : reply.code(503).send({ error: 'Tệp chưa sẵn sàng. Vui lòng gửi lại.' });
  });
}
