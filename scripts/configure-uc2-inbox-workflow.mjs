// SPDX-License-Identifier: Apache-2.0
import { uc2InboxWorkflow } from './lib/uc2-inbox-workflow.mjs';

const origin = new URL(process.env.NOCOBASE_URL ?? 'http://localhost:13003');
if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(origin.hostname) ||
    Number(origin.port) < 13001 || Number(origin.port) > 13999) throw new Error('Use an isolated local native lab');
const token = process.env.NOCOBASE_TOKEN;
if (!token) throw new Error('Set the lab administrator session in NOCOBASE_TOKEN');
const { request, ...template } = uc2InboxWorkflow({
  organizationId: process.env.UC2_SENSOR_TENANT,
  webhookUrl: process.env.UC2_N8N_WEBHOOK_URL,
  webhookKey: process.env.UC2_N8N_WEBHOOK_KEY,
});
async function post(path, values) {
  const response = await fetch(new URL('/api/' + path, origin), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + token, 'X-Role': 'root', 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
  });
  if (!response.ok) throw new Error(path + ' returned HTTP ' + response.status);
  return (await response.json()).data;
}
const workflow = await post('workflows:create', template);
try {
  await post('workflows/' + workflow.id + '/nodes:create', request);
} catch (error) {
  throw new Error('Workflow ' + workflow.id + ' remains disabled', { cause: error });
}
console.log(JSON.stringify({ workflowId: workflow.id, enabled: false }));
