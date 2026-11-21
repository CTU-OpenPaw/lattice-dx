/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

async function resolveSearchableTargets(db, requestedCollections, SEARCHABLE_COLLECTIONS, CUSTOM_COLLECTION_RE, val) {
  const dynamicCustom = [];
  const colsRepo = db?.getRepository?.('collections');
  if (colsRepo) {
    const rows = (await colsRepo.find({ limit: 200 })) || [];
    for (const r of rows) {
      const name = val(r, 'name');
      if (CUSTOM_COLLECTION_RE.test(name) && !dynamicCustom.includes(name)) dynamicCustom.push(name);
    }
  }
  const allAllowed = [...new Set([...SEARCHABLE_COLLECTIONS, ...dynamicCustom])];
  if (Array.isArray(requestedCollections) && requestedCollections.length) {
    return requestedCollections.filter((c) => allAllowed.includes(c));
  }
  return allAllowed;
}

async function enforceCallerRbacOnWrite(db, actor, collection, operation, safeValues, { failTool, val, WRITABLE_BUSINESS_COLLECTIONS, CUSTOM_COLLECTION_RE }) {
  const isCustom = CUSTOM_COLLECTION_RE.test(collection);
  if (!WRITABLE_BUSINESS_COLLECTIONS.has(collection) && !isCustom) {
    throw failTool('COLLECTION_WRITE_FORBIDDEN', 403, `Không được phép ghi vào collection "${collection}".`);
  }
  if (actor.isAdmin) return;

  const resourcesRepo = db?.getRepository?.('dataSourcesRolesResources');
  if (!resourcesRepo) return;

  const colPolicies = (await resourcesRepo.find({ filter: { name: collection, dataSourceKey: 'main' }, appends: ['actions'], limit: 50 })) || [];
  if (!colPolicies.length) return;

  const roleSet = new Set(actor.roleNames || []);
  const callerPolicies = colPolicies.filter((p) => roleSet.has(val(p, 'roleName')));
  if (!callerPolicies.length) {
    throw failTool('RBAC_ACTION_DENIED', 403, `Vai trò hiện tại không có quyền thao tác trên "${collection}".`);
  }

  let hasActionGrant = false;
  const allowedFields = new Set();
  let unrestrictedFields = false;
  for (const policy of callerPolicies) {
    const actions = val(policy, 'actions') || [];
    const matched = actions.find((a) => val(a, 'name') === operation);
    if (!matched) continue;
    hasActionGrant = true;
    const fields = val(matched, 'fields');
    if (Array.isArray(fields) && fields.length) {
      for (const f of fields) allowedFields.add(f);
    } else {
      unrestrictedFields = true;
    }
  }
  if (!hasActionGrant) {
    throw failTool('RBAC_ACTION_DENIED', 403, `Vai trò hiện tại không có quyền "${operation}" trên "${collection}".`);
  }
  if (!unrestrictedFields) {
    const locked = Object.keys(safeValues).filter((k) => !allowedFields.has(k));
    if (locked.length) {
      throw failTool('RBAC_FIELD_LOCKED', 403, `Trường bị khóa theo phân quyền RBAC trên "${collection}": ${locked.join(', ')}.`);
    }
  }
}

async function performScopedRecordWrite(db, actor, collection, operation, { recordId, values }, deps) {
  const { failTool, val, PROTECTED_SERVER_FIELDS } = deps;
  const repo = db?.getRepository?.(collection);
  if (!repo) throw failTool('COLLECTION_NOT_FOUND', 404, `Collection "${collection}" chưa sẵn sàng.`);

  const safeValues = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (!PROTECTED_SERVER_FIELDS.has(k)) safeValues[k] = v;
  }
  await enforceCallerRbacOnWrite(db, actor, collection, operation, safeValues, deps);

  if (operation === 'create') {
    if (!actor.isAdmin && !actor.employeeId) {
      throw failTool('EMPLOYEE_BINDING_REQUIRED', 403, 'Cần hồ sơ latticeEmployees để tạo bản ghi nghiệp vụ.');
    }
    const created = await repo.create({
      values: {
        ...safeValues,
        organizationId: actor.organizationId,
        ...(collection === 'latticeParaDocuments'
          ? { ...(actor.employeeId ? { ownerId: actor.employeeId } : {}), status: safeValues.status || 'active' }
          : { ...(actor.employeeId ? { requesterId: actor.employeeId } : {}), status: 'draft', version: 1 }),
      },
    });
    const plain = typeof created?.toJSON === 'function' ? created.toJSON() : created;
    return { operation: 'create', collection, record: plain };
  }

  if (recordId == null) throw failTool('RECORD_ID_REQUIRED', 400, 'Cần recordId để cập nhật.');
  const existing = await repo.findOne({ filterByTk: recordId });
  if (!existing || val(existing, 'organizationId') !== actor.organizationId) {
    throw failTool('RECORD_NOT_FOUND_OR_FORBIDDEN', 403, 'Không tìm thấy bản ghi trong phạm vi tổ chức của bạn.');
  }
  await existing.update(safeValues);
  return { operation: 'update', collection, recordId, updatedFields: Object.keys(safeValues) };
}

