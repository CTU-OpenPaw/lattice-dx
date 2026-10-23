// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const workflow = JSON.parse(
  readFileSync('infra/config/n8n/uc1-handover-sample.json', 'utf8'),
);

function node(name: string) {
  const result = workflow.nodes.find(
    (item: { name: string }) => item.name === name,
  );
  if (!result) throw new Error(`Missing node: ${name}`);
  return result;
}

function execute(name: string, json: unknown) {
  const run = new Function('$input', node(name).parameters.jsCode);
  return run({ first: () => ({ json }) })[0].json;
}

function fixture() {
  return {
    eventId: 'uc1-test-handover-001',
    eventType: 'asset.handed_over',
    organizationId: 'org-a',
    runId: 'run-001',
    recordId: 'record-001',
    definitionId: 'procurement',
    version: 6,
    occurredAt: '2026-10-22T10:08:27.521Z',
    data: {
      assetId: 'demo-asset-001',
      recipientId: 'fixture-recipient',
      departmentId: 'it',
      locationId: 'office-1',
      attachmentId: 'fixture-attachment',
    },
  };
}

function validate(body: unknown, key: unknown = 'uc1-test-handover-001') {
  return execute('Validate Handover Event', {
    body,
    headers: { 'idempotency-key': key },
  });
}

function normalize(statusCode: number, body: unknown) {
  return execute('Normalize Sample Response', {
    statusCode,
    data: JSON.stringify(body),
  });
}

test('valid handover preserves source payload and event key', () => {
  const event = fixture();
  const result = validate(event);

  expect(result.valid).toBe(true);
  expect(result.payload).toEqual(event);
  expect(result.idempotencyKey).toBe(event.eventId);
});

test.each([
  ['null', null],
  ['array', []],
  ['string', 'text'],
  ['empty object', {}],
])('rejects invalid envelope: %s', (_label, body) => {
  const result = validate(body);
  expect(result.valid).toBe(false);
  expect(result.payload).toBeUndefined();
});

test.each([
  ['eventType', 'employee.onboarded'],
  ['definitionId', 'onboarding'],
  ['version', 0],
  ['version', 1.5],
  ['occurredAt', 'not-a-date'],
  ['occurredAt', '2026-02-30T10:00:00Z'],
  ['organizationId', ''],
])('rejects invalid %s: %j', (field, value) => {
  const result = validate({ ...fixture(), [field]: value });
  expect(result.valid).toBe(false);
  expect(result.payload).toBeUndefined();
});

test.each([
  'assetId',
  'recipientId',
  'departmentId',
  'locationId',
  'attachmentId',
])('rejects missing handover field: %s', (field) => {
  const event = fixture();
  const data: Record<string, string> = { ...event.data };
  delete data[field];

  const result = validate({ ...event, data });
  expect(result.valid).toBe(false);
  expect(result.payload).toBeUndefined();
});

test('rejects non-string data values', () => {
  const event = fixture();
  const result = validate({
    ...event,
    data: { ...event.data, assetId: 123 },
  });
  expect(result.valid).toBe(false);
});

test.each([
  undefined,
  '',
  'bad key',
  'different-event',
  'x'.repeat(129),
  ['uc1-test-handover-001'],
])('rejects invalid or mismatched event key: %j', (key) => {
  const result = validate(fixture(), key);
  // Explicit undefined must reach the validator, bypassing helper defaults.
  const actual = key === undefined
    ? execute('Validate Handover Event', {
        body: fixture(),
        headers: {},
      })
    : result;

  expect(actual.valid).toBe(false);
  expect(actual.payload).toBeUndefined();
});

test.each([
  [201, 'accepted'],
  [200, 'duplicate'],
  [409, 'conflict'],
])('preserves sample HTTP %i and outcome %s', (statusCode, status) => {
  const body = { status, eventId: fixture().eventId };
  expect(normalize(statusCode, body)).toEqual({ statusCode, body });
});

test.each([401, 403])('sanitizes non-JSON auth response: %i', (statusCode) => {
  const result = execute('Normalize Sample Response', {
    statusCode,
    data: '<html>Private upstream details</html>',
  });

  expect(result.statusCode).toBe(statusCode);
  expect(JSON.stringify(result.body)).not.toContain('Private upstream');
});

test.each([
  { statusCode: 201, data: 'invalid JSON' },
  { statusCode: 502, data: '<html>Internal details</html>' },
  { statusCode: 200, data: 'null' },
  { statusCode: 200, data: '[]' },
  { data: '{}' },
])('unusable response becomes sanitized 502: %j', (response) => {
  const result = execute('Normalize Sample Response', response);
  expect(result.statusCode).toBe(502);
  expect(result.body.status).toBe('sample_unavailable');
});

test('validation and transport failures have explicit response routes', () => {
  const connections = workflow.connections;

  expect(connections.Webhook.main[0][0].node)
    .toBe('Validate Handover Event');
  expect(connections['Validate Handover Event'].main[0][0].node)
    .toBe('Is Valid Handover Event');
  expect(connections['Is Valid Handover Event'].main[0][0].node)
    .toBe('Send Handover to Sample');
  expect(connections['Is Valid Handover Event'].main[1][0].node)
    .toBe('Return Invalid Handover');
  expect(connections['Send Handover to Sample'].main[0][0].node)
    .toBe('Normalize Sample Response');
  expect(connections['Send Handover to Sample'].main[1][0].node)
    .toBe('Return Sample Unavailable');
  expect(connections['Normalize Sample Response'].main[0][0].node)
    .toBe('Return Handover Result');

  expect(node('Return Invalid Handover').parameters.options.responseCode)
    .toBe(400);
  expect(node('Return Sample Unavailable').parameters.options.responseCode)
    .toBe(502);
});

test('HTTP delivery uses credentials, bounded timeout and no automatic retry', () => {
  const http = node('Send Handover to Sample');

  expect(node('Webhook').parameters.authentication).toBe('headerAuth');
  expect(node('Webhook').parameters.responseMode).toBe('responseNode');
  expect(http.parameters.method).toBe('POST');
  expect(http.parameters.url)
    .toBe('http://uc1-sample:4100/sample/handovers');
  expect(http.parameters.genericAuthType).toBe('httpHeaderAuth');
  expect(http.parameters.options.timeout).toBe(5000);
  expect(http.retryOnFail).toBe(false);
  expect(http.onError).toBe('continueErrorOutput');

  const response = http.parameters.options.response.response;
  expect(response.fullResponse).toBe(true);
  expect(response.neverError).toBe(true);
  expect(response.responseFormat).toBe('text');

  const headers = http.parameters.headerParameters.parameters;
  const keyHeader = headers.find(
    (header: { name: string }) =>
      header.name.toLowerCase() === 'idempotency-key',
  );
  expect(keyHeader?.value).toContain('$json.idempotencyKey');
  expect(http.parameters.jsonBody).toContain('$json.payload');
});

test('export is inactive and contains no pinned data or credential IDs', () => {
  expect(workflow.active).toBe(false);
  expect(workflow.pinData).toEqual({});

  for (const item of workflow.nodes) {
    for (const credential of Object.values(item.credentials ?? {})) {
      expect(credential).not.toHaveProperty('id');
    }
  }
});
