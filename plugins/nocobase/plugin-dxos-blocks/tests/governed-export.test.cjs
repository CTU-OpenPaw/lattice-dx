/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

function extractStoreZipEntries(buf) {
  assert.equal(buf.subarray(0, 4).toString('binary'), 'PK\x03\x04');
  const entries = new Map();
  let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const nameStart = off + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const name = buf.subarray(nameStart, nameStart + nameLen).toString('utf8');
    const data = buf.subarray(dataStart, dataStart + compSize);
    entries.set(name, data);
    off = dataStart + compSize;
  }
  return entries;
}

function makeExportHarness() {
  const employees = [
    { id: 10, userId: 101, organizationId: 'org-a', active: true },
    { id: 20, userId: 201, organizationId: 'org-b', active: true },
  ];
  const requests = [
    {
      id: 1,
      organizationId: 'org-a',
      code: 'REQ-A1',
      name: '=CMD|" /C calc"!A0 Kho lạnh',
      status: 'submitted',
      description: 'Nhiệt độ đo -18.5 °C',
      customer: 'Bệnh viện A',
      amount: -18.5,
      decisionReason: 'Bí mật duyệt nội bộ',
      identitySubject: 'sub-secret-123',
      passwordHash: 'hash-secret',
    },
    {
      id: 2,
      organizationId: 'org-b',
      code: 'REQ-B1',
      name: 'Foreign org request',
      status: 'draft',
      description: 'Org B private',
    },
  ];
  const match = (row, filter = {}) => Object.entries(filter).every(([k, cond]) => {
    if (k === '$and' && Array.isArray(cond)) return cond.every((sub) => match(row, sub));
    return row[k] === cond;
  });
  const db = {
    getRepository(name) {
      if (name === 'latticeEmployees') {
        return { find: async ({ filter }) => employees.filter((e) => match(e, filter)) };
      }
      if (name === 'roles') {
        return {
          findOne: async ({ filter }) => ({
            name: filter.name,
            allowAll: false,
            strategy: { actions: [] },
          }),
        };
      }
      if (name === 'dataSourcesRolesResources') {
        return {
          findOne: async ({ filter }) => ({
            roleName: filter.roleName,
            name: filter.name,
            usingActionsConfig: true,
            actions: [
              { name: 'view', fields: ['code', 'name', 'status', 'description', 'amount'] },
              { name: 'list', fields: ['code', 'name', 'status'] },
            ],
          }),
        };
      }
      if (name === 'latticeRequests') {
        return {
          find: async ({ filter, limit = 50 }) => requests.filter((r) => match(r, filter)).slice(0, limit),
        };
      }
      return null;
    },
  };
  return { db };
}

test('sanitizeFormulaCell neutralizes dangerous leading spreadsheet characters while preserving finite negative numbers', () => {
  const { sanitizeFormulaCell } = require('../src/server/governed-export');
  assert.equal(sanitizeFormulaCell(-18.5), -18.5);
  assert.equal(sanitizeFormulaCell('=1+1'), "'=1+1");
  assert.equal(sanitizeFormulaCell('+SUM(A1)'), "'+SUM(A1)");
  assert.equal(sanitizeFormulaCell('-10+A1'), "'-10+A1");
  assert.equal(sanitizeFormulaCell('@evil'), "'@evil");
  assert.equal(sanitizeFormulaCell('\t=CMD'), "'\t=CMD");
  assert.equal(sanitizeFormulaCell('\r=CMD'), "'\r=CMD");
  assert.equal(sanitizeFormulaCell('Kho lạnh A1'), 'Kho lạnh A1');
});