function summarizeModuleRows(rows, val) {
  const byStatus = {};
  for (const r of rows) {
    const st = String(val(r, 'status') || 'unknown');
    byStatus[st] = (byStatus[st] || 0) + 1;
  }
  return { total: rows.length, byStatus };
}

function createCopilotTools(deps) {
  const {
    val, failTool, invokeResourceAction, createAuditedTool,
    WRITABLE_BUSINESS_COLLECTIONS, SEARCHABLE_COLLECTIONS, CUSTOM_COLLECTION_RE,
  } = deps;

  return [
    createAuditedTool({
      name: 'dxos_search_enterprise_context',
      adminOnly: false,
      defaultPermission: 'ALLOW',
      introduction: { title: 'Tra cứu Ngữ cảnh Doanh nghiệp', about: 'Tìm kiếm đơn hàng, yêu cầu, sự cố, tài sản, SOP P.A.R.A. và cả phân hệ latticeCustom*.' },
      description: 'Search across organization-scoped business collections and dynamic latticeCustom* modules with record citations.',
      schema: {
        description: 'Organization-scoped cross-collection search.',
        properties: {
          query: { type: 'string', maxLength: 120, description: 'Optional keyword matched against title, name, or code.' },
          collections: { type: 'array', items: { type: 'string' }, description: 'Subset of business or latticeCustom* collections.' },
          limit: { type: 'integer', default: 8 },
        },
      },
      async run(_ctx, db, actor, args) {
        const targets = await resolveSearchableTargets(db, args.collections, SEARCHABLE_COLLECTIONS, CUSTOM_COLLECTION_RE, val);
        const limit = Math.max(1, Math.min(30, Number(args.limit) || 8));
        const items = [];
        const q = String(args.query || '').trim().toLowerCase();
        for (const colName of targets) {
          const repo = db?.getRepository?.(colName);
          if (!repo) continue;
          const rows = (await repo.find({ filter: { organizationId: actor.organizationId }, limit: 25, sort: ['-id'] })) || [];
          for (const row of rows) {
            const label = String(val(row, 'name') || val(row, 'title') || val(row, 'code') || '');
            const code = String(val(row, 'code') || val(row, 'id') || '');
            const hay = `${label} ${code} ${val(row, 'summary') || ''} ${val(row, 'batchCode') || ''}`.toLowerCase();
            if (q && !hay.includes(q)) continue;
            items.push({
              collection: colName,
              id: val(row, 'id'),
              code,
              title: label,
              status: val(row, 'status') || val(row, 'paraSpace') || null,
              citation: `[${colName}:${code}#${val(row, 'id')}]`,
            });
            if (items.length >= limit) break;
          }
          if (items.length >= limit) break;
        }
        return { organizationId: actor.organizationId, searchedCollections: targets, count: items.length, items };
      },
    }),

    createAuditedTool({
      name: 'dxos_execute_record_action',
      adminOnly: false,
      defaultPermission: 'ASK',
      introduction: { title: 'Thực thi Hồ sơ Hệ thống', about: 'Tạo/cập nhật bản ghi nghiệp vụ & latticeCustom* đúng tổ chức và kiểm soát trường bị khóa RBAC.' },
      description: 'Create or update an allowed business or dynamic latticeCustom* record enforcing server organizationId, protected field stripping, and field-level RBAC.',
      schema: {
        description: 'Validated business write action.',
        properties: {
          collection: { type: 'string', required: true, maxLength: 60 },
          operation: { type: 'string', required: true, enum: ['create', 'update'] },
          recordId: { type: 'integer' },
          values: { type: 'object', required: true },
        },
      },
      async run(_ctx, db, actor, args) {
        return performScopedRecordWrite(db, actor, args.collection, args.operation, { recordId: args.recordId, values: args.values }, deps);
      },
    }),

    createAuditedTool({
      name: 'dxos_my_tasks_copilot',
      adminOnly: false,
      defaultPermission: 'ASK',
      introduction: { title: 'Copilot Quy trình Dài', about: 'Đọc các manual task được giao cho chính bạn và hỗ trợ xử lý đúng thẩm quyền.' },
      description: 'List/analyze pending manual workflow tasks assigned to the current caller, or submit their own assigned task (never approves own requests or another user task).',
      schema: {
        description: 'Personal workflow task copilot operation.',
        properties: {
          action: { type: 'string', required: true, enum: ['list', 'analyze', 'submit'] },
          taskId: { type: 'integer' },
          formKey: { type: 'string', maxLength: 60 },
          decision: { type: 'string', maxLength: 40 },
          note: { type: 'string', maxLength: 500 },
        },
      },
      async run(ctx, db, actor, args) {
        const taskRepo = db?.getRepository?.('workflowManualTasks');
        if (!taskRepo) throw failTool('WORKFLOW_TASKS_UNAVAILABLE', 503, 'Dịch vụ workflowManualTasks chưa sẵn sàng.');
        if (args.action === 'list' || args.action === 'analyze') {
          const rows = (await taskRepo.find({ filter: { userId: actor.userId, status: 0 }, appends: ['node', 'execution'], limit: 20, sort: ['-id'] })) || [];
          return {
            userId: actor.userId,
            pendingCount: rows.length,
            tasks: rows.map((t) => ({
              taskId: val(t, 'id'),
              nodeTitle: val(val(t, 'node'), 'title') || null,
              recordCode: val(t, 'execution')?.context?.data?.code || null,
              status: val(t, 'status'),
            })),
          };
        }
        if (!args.taskId) throw failTool('TASK_ID_REQUIRED', 400, 'Cần taskId để nộp bước công việc.');
        const task = await taskRepo.findOne({ filterByTk: args.taskId, appends: ['node', 'execution'] });
        if (!task || Number(val(task, 'userId')) !== Number(actor.userId)) {
          throw failTool('TASK_NOT_ASSIGNED_TO_CALLER', 403, 'Chỉ người được giao task mới có quyền xử lý bước này.');
        }
        if (Number(val(task, 'status')) !== 0) {
          throw failTool('TASK_ALREADY_RESOLVED', 409, 'Công việc này đã được xử lý trước đó.');
        }
        const ctxData = val(task, 'execution')?.context?.data || {};
        const nodeTitle = String(val(val(task, 'node'), 'title') || '').toLowerCase();
        if (actor.employeeId && Number(ctxData.requesterId) === Number(actor.employeeId) && /duyệt|approve|review/i.test(nodeTitle)) {
          throw failTool('SELF_APPROVAL_FORBIDDEN', 403, 'Không được phép tự phê duyệt hồ sơ do chính mình khởi tạo.');
        }
        const formKey = args.formKey || 'review';
        const submitValues = { result: { [formKey]: args.note ? { note: args.note, deliveryNote: args.note, vehicleNote: args.note } : {}, _: args.decision || 'approve' } };
        await invokeResourceAction(ctx, 'workflowManualTasks', 'submit', { filterByTk: args.taskId, values: submitValues });
        return { submitted: true, taskId: args.taskId, formKey, decision: args.decision || 'approve' };
      },
    }),

    createAuditedTool({
      name: 'dxos_orchestrate_enterprise_case',
      adminOnly: false,
      defaultPermission: 'ASK',
      introduction: { title: 'Điều phối Liên phòng ban 360°', about: 'Radar điểm nghẽn, gom ngữ cảnh đa phân hệ + P.A.R.A. và phối hợp tạo chuỗi hồ sơ liên thông.' },
      description: 'Cross-department copilot: run org-wide operational bottleneck radar, correlate incidents/SOPs/assets/tasks, or execute a coordinated multi-record response enforcing field-level RBAC.',
      schema: {
        description: 'Cross-department case orchestration input.',
        properties: {
          mode: { type: 'string', required: true, enum: ['radar', 'correlateCase', 'executeCoordinatedResponse'] },
          query: { type: 'string', maxLength: 120 },
          primaryRecord: { type: 'object', description: 'Optional { collection, values } primary operational or custom record.' },
          followUpTicket: { type: 'object', description: 'Optional latticeServiceTickets payload linked to the case.' },
          paraHandoverNote: { type: 'object', description: 'Optional latticeParaDocuments handover note linked to primaryRecord.' },
          dryRun: { type: 'boolean', default: false },
        },
      },
      async run(_ctx, db, actor, args) {
        const targets = await resolveSearchableTargets(db, null, SEARCHABLE_COLLECTIONS, CUSTOM_COLLECTION_RE, val);

        if (args.mode === 'radar') {
          const modules = {};
          for (const colName of targets) {
            const repo = db?.getRepository?.(colName);
            if (!repo) continue;
            const rows = (await repo.find({ filter: { organizationId: actor.organizationId }, limit: 100 })) || [];
            modules[colName] = summarizeModuleRows(rows, val);
          }
          const taskRepo = db?.getRepository?.('workflowManualTasks');
          const pendingTasks = taskRepo ? ((await taskRepo.find({ filter: { userId: actor.userId, status: 0 }, limit: 50 })) || []) : [];
          return {
            mode: 'radar',
            organizationId: actor.organizationId,
            moduleCount: Object.keys(modules).length,
            modules,
            pendingManualTasks: pendingTasks.length,
          };
        }

        if (args.mode === 'correlateCase') {
          const q = String(args.query || '').trim().toLowerCase();
          const matchRow = (r, extraTokens = []) => {
            if (!q) return true;
            const hay = [
              val(r, 'code'), val(r, 'name'), val(r, 'title'), val(r, 'summary'),
              val(r, 'description'), val(r, 'assetEntityId'), val(r, 'warehouseZone'),
            ].filter(Boolean).join(' ').toLowerCase();
            if (hay.includes(q)) return true;
            return extraTokens.some((tok) => tok && hay.includes(tok));
          };
          const pick = async (col, extraTokens = []) => {
            const repo = db?.getRepository?.(col);
            if (!repo) return [];
            const rows = (await repo.find({ filter: { organizationId: actor.organizationId }, limit: 25, sort: ['-id'] })) || [];
            return rows.filter((r) => matchRow(r, extraTokens)).slice(0, 5).map((r) => ({
              id: val(r, 'id'),
              code: val(r, 'code') || String(val(r, 'id')),
              title: val(r, 'name') || val(r, 'title') || val(r, 'code'),
              status: val(r, 'status') || val(r, 'severity') || null,
              assetEntityId: val(r, 'assetEntityId') || null,
              citation: `[${col}:${val(r, 'code') || val(r, 'id')}#${val(r, 'id')}]`,
            }));
          };
          const [assets, sops] = await Promise.all([pick('latticeAssets'), pick('latticeParaDocuments')]);
          const assetTokens = assets.flatMap((a) => {
            const parts = String(a.code || '').toLowerCase().split(/[-_\s]+/).filter((p) => p.length >= 2);
            return [String(a.code || '').toLowerCase(), ...parts];
          });
          const [incidents, tickets] = await Promise.all([
            pick('latticeIncidentCases', assetTokens),
            pick('latticeServiceTickets', assetTokens),
          ]);
          return { mode: 'correlateCase', organizationId: actor.organizationId, query: args.query || '', incidents, sops, assets, tickets };
        }

        // executeCoordinatedResponse
        if (args.dryRun) {
          return {
            dryRun: true,
            mode: 'executeCoordinatedResponse',
            organizationId: actor.organizationId,
            planned: {
              primaryCollection: args.primaryRecord?.collection || null,
              createFollowUpTicket: Boolean(args.followUpTicket),
              createParaHandoverNote: Boolean(args.paraHandoverNote),
            },
          };
        }

        const created = {};
        if (args.primaryRecord?.collection) {
          created.primary = await performScopedRecordWrite(
            db,
            actor,
            args.primaryRecord.collection,
            'create',
            { values: args.primaryRecord.values || {} },
            deps,
          );
        }
        if (args.followUpTicket) {
          const primaryCitation = created.primary?.record ? `[${created.primary.collection}:${created.primary.record.code || created.primary.record.id}#${created.primary.record.id}]` : '';
          const ticketValues = {
            serviceType: 'facilities',
            priority: 'high',
            ...args.followUpTicket,
            ...(primaryCitation ? { description: `${args.followUpTicket.description || ''} | Liên kết: ${primaryCitation}`.trim() } : {}),
          };
          created.followUpTicket = (await performScopedRecordWrite(db, actor, 'latticeServiceTickets', 'create', { values: ticketValues }, deps)).record;
        }
        if (args.paraHandoverNote) {
          const noteValues = {
            paraSpace: 'projects',
            ...args.paraHandoverNote,
            ...(created.primary?.record ? { relatedCollection: created.primary.collection, relatedRecordId: String(created.primary.record.id) } : {}),
          };
          created.paraHandoverNote = (await performScopedRecordWrite(db, actor, 'latticeParaDocuments', 'create', { values: noteValues }, deps)).record;
        }
        return { executed: true, mode: 'executeCoordinatedResponse', organizationId: actor.organizationId, created };
      },
    }),
  ];
}

module.exports = { createCopilotTools };
