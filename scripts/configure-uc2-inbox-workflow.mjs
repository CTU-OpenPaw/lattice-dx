// SPDX-License-Identifier: Apache-2.0
import { uc2InboxWorkflow, uc2ObservationPayload } from './lib/uc2-inbox-workflow.mjs';

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

async function replayObservation(replay) {
  const id = /^--replay=([1-9]\d{0,18})$/.exec(replay)?.[1];
  if (!id || process.argv.length !== 3) throw new Error('Expected --replay=INBOX_ID');
  const response = await fetch(new URL('/api/latticeIntegrationInbox:get?filterByTk=' + id, origin), {
    redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + token, 'X-Role': 'root' },
  });
  if (!response.ok) throw new Error('Cannot read inbox receipt (HTTP ' + response.status + ')');
  const { data: row } = await response.json();
  if (String(row?.id) !== id || row.organizationId !== process.env.UC2_SENSOR_TENANT ||
      row.kind !== 'observation' || row.late !== false) throw new Error('Inbox receipt is outside the configured UC2 workflow scope');
  const delivery = await fetch(request.config.url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(request.config.timeout),
    headers: { 'Content-Type': 'application/json', 'X-Lattice-UC2-Key': process.env.UC2_N8N_WEBHOOK_KEY },
    body: JSON.stringify(uc2ObservationPayload(row)),
  });
  if (!delivery.ok) throw new Error('UC2 webhook returned HTTP ' + delivery.status);
  const { data: receipt } = await delivery.json();
  if (!/^[1-9]\d{0,18}$/.test(String(receipt?.id)) ||
      (receipt.found !== true && receipt.state !== 'proposed')) throw new Error('UC2 webhook did not confirm a proposal');
  console.log(JSON.stringify({ inboxId: id, proposalId: receipt.id, duplicate: receipt.found === true || receipt.duplicate === true }));
}

async function post(path, values) {
  const response = await fetch(new URL('/api/' + path, origin), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + token, 'X-Role': 'root', 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
  });
  if (!response.ok) throw new Error(path + ' returned HTTP ' + response.status);
  return (await response.json()).data;
}
async function installWorkflow() {
  const workflow = await post('workflows:create', template);
  try {
    await post('workflows/' + workflow.id + '/nodes:create', request);
  } catch (error) {
    throw new Error('Workflow ' + workflow.id + ' remains disabled', { cause: error });
  }
  console.log(JSON.stringify({ workflowId: workflow.id, enabled: false }));
}

if (process.argv[2]) await replayObservation(process.argv[2]);
else await installWorkflow();
