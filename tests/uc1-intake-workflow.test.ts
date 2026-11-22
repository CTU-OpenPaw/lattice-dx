/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parseCreate } from '../apps/api/src/workflows/policy';
const workflow = JSON.parse(readFileSync('infra/config/n8n/uc1-intake.json', 'utf8'));
const node = (name: string) => workflow.nodes.find((n: {name: string}) => n.name === name);
const execute = new Function('$input', node('Validate UC1 Order').parameters.jsCode);
function validate(body: unknown, key: unknown = 'order-001') {
  return execute({ first: () => ({ json: { body, headers: { 'idempotency-key': key } } }) })[0].json;
}
test('valid order maps to the actual UC1 API contract with stable key', () => {
  const result = validate({ title: ' Laptop ', input: {} });
  expect(result.valid).toBe(true);
  expect(result.idempotencyKey).toBe('order-001');
  expect(parseCreate(result.payload)).toEqual({ definitionId: 'procurement', title: 'Laptop', input: {} });
  expect(validate({ title: 'Laptop' }).payload).toEqual(result.payload);
});
test.each([null, [], 'text', {}, {title: ''}, {title: ' '.repeat(5)}, {title: 'a'.repeat(201)}, {title: 'Laptop', input: null}, {title: 'Laptop', input: []}, {title: 'Laptop', input: {quantity: 1}}, {title: 'Laptop', organizationId: 'other'}, {title: 'Laptop', definitionId: 'other'}, {title: 'Laptop', order: {quantity: 1}}])('invalid payload never produces an API payload: %j', body => {
  const result = validate(body);
  expect(result.valid).toBe(false);
  expect(result.payload).toBeUndefined();
  expect(result.errors.length).toBeGreaterThan(0);
});
test.each([undefined, '', 'bad key', 'x'.repeat(129), ['key']])('rejects invalid idempotency key: %j', key => {
  const result = execute({first: () => ({json: {body: {title: 'Laptop'}, headers: {'idempotency-key': key}}})})[0].json;
  expect(result.valid).toBe(false);
  expect(result.payload).toBeUndefined();
});
test('unicode title uses the same character limit as API', () => {
  expect(validate({ title: '📦'.repeat(200) }).valid).toBe(true);
  expect(validate({ title: '📦'.repeat(201) }).valid).toBe(false);
});
test('workflow routes validation and transport failures to explicit responses', () => {
  expect(workflow.active).toBe(false);
  expect(node('Webhook').parameters.authentication).toBe('headerAuth');
  expect(workflow.connections.If.main[0][0].node).toBe('Create UC1 Draft');
  expect(workflow.connections.If.main[1][0].node).toBe('Return Validation Error');
  expect(node('Return Validation Error').parameters.options.responseCode).toBe(400);
  const http = node('Create UC1 Draft');
  expect(http.parameters.url).toBe('http://gateway:9080/v1/workflows');
  expect(http.retryOnFail).toBe(false);
  expect(http.onError).toBe('continueErrorOutput');
  expect(workflow.connections['Create UC1 Draft'].main[1][0].node).toBe('Return Integration Failure');
  expect(node('Return Integration Failure').parameters.options.responseCode).toBe(502);
  for (const n of workflow.nodes) {
    for (const credential of Object.values(n.credentials ?? {}) as {id?: string}[]) expect(credential.id).toBeUndefined();
  }
});

const executeNormalize = new Function(
  '$input',
  node('Normalize UC1 Response').parameters.jsCode,
);

function normalize(response: unknown) {
  return executeNormalize({
    first: () => ({ json: response }),
  })[0].json;
}

test('successful API responses pass through normalization', () => {
  expect(
    workflow.connections['Create UC1 Draft'].main[0][0].node,
  ).toBe('Normalize UC1 Response');

  expect(
    workflow.connections['Normalize UC1 Response'].main[0][0].node,
  ).toBe('Return Order Result');

  expect(normalize({
    statusCode: 201,
    data: JSON.stringify({ id: 'demo-run', state: 'draft' }),
  })).toEqual({
    statusCode: 201,
    body: { id: 'demo-run', state: 'draft' },
  });
});

test('idempotency conflict preserves API status and JSON body', () => {
  const body = { error: 'Idempotency conflict' };

  expect(normalize({
    statusCode: 409,
    data: JSON.stringify(body),
  })).toEqual({
    statusCode: 409,
    body,
  });
});

test.each([401, 403])(
  'non-JSON authentication response preserves HTTP %i without exposing HTML',
  statusCode => {
    const result = normalize({
      statusCode,
      data: '<html>Gateway authentication error</html>',
    });

    expect(result.statusCode).toBe(statusCode);
    expect(result.body.status).toBe('upstream_auth_error');
    expect(JSON.stringify(result.body)).not.toContain('<html>');
  },
);

test.each([
  { statusCode: 201, data: 'invalid JSON' },
  { statusCode: 502, data: '<html>Bad gateway</html>' },
  { data: '{}' },
  { statusCode: 999, data: '{}' },
])('unusable API response becomes sanitized 502: %j', response => {
  const result = normalize(response);

  expect(result.statusCode).toBe(502);
  expect(result.body.status).toBe('upstream_unavailable');
  expect(result.body.message).toContain('Idempotency-Key');
});