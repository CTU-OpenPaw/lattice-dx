// SPDX-License-Identifier: Apache-2.0
export function uc2InboxWorkflow({ organizationId, webhookUrl, webhookKey }) {
  if (typeof organizationId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(organizationId)) throw new Error('Invalid organization');
  const url = new URL(webhookUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !url.pathname.endsWith('/webhook/latticedx/uc2/observation')) throw new Error('Invalid UC2 webhook URL');
  if (typeof webhookKey !== 'string' || !/^[a-zA-Z0-9_-]{24,128}$/.test(webhookKey)) throw new Error('Invalid UC2 webhook key');
  return {
    title: 'UC2 — Gửi observation đến n8n — ' + organizationId,
    type: 'collection', enabled: false, sync: false,
    config: { collection: 'latticeIntegrationInbox', mode: 1, condition: { organizationId, kind: 'observation', late: false } },
    request: {
      key: 'sendToN8n', type: 'request', title: 'Gửi observation đến n8n',
      config: {
        url: url.href, method: 'POST', timeout: 120000, contentType: 'application/json',
        headers: [{ name: 'X-Lattice-UC2-Key', value: webhookKey }],
        data: JSON.stringify({ inboxId: '{{$context.data.id}}', assetId: '{{$context.data.data.assetId}}', attribute: '{{$context.data.data.attribute}}', value: '{{$context.data.data.value}}', unit: '{{$context.data.data.unit}}', observedAt: '{{$context.data.observedAt}}' }),
      },
    },
  };
}
