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
