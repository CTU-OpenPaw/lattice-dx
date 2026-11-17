// SPDX-License-Identifier: Apache-2.0
function createIncidentEvidence(client, React, antd) {
  const h = React.createElement;
  return function IncidentEvidence() {
    const { id } = client.useCollectionRecordData() ?? {};
    const api = client.useAPIClient();
    const [version, refresh] = React.useReducer(value => value + 1, 0);
    const [result, setResult] = React.useState(null);
    const valid = /^[1-9]\d{0,18}$/.test(String(id));
    React.useEffect(() => {
      if (!valid) return;
      const controller = new AbortController();
      api.request({
        url: 'latticeIntegrations:proposals', method: 'post',
        data: { collection: 'latticeIncidentCases', recordId: String(id), pageSize: 5 },
        signal: controller.signal, timeout: 10000,
      }).then(response => {
        if (!controller.signal.aborted) setResult({ id, version, items: response.data.data.items });
      }).catch(() => {
        if (!controller.signal.aborted) setResult({ id, version, error: true });
      });
      return () => controller.abort();
    }, [api, id, valid, version]);
    if (!valid) return null;
    const current = result?.id === id && result.version === version ? result : null;
    return h('section', { 'aria-label': 'Đề xuất AI' },
      h('h4', null, 'Đề xuất AI và bằng chứng'),
      h(antd.Button, { htmlType: 'button', onClick: refresh }, 'Tải lại đề xuất'),
      !current ? h('p', { role: 'status' }, 'Đang tải đề xuất…') :
        current.error ? h(antd.Alert, { type: 'warning', message: 'Không đọc được đề xuất theo quyền hiện tại.' }) :
          !current.items.length ? h('p', null, 'Chưa có đề xuất cho sự cố này.') :
            current.items.map(item => h('article', { key: item.id },
              item.stale ? h(antd.Alert, { type: 'warning', message: 'Bằng chứng đã cũ. Cần phân tích lại.' }) :
                h(React.Fragment, null,
                  h('p', null, item.recommendation),
                  h('ul', null, item.evidence.map((source, index) => h('li', { key: index },
                    source.kind === 'native-record'
                      ? 'Bản ghi sự cố #' + source.recordId + ' · ' + source.fingerprint
                      : 'NGSI-LD · ' + source.entityId + ' · ' + source.fingerprint)))))));
  };
}
module.exports = { createIncidentEvidence };