test('dxosBlocks:exportReport enforces column-level RBAC, denies all-forbidden requests 403, blocks formula injection, and outputs valid CSV/XLSX/PDF', async () => {
  const { createDxosBlocksActions } = require('../src/server/blocks-api');
  const { db } = makeExportHarness();
  const actions = createDxosBlocksActions(db, {});

  const empCtx = (params, method = 'POST') => ({
    method,
    headers: {},
    set(k, v) { this.headers[k] = v; },
    state: { currentUser: { id: 101, username: 'alice' }, currentRole: 'ldx_employee' },
    action: { params },
  });

  // 1. Disallowed collection blocked
  await assert.rejects(
    () => actions.exportReport(empCtx({ collection: 'users', format: 'csv' }), async () => {}),
    (err) => err.status === 400 || err.status === 403,
  );

  // 2. Requesting ONLY restricted/sensitive columns -> 403 EXPORT_FIELDS_FORBIDDEN
  await assert.rejects(
    () => actions.exportReport(
      empCtx({ values: { collection: 'latticeRequests', format: 'csv', fields: ['decisionReason', 'identitySubject', 'passwordHash'] } }),
      async () => {},
    ),
    (err) => err.status === 403 && err.code === 'EXPORT_FIELDS_FORBIDDEN',
  );

  // 3. Mixed allowed + restricted/sensitive columns -> strips restricted/sensitive, scopes to org-a, neutralizes =CMD in CSV
  const csvCtx = empCtx({
    values: {
      collection: 'latticeRequests',
      format: 'csv',
      fields: ['code', 'name', 'amount', 'decisionReason', 'identitySubject'],
    },
  });
  await actions.exportReport(csvCtx, async () => {});
  assert.deepEqual(csvCtx.body.columns, ['code', 'name', 'amount']);
  assert.deepEqual(csvCtx.body.omittedColumns, ['decisionReason', 'identitySubject']);
  assert.equal(csvCtx.body.rowCount, 1);
  const csvText = Buffer.from(csvCtx.body.contentBase64, 'base64').toString('utf8');
  assert.equal(csvText.startsWith('\uFEFF'), true);
  assert.ok(csvText.includes("'=CMD"));
  assert.ok(csvText.includes('REQ-A1'));
  assert.equal(csvText.includes('REQ-B1'), false);
  assert.equal(csvText.includes('sub-secret-123'), false);

  // 4. Native XLSX contains valid ZIP PK\x03\x04 + xl/worksheets/sheet1.xml with Vietnamese UTF-8
  const xlsxCtx = empCtx({
    values: {
      collection: 'latticeRequests',
      format: 'xlsx',
      fields: ['code', 'name', 'description', 'amount'],
    },
  });
  await actions.exportReport(xlsxCtx, async () => {});
  const xlsxBuf = Buffer.from(xlsxCtx.body.contentBase64, 'base64');
  const zipMap = extractStoreZipEntries(xlsxBuf);
  assert.ok(zipMap.has('[Content_Types].xml'));
  assert.ok(zipMap.has('xl/workbook.xml'));
  assert.ok(zipMap.has('xl/worksheets/sheet1.xml'));
  const sheetXml = zipMap.get('xl/worksheets/sheet1.xml').toString('utf8');
  assert.ok(sheetXml.includes('Kho lạnh'));
  assert.ok(sheetXml.includes('<v>-18.5</v>'));

  // 5. Binary download mode + PDF format
  const pdfCtx = empCtx({
    values: {
      collection: 'latticeRequests',
      format: 'pdf',
      fields: ['code', 'name', 'status'],
      download: true,
    },
  });
  await actions.exportReport(pdfCtx, async () => {});
  assert.equal(Buffer.isBuffer(pdfCtx.body), true);
  const pdfText = pdfCtx.body.toString('latin1');
  assert.equal(pdfText.startsWith('%PDF-1.4'), true);
  assert.ok(pdfText.includes('xref'));
  assert.ok(pdfText.trim().endsWith('%%EOF'));
  assert.match(String(pdfCtx.headers['Content-Disposition'] || ''), /\.pdf"/);
  assert.match(String(pdfCtx.headers['X-Lattice-Export-Columns'] || ''), /code,name,status/);

  // 6. Verify unsafe filter rejected
  await assert.rejects(
    () => actions.exportReport(
      empCtx({ values: { collection: 'latticeRequests', format: 'csv', filter: { $where: '1=1' } } }),
      async () => {},
    ),
    (err) => err.status === 403 || err.status === 400,
  );
});

test('buildXlsxBuffer generates styled xl/styles.xml, navy header fill, grid borders, column widths, and frozen header row', () => {
  const { buildXlsxBuffer } = require('../src/server/governed-export');
  const buf = buildXlsxBuffer(
    ['code', 'name', 'amount'],
    [{ code: 'REQ-01', name: 'Kho lạnh Vaccine Trung tâm 01', amount: 42 }],
    { sheetName: 'latticeRequests' },
  );
  const zipMap = extractStoreZipEntries(buf);
  assert.ok(zipMap.has('xl/styles.xml'), 'XLSX must include xl/styles.xml');
  const contentTypes = zipMap.get('[Content_Types].xml').toString('utf8');
  assert.ok(contentTypes.includes('/xl/styles.xml'));
  assert.ok(contentTypes.includes('spreadsheetml.styles+xml'));
  const wbRels = zipMap.get('xl/_rels/workbook.xml.rels').toString('utf8');
  assert.ok(wbRels.includes('styles.xml'));

  const stylesXml = zipMap.get('xl/styles.xml').toString('utf8');
  assert.ok(stylesXml.includes('1E3A5F') || stylesXml.includes('1e3a5f'), 'Navy header fill expected');
  assert.ok(stylesXml.includes('<borders'), 'Grid borders expected');

  const sheetXml = zipMap.get('xl/worksheets/sheet1.xml').toString('utf8');
  assert.ok(sheetXml.includes('<sheetViews>'));
  assert.ok(sheetXml.includes('ySplit="1"'));
  assert.ok(sheetXml.includes('state="frozen"'));
  assert.ok(sheetXml.includes('<cols>'));
  assert.ok(sheetXml.includes('s="1"'), 'Header cells should reference style s="1"');
});

test('Vietnamese Unicode TTF PDF embeds CIDFontType2 + ToUnicode CMap and falls back cleanly when font/Gotenberg unavailable', async () => {
  const {
    findUnicodeFontPath,
    buildUnicodePdfBuffer,
    renderGotenbergPdf,
    executeGovernedExport,
  } = require('../src/server/governed-export');

  assert.equal(typeof findUnicodeFontPath, 'function');
  assert.equal(typeof buildUnicodePdfBuffer, 'function');
  assert.equal(typeof renderGotenbergPdf, 'function');

  const fontPath = findUnicodeFontPath();
  assert.ok(fontPath, 'Expected a system TrueType font to exist for test verification');

  const { db } = makeExportHarness();
  const viRows = [{
    id: 1,
    organizationId: 'org-a',
    code: 'VN-01',
    name: 'Kho lạnh ă â đ ê ô ơ ư ế ồ ậ',
    status: 'approved',
  }];
  const viDb = {
    getRepository(name) {
      if (name === 'latticeRequests') {
        return { find: async () => viRows };
      }
      return db.getRepository(name);
    },
  };
  const ctx = {
    state: { currentUser: { id: 101, username: 'alice' }, currentRole: 'ldx_employee' },
  };
  const actor = { userId: '101', employeeId: 10, organizationId: 'org-a' };

  const prevGotenberg = process.env.DXOS_GOTENBERG_URL;
  delete process.env.DXOS_GOTENBERG_URL;
  try {
    const res = await executeGovernedExport(
      viDb,
      ctx,
      { collection: 'latticeRequests', format: 'pdf', fields: ['code', 'name', 'status'] },
      { isRoot: false, actor },
    );
    assert.equal(res.pdfUnicodeMode, 'truetype-cid');
    const pdfRaw = res.buffer.toString('latin1');
    assert.ok(pdfRaw.startsWith('%PDF-1.4'));
    assert.ok(pdfRaw.includes('/Subtype /Type0'));
    assert.ok(pdfRaw.includes('/Encoding /Identity-H'));
    assert.ok(pdfRaw.includes('/Subtype /CIDFontType2'));
    assert.ok(pdfRaw.includes('/FontFile2'));
    assert.ok(pdfRaw.includes('/ToUnicode'));
    assert.ok(pdfRaw.includes('beginbfchar'));
    assert.ok(pdfRaw.includes('endbfchar'));
    // Verify UTF-16 code points for ă (0103), đ (0111), ế (1EBF), ồ (1ED3), ậ (1EAD) appear in ToUnicode CMap
    const upper = pdfRaw.toUpperCase();
    for (const hex of ['0103', '0111', '1EBF', '1ED3', '1EAD']) {
      assert.ok(upper.includes(`<${hex}>`), `ToUnicode CMap must preserve UTF-16 <${hex}>`);
    }

    // ASCII fallback when TTF disabled/missing
    const asciiRes = await executeGovernedExport(
      viDb,
      ctx,
      { collection: 'latticeRequests', format: 'pdf', fields: ['code', 'name', 'status'] },
      { isRoot: false, actor, fontPath: null },
    );
    assert.equal(asciiRes.pdfUnicodeMode, 'ascii-fallback');
    assert.ok(asciiRes.buffer.toString('latin1').includes('/BaseFont /Helvetica'));

    // Gotenberg credential URL rejected + valid URL used + failure falls back to truetype-cid
    let fetchCalls = 0;
    process.env.DXOS_GOTENBERG_URL = 'http://user:secret@gotenberg.local:3000';
    const credFallback = await executeGovernedExport(
      viDb,
      ctx,
      { collection: 'latticeRequests', format: 'pdf', fields: ['code', 'name'] },
      {
        isRoot: false,
        actor,
        fetchImpl: async () => { fetchCalls += 1; throw new Error('Should not call fetch for credential URL'); },
      },
    );
    assert.equal(fetchCalls, 0);
    assert.equal(credFallback.pdfUnicodeMode, 'truetype-cid');

    process.env.DXOS_GOTENBERG_URL = 'http://gotenberg.local:3000/base/?token=ignore#frag';
    const gotenbergOk = await executeGovernedExport(
      viDb,
      ctx,
      { collection: 'latticeRequests', format: 'pdf', fields: ['code', 'name'] },
      {
        isRoot: false,
        actor,
        fetchImpl: async (url, init) => {
          fetchCalls += 1;
          assert.equal(url, 'http://gotenberg.local:3000/base/forms/chromium/convert/html');
          assert.equal(init.method, 'POST');
          return new Response(Buffer.from('%PDF-1.4\n%Gotenberg\n%%EOF\n', 'latin1'), { status: 200 });
        },
      },
    );
    assert.equal(fetchCalls, 1);
    assert.equal(gotenbergOk.pdfUnicodeMode, 'gotenberg');
    assert.ok(gotenbergOk.buffer.toString('latin1').includes('%Gotenberg'));

    const gotenbergFailFallback = await executeGovernedExport(
      viDb,
      ctx,
      { collection: 'latticeRequests', format: 'pdf', fields: ['code', 'name'] },
      {
        isRoot: false,
        actor,
        fetchImpl: async () => new Response('boom', { status: 503 }),
      },
    );
    assert.equal(gotenbergFailFallback.pdfUnicodeMode, 'truetype-cid');
  } finally {
    if (prevGotenberg === undefined) delete process.env.DXOS_GOTENBERG_URL;
    else process.env.DXOS_GOTENBERG_URL = prevGotenberg;
  }
});

test('executeGovernedExport paginates in 1000-row batches up to 10000 rows', async () => {
  const { executeGovernedExport } = require('../src/server/governed-export');
  const { db } = makeExportHarness();
  const totalRows = Array.from({ length: 2500 }, (_, i) => ({
    id: i + 1,
    organizationId: 'org-a',
    code: `REQ-${i + 1}`,
    name: `Mục ${i + 1}`,
    status: 'draft',
  }));
  const findCalls = [];
  const paginatedDb = {
    getRepository(name) {
      if (name === 'latticeRequests') {
        return {
          find: async ({ limit, offset = 0 }) => {
            findCalls.push({ limit, offset });
            return totalRows.slice(offset, offset + limit);
          },
        };
      }
      return db.getRepository(name);
    },
  };
  const res = await executeGovernedExport(
    paginatedDb,
    { state: { currentUser: { id: 101, username: 'alice' }, currentRole: 'ldx_employee' } },
    { collection: 'latticeRequests', format: 'csv', fields: ['code', 'name'], limit: 2500 },
    { isRoot: false, actor: { userId: '101', employeeId: 10, organizationId: 'org-a' } },
  );
  assert.equal(res.rowCount, 2500);
  assert.deepEqual(findCalls, [
    { limit: 1000, offset: 0 },
    { limit: 1000, offset: 1000 },
    { limit: 500, offset: 2000 },
  ]);
});

test('Task 7: resolveAllowedExportColumns and executeGovernedExport inspect db.getCollection(collection)?.fields for latticeCustom* while stripping sensitive/virtual fields and honoring RBAC', async () => {
  const { resolveAllowedExportColumns, executeGovernedExport } = require('../src/server/governed-export');

  const customRows = [
    {
      id: 1,
      organizationId: 'org-a',
      code: 'MNT-01',
      equipmentName: 'Máy nén A1',
      priority: 'high',
      status: 'reported',
      apiKeyHash: 'secret-hash-val',
      virtualSummary: 'ignored-virtual',
    },
    {
      id: 2,
      organizationId: 'org-b',
      code: 'MNT-B2',
      equipmentName: 'Foreign Org B',
      priority: 'low',
      status: 'reported',
    },
  ];

  const customCollection = {
    name: 'latticeCustomMaintenanceOrders',
    fields: new Map([
      ['id', { name: 'id', type: 'bigInt' }],
      ['code', { name: 'code', type: 'string' }],
      ['equipmentName', { name: 'equipmentName', type: 'string' }],
      ['priority', { name: 'priority', type: 'string' }],
      ['status', { name: 'status', type: 'string' }],
      ['virtualSummary', { name: 'virtualSummary', type: 'virtual' }],
      ['assignee', { name: 'assignee', type: 'belongsTo', target: 'latticeEmployees', foreignKey: 'assigneeId' }],
      ['lines', { name: 'lines', type: 'hasMany', target: 'latticeCustomLines', foreignKey: 'orderId' }],
      ['apiKeyHash', { name: 'apiKeyHash', type: 'string' }],
      ['organizationId', { name: 'organizationId', type: 'string' }],
    ]),
  };

  let restrictedRoleFields = null;
  const db = {
    getCollection: (name) => (name === 'latticeCustomMaintenanceOrders' ? customCollection : null),
    getRepository(name) {
      if (name === 'roles') {
        return { findOne: async ({ filter }) => ({ name: filter.name, allowAll: false }) };
      }
      if (name === 'dataSourcesRolesResources') {
        return {
          findOne: async ({ filter }) => (restrictedRoleFields
            ? {
                roleName: filter.roleName,
                name: filter.name,
                usingActionsConfig: true,
                actions: [{ name: 'view', fields: restrictedRoleFields }],
              }
            : { roleName: filter.roleName, name: filter.name, usingActionsConfig: false }),
        };
      }
      if (name === 'latticeCustomMaintenanceOrders') {
        return {
          find: async ({ filter }) => customRows.filter((r) => !filter?.organizationId || r.organizationId === filter.organizationId),
        };
      }
      return null;
    },
  };

  const ctx = { state: { currentUser: { id: 101, username: 'alice' }, currentRole: 'ldx_operator' } };
  const actor = { userId: '101', employeeId: 10, organizationId: 'org-a' };

  // 1. No explicit fields and no role field restriction -> inspects db.getCollection(collection).fields
  const colsRes = await resolveAllowedExportColumns(db, ctx, {
    collection: 'latticeCustomMaintenanceOrders',
    requestedFields: null,
    isRoot: false,
  });
  assert.ok(colsRes.columns.includes('equipmentName'), 'Custom field equipmentName must be exported');
  assert.ok(colsRes.columns.includes('priority'), 'Custom field priority must be exported');
  assert.equal(colsRes.columns.includes('virtualSummary'), false, 'Virtual field must be excluded');
  assert.equal(colsRes.columns.includes('assignee'), false, 'Association belongsTo field must be excluded');
  assert.equal(colsRes.columns.includes('lines'), false, 'Association hasMany field must be excluded');
  assert.equal(colsRes.columns.includes('apiKeyHash'), false, 'Sensitive field must be excluded');

  // 2. executeGovernedExport outputs custom columns and stays strictly org-scoped
  const exportRes = await executeGovernedExport(
    db,
    ctx,
    { collection: 'latticeCustomMaintenanceOrders', format: 'csv' },
    { isRoot: false, actor },
  );
  assert.ok(exportRes.columns.includes('equipmentName'));
  assert.equal(exportRes.rowCount, 1);
  const csvText = exportRes.buffer.toString('utf8');
  assert.ok(csvText.includes('Máy nén A1'));
  assert.equal(csvText.includes('Foreign Org B'), false);
  assert.equal(csvText.includes('secret-hash-val'), false);

  // 3. Explicit role field restriction still takes precedence
  restrictedRoleFields = ['code', 'status'];
  const restrictedRes = await resolveAllowedExportColumns(db, ctx, {
    collection: 'latticeCustomMaintenanceOrders',
    requestedFields: null,
    isRoot: false,
  });
  assert.deepEqual(restrictedRes.columns, ['code', 'status']);
});
