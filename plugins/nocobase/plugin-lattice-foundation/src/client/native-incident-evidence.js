/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
function formatEvidenceSource(source) {
  if (!source || typeof source !== 'object') return 'Bằng chứng không xác định';
  if (source.kind === 'native-record') return 'Bản ghi sự cố #' + String(source.recordId ?? '') + ' · ' + String(source.fingerprint ?? '');
  if (source.kind === 'ngsi-ld') return 'NGSI-LD · ' + String(source.entityId ?? '') + ' · ' + String(source.fingerprint ?? '');
  return String(source.kind || 'Nguồn khác') + ' · ' + String(source.fingerprint ?? '');
}

function createIncidentEvidence(client, React, antd) {
  const h = React.createElement;
  return function IncidentEvidence() {
    const { id } = client.useCollectionRecordData() ?? {};
    const api = client.useAPIClient();
    const role = api?.auth?.role ?? '';
    const [version, refresh] = React.useReducer(value => value + 1, 0);
    const [result, setResult] = React.useState(null);
    const valid = /^[1-9]\d{0,18}$/.test(String(id));
    React.useEffect(() => {
      if (!valid || typeof api?.request !== 'function') {
        setResult(null);
        return;
      }
      const controller = new AbortController();
      api.request({
        url: 'latticeIntegrations:proposals', method: 'post',
        data: { collection: 'latticeIncidentCases', recordId: String(id), pageSize: 5 },
        signal: controller.signal, timeout: 10000,
      }).then(response => {
        if (controller.signal.aborted) return;
        const items = response?.data?.data?.items;
        setResult(Array.isArray(items) ? { id, version, role, items } : { id, version, role, error: true });
      }).catch(() => {
        if (!controller.signal.aborted) setResult({ id, version, role, error: true });
      });
      return () => controller.abort();
    }, [api, id, valid, version, role]);
    if (!valid) return null;
    const current = result?.id === id && result.version === version && result.role === role ? result : null;
    return h('section', { 'aria-label': 'Đề xuất AI' },
      h('h4', null, 'Đề xuất AI và bằng chứng'),
      h(antd.Button, { htmlType: 'button', loading: !current, disabled: !current, onClick: refresh }, 'Tải lại đề xuất'),
      !current ? h('p', { role: 'status' }, 'Đang tải đề xuất…') :
        current.error ? h(antd.Alert, { type: 'warning', message: 'Không đọc được đề xuất theo quyền hiện tại.' }) :
          !current.items.length ? h('p', null, 'Chưa có đề xuất cho sự cố này.') :
            current.items.map(item => h('article', { key: item.id },
              item.stale ? h(antd.Alert, { type: 'warning', message: 'Bằng chứng đã cũ. Cần phân tích lại.' }) :
                h(React.Fragment, null,
                  h('p', null, typeof item.recommendation === 'string' ? item.recommendation : ''),
                  h('ul', null, (Array.isArray(item.evidence) ? item.evidence : []).map((source, index) =>
                    h('li', { key: index }, formatEvidenceSource(source))))))));
  };
}
module.exports = { createIncidentEvidence };
