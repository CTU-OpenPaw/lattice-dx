/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const { randomUUID } = require('node:crypto');
const { createConnection } = require('node:net');
const { resolveNativeActor, scopeNativeRead } = require('./native-scope');
const { canUsePgRlsSession, getActiveRlsContext, setTransactionRlsOrg } = require('./pg-rls');
const { createSharedUploadReceipts } = require('./native-shared-upload');

const resource = 'latticeRequestAttachments';
const requestCollection = 'latticeRequests';
const maxBytes = 1024 * 1024;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const metadata = 'id AS "fileId", filename, octet_length(content) AS size, \'clean\' AS "scanStatus"';

function scanWithClamd(content, host) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port: 3310 });
    let reply = '';
    function fail(error) {
      socket.destroy();
      reject(error);
    }
    socket.setTimeout(15000, () => fail(new Error('Scanner timeout')));
    socket.on('error', fail);
    socket.on('end', () => fail(new Error('Incomplete scanner response')));
    socket.on('connect', () => {
      const size = Buffer.alloc(4);
      size.writeUInt32BE(content.length);
      socket.write(Buffer.concat([Buffer.from('zINSTREAM\0'), size, content, Buffer.alloc(4)]));
    });
    socket.on('data', chunk => {
      reply += chunk.toString();
      if (reply.length > 4096) return fail(new Error('Invalid scanner response'));
      if (!reply.includes('\0')) return;
      socket.destroy();
      const [line] = reply.split('\0');
      if (line === 'stream: OK') return resolve(true);
      if (/^stream: .+ FOUND$/.test(line)) return resolve(false);
      reject(new Error('Scanner failed'));
    });
  });
}

function uploadInput(ctx) {
  const { filename, contentBase64 } = ctx.action.params.values ?? {};
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 200 || /[\x00-\x1f\x7f/\\]/.test(filename)) {
    ctx.throw(400, 'Tên tệp không hợp lệ.');
  }
  if (typeof contentBase64 !== 'string' || !contentBase64) ctx.throw(400, 'Tệp trống hoặc không hợp lệ.');
  if (contentBase64.length > Math.ceil(maxBytes / 3) * 4) ctx.throw(413, 'Giới hạn tệp 1 MiB.');
  const content = Buffer.from(contentBase64, 'base64');
  if (content.length > maxBytes) ctx.throw(413, 'Giới hạn tệp 1 MiB.');
  if (!content.length || content.toString('base64') !== contentBase64) ctx.throw(400, 'Base64 không hợp lệ.');
  const key = ctx.get('Idempotency-Key');
  if (!uuid.test(key)) ctx.throw(400, 'Idempotency-Key phải là UUID.');
  return { filename: filename.trim(), content, key };
}

