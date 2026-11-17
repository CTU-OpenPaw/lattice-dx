// SPDX-License-Identifier: Apache-2.0
export function uc2InboxWorkflow({ organizationId, webhookUrl, webhookKey, target = 'observation' }) {
  if (typeof organizationId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(organizationId)) throw new Error('Invalid organization');
  const url = new URL(webhookUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !url.pathname.endsWith('/webhook/latticedx/uc2/observation')) throw new Error('Invalid UC2 webhook URL');
  if (typeof webhookKey !== 'string' || !/^[a-zA-Z0-9_-]{24,128}$/.test(webhookKey)) throw new Error('Invalid UC2 webhook key');
  if (!['observation', 'case'].includes(target)) throw new Error('Invalid UC2 analysis target');
  const caseTarget = target === 'case';
  return {
    title: 'UC2 — Gửi ' + (caseTarget ? 'sự cố' : 'observation') + ' đến n8n — ' + organizationId,
    type: 'collection', enabled: false, sync: false,
    config: caseTarget
      ? { collection: 'latticeIncidentCases', mode: 1, condition: { organizationId, status: 'open', code: {$startsWith:'UC2-'} } }
      : { collection: 'latticeIntegrationInbox', mode: 1, condition: { organizationId, kind: 'observation', late: false } },
    request: {
      key: 'sendToN8n', type: 'request', title: 'Gửi đến n8n',
      config: {
        url: url.href, method: 'POST', timeout: 135000, contentType: 'application/json',
        headers: [{ name: 'X-Lattice-UC2-Key', value: webhookKey }],
        data: JSON.stringify(caseTarget ? { caseId: '{{$context.data.id}}' } : uc2ObservationPayload({
          id: '{{$context.data.id}}', observedAt: '{{$context.data.observedAt}}',
          data: {
            assetId: '{{$context.data.data.assetId}}', attribute: '{{$context.data.data.attribute}}',
            value: '{{$context.data.data.value}}', unit: '{{$context.data.data.unit}}',
          },
        })),
      },
    },
  };
}

export function uc2ObservationPayload({ id, observedAt, data }) {
  return {
    inboxId: String(id), assetId: String(data.assetId), attribute: data.attribute,
    value: String(data.value), unit: data.unit, observedAt,
  };
}