function registerNativeRequestAttachments(app, scannerHost, submitOrganization, sharedFiles) {
  const { db } = app;
  const query = async (sql, bind, transaction) => (await db.sequelize.query(sql, { bind, transaction }))[0];
  const uploads = createSharedUploadReceipts(query);
  async function useShared({ id, actor, transaction }) {
    if (!sharedFiles) return false;
    const rows = await query('SELECT 1 FROM lattice_native_request_attachments WHERE request_id=$1 AND organization_id=$2 LIMIT 1',
      [id, actor.organizationId], transaction);
    return !rows.length;
  }

  async function checkRequestPermission(ctx, id, actor, transaction, action) {
    const acl = ctx.dataSource.acl;
    const roles = ctx.state.currentRoles ?? [ctx.state.currentRole];
    if (!acl.can({ roles, resource: requestCollection, action })) ctx.throw(403, 'Không có quyền trên yêu cầu.');
    const { mergedParams } = await acl.resolveActionParams(ctx, {
      resourceName: requestCollection, actionName: action, params: { filter: { id } },
    });
    const scoped = scopeNativeRead({ filter: { $and: [{ id }, mergedParams?.filter ?? {}] } }, actor);
    const allowed = await db.getRepository(requestCollection).findOne({ ...scoped, fields: ['id'], transaction, context: ctx });
    if (!allowed) ctx.throw(404, 'Không tìm thấy yêu cầu.');
  }

  async function withRequest(ctx, method, action, work, lockForUpdate = false) {
    if (ctx.method !== method) ctx.throw(405);
    const id = ctx.query.requestId;
    if (typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
      ctx.throw(400, 'Mã yêu cầu không hợp lệ.');
    }
    return db.sequelize.transaction(async transaction => {
      const actor = await resolveNativeActor(db, ctx.state.currentUser, { transaction, lock: transaction.LOCK.SHARE });
      if (canUsePgRlsSession(db) && !getActiveRlsContext()?.transaction) {
        await setTransactionRlsOrg(db, actor.organizationId, transaction);
      }
      const request = await db.getModel(requestCollection).findOne({
        where: { id, organizationId: actor.organizationId },
        transaction,
        lock: lockForUpdate ? transaction.LOCK.UPDATE : transaction.LOCK.SHARE,
      });
      if (!request) ctx.throw(404, 'Không tìm thấy yêu cầu.');
      await checkRequestPermission(ctx, id, actor, transaction, action);
      if (action === 'update' && request.get('status') !== 'draft') ctx.throw(409, 'Chỉ thêm tệp khi yêu cầu còn nháp.');
      return work({ id, actor, transaction, request });
    });
  }

  app.resourceManager.define({ name: resource, actions: {
    async list(ctx, next) {
      const limit = ctx.query.limit ?? '20';
      const offset = ctx.query.offset ?? '0';
      if (typeof limit !== 'string' || !/^[1-9]\d?$/.test(limit) || Number(limit) > 50 ||
          typeof offset !== 'string' || !/^\d{1,6}$/.test(offset)) ctx.throw(400, 'Phân trang không hợp lệ.');
      ctx.body = await withRequest(ctx, 'GET', 'view', async scope => {
        const { id, actor, transaction } = scope;
        if (await useShared(scope)) return (await sharedFiles(ctx, 'list', scope, { limit: Number(limit), offset: Number(offset) })).data;
        return query(`SELECT ${metadata} FROM lattice_native_request_attachments
          WHERE request_id = $1 AND organization_id = $2 ORDER BY id LIMIT $3 OFFSET $4`,
        [id, actor.organizationId, Number(limit), Number(offset)], transaction);
      });
      ctx.set('Cache-Control', 'private, no-store');
      await next();
    },
    async upload(ctx, next) {
      const input = uploadInput(ctx);
      async function existing({ id, actor, transaction }) {
        const [row] = await query(`SELECT ${metadata}, content FROM lattice_native_request_attachments
          WHERE request_id = $1 AND organization_id = $2 AND uploader_id = $3 AND idempotency_key = $4`,
        [id, actor.organizationId, actor.userId, input.key], transaction);
        if (!row) return;
        const { content, ...file } = row;
        if (file.filename !== input.filename || !content.equals(input.content)) ctx.throw(409, 'Khóa gửi lại đã dùng cho tệp khác.');
        return file;
      }
      const { previous, sharedInput } = await withRequest(ctx, 'POST', 'update', async scope => {
        if (await useShared(scope)) {
          return { sharedInput: await uploads.prepare(ctx, scope, input, { stalePendingMs: Number(process.env.DX_UPLOAD_STALE_PENDING_MS) || 300000 }) };
        }
        return { previous: await existing(scope) };
      }, true);
      if (sharedInput) {
        const prep = await withRequest(ctx, 'POST', 'update', async scope => {
          const began = await uploads.beginExecute(ctx, scope, sharedInput);
          return { ...began, callScope: { id: scope.id, actor: scope.actor } };
        }, true);
        let shared;
        if (prep.phase === 'done') {
          shared = prep.response;
        } else {
          let uploadRes, uploadErr = null;
          try {
            uploadRes = await sharedFiles(ctx, 'upload', prep.callScope, {
              filename: prep.canonical.filename,
              key: prep.canonical.key,
              contentBase64: prep.canonical.content.toString('base64'),
            });
          } catch (error) {
            uploadErr = error;
          }
          shared = await withRequest(ctx, 'POST', 'update', scope => uploads.finalizeExecute(
            ctx, scope, prep.canonical, uploadRes, uploadErr, prep.attempts,
          ), true);
        }
        if (shared.error) ctx.throw(shared.error.status, shared.error.message);
        ctx.status = shared.status;
        ctx.body = shared.data;
        await next();
        return;
      }
      if (previous) {
        ctx.body = previous;
        await next();
        return;
      }
      if (!scannerHost) ctx.throw(503, 'Bộ quét tệp chưa sẵn sàng.');
      const clean = await scanWithClamd(input.content, scannerHost).catch(() => ctx.throw(503, 'Bộ quét tệp chưa sẵn sàng.'));
      if (!clean) ctx.throw(409, 'Tệp bị bộ quét từ chối.');
      ctx.body = await withRequest(ctx, 'POST', 'update', async scope => {
        const { id, actor, transaction } = scope;
        const [inserted] = await query(`INSERT INTO lattice_native_request_attachments
          (id, request_id, organization_id, uploader_id, idempotency_key, filename, content)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (request_id, organization_id, uploader_id, idempotency_key) DO NOTHING
          RETURNING ${metadata}`,
        [randomUUID(), id, actor.organizationId, actor.userId, input.key, input.filename, input.content], transaction);
        ctx.status = inserted ? 201 : 200;
        return inserted ?? existing(scope);
      });
      await next();
    },
    async download(ctx, next) {
      const fileId = ctx.query.fileId;
      if (typeof fileId !== 'string' || !uuid.test(fileId)) ctx.throw(400, 'Mã tệp không hợp lệ.');
      const file = await withRequest(ctx, 'GET', 'view', async scope => {
        const { id, actor, transaction } = scope;
        if (await useShared(scope)) return sharedFiles(ctx, 'download', scope, { fileId });
        const [local] = await query(`SELECT filename, content FROM lattice_native_request_attachments
          WHERE request_id = $1 AND organization_id = $2 AND id = $3`,
        [id, actor.organizationId, fileId], transaction);
        return local;
      });
      if (!file) ctx.throw(404, 'Không tìm thấy tệp.');
      ctx.set('Cache-Control', 'private, no-store');
      ctx.set('X-Content-Type-Options', 'nosniff');
      if (file.disposition) ctx.set('Content-Disposition', file.disposition);
      else ctx.attachment(file.filename);
      ctx.type = 'application/octet-stream';
      ctx.body = file.content;
      await next();
    },
    async submit(ctx, next) {
      ctx.body = await withRequest(ctx, 'POST', 'view', async ({ id, actor, transaction, request }) => {
        if (actor.organizationId !== submitOrganization || String(request.get('requesterId')) !== String(actor.employeeId)) {
          ctx.throw(403, 'Không có quyền gửi yêu cầu.');
        }
        const status = request.get('status');
        if (['submitted', 'approved', 'rejected', 'assigned', 'completed'].includes(status)) return { id, status };
        if (status !== 'draft') ctx.throw(409, 'Không thể gửi ở trạng thái hiện tại.');
        await checkRequestPermission(ctx, id, actor, transaction, 'update');
        await uploads.assertSettled(ctx, { id, actor, transaction });
        await db.getRepository(requestCollection).update({
          filterByTk: id, values: { status: 'submitted' }, individualHooks: true, transaction, context: ctx,
        });
        return { id, status: 'submitted' };
      }, true);
      await next();
    },
  } });
  app.acl.allow(resource, ['list', 'upload', 'download', 'submit'], 'loggedIn');
}

module.exports = { registerNativeRequestAttachments };
