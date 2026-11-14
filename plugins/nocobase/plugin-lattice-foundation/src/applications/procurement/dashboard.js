/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
function createProcurementDashboardComponent(React) {
  const h = React.createElement;
  const stateLabels = {
    all: 'Tất cả',
    draft: 'Bản nháp',
    submitted: 'Chờ duyệt',
    approved: 'Đã duyệt',
    received: 'Đã nhận hàng',
    accepted: 'Đã nghiệm thu',
    handed_over: 'Đã bàn giao',
    rejected: 'Đã từ chối'
  };
  const stateColors = {
    draft: { bg: '#f1f5f9', color: '#475569', border: '#cbd5e1' },
    submitted: { bg: '#fffbeb', color: '#b45309', border: '#fde68a' },
    approved: { bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
    received: { bg: '#f0fdf4', color: '#15803d', border: '#bbf7d0' },
    accepted: { bg: '#ecfdf5', color: '#047857', border: '#a7f3d0' },
    handed_over: { bg: '#f0fdfa', color: '#0f766e', border: '#99f6e4' },
    rejected: { bg: '#fef2f2', color: '#b91c1c', border: '#fecaca' }
  };

  return function ProcurementDashboard({ api, connection, onReportIncident }) {
    const connected = connection?.connected;
    const [runs, setRuns] = React.useState([]);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState('');
    const [filterState, setFilterState] = React.useState('all');
    const [assetQuery, setAssetQuery] = React.useState('');
    const [selectedAsset, setSelectedAsset] = React.useState(null);
    const [assetLoading, setAssetLoading] = React.useState(false);
    const [bridgeMessage, setBridgeMessage] = React.useState('');
    const [bridgeBusy, setBridgeBusy] = React.useState(false);

    const handleBridgeToIncident = async (asset) => {
      if (!asset || bridgeBusy) return;
      setBridgeBusy(true);
      setBridgeMessage('');
      try {
        const assetId = asset.id;
        const assetTitle = asset.title || assetId;
        if (onReportIncident) {
          await onReportIncident(asset);
        } else if (api.workflow) {
          const key = 'bridge-inc-' + Date.now();
          await api.workflow('create', {
            key,
            body: {
              definitionId: 'incident-response',
              title: `[Sự cố] ${assetTitle}`,
              input: {
                assetEntityId: assetId,
                handlerId: 'DEMO-EMP-01',
                notificationId: 'notif-bridge-' + Date.now(),
                severity: 'high'
              }
            }
          });
          if (api.request) {
            try {
              await api.request({
                url: 'latticeIncidentCases:create',
                method: 'post',
                data: {
                  code: 'CASE-BRG-' + Date.now(),
                  name: `[Sự cố] ${assetTitle}`,
                  title: `[Sự cố] ${assetTitle}`,
                  runId: key,
                  assetEntityId: assetId,
                  severity: 'high'
                }
              });
            } catch {}
          }
        }
        setBridgeMessage(`Đã chuyển giao tài sản ${assetTitle} sang quy trình xử lý sự cố (UC2) thành công!`);
      } catch (err) {
        setBridgeMessage(`Lỗi tạo sự cố: ${err.message || 'Không thể tạo sự cố'}`);
      } finally {
        setBridgeBusy(false);
      }
    };

    const loadData = React.useCallback(async () => {
      if (!connected) return;
      setLoading(true);
      setError('');
      try {
        const res = await api.workflow('list', {
          query: { definitionId: 'procurement', limit: '100', offset: '0' }
        });
        setRuns(res?.items || []);
      } catch (err) {
        setError(err.message || 'Không thể tải danh sách hồ sơ mua sắm.');
      } finally {
        setLoading(false);
      }
    }, [api, connected]);

    React.useEffect(() => {
      loadData();
    }, [loadData]);

    const counts = React.useMemo(() => {
      const summary = { all: runs.length, draft: 0, submitted: 0, approved: 0, received: 0, accepted: 0, handed_over: 0, rejected: 0 };
      for (const r of runs) {
        if (summary[r.state] !== undefined) summary[r.state]++;
      }
      return summary;
    }, [runs]);

    const filteredRuns = React.useMemo(() => {
      return runs.filter(r => {
        if (filterState !== 'all' && r.state !== filterState) return false;
        if (assetQuery.trim()) {
          const q = assetQuery.trim().toLowerCase();
          const titleMatch = r.title?.toLowerCase().includes(q);
          const entityMatch = r.entityContext?.entityId?.toLowerCase().includes(q) || r.entityContext?.schemaId?.toLowerCase().includes(q);
          const assetDataMatch = typeof r.data?.assetId === 'string' && r.data.assetId.toLowerCase().includes(q);
          if (!titleMatch && !entityMatch && !assetDataMatch) return false;
        }
        return true;
      });
    }, [runs, filterState, assetQuery]);

    const handleViewAsset = async (entityId) => {
      if (!entityId || assetLoading) return;
      setAssetLoading(true);
      try {
        const entity = await api.entity('detail', { id: entityId });
        setSelectedAsset(entity);
      } catch (err) {
        setSelectedAsset({ error: err.message || 'Không có quyền truy cập thông tin tài sản này.' });
      } finally {
        setAssetLoading(false);
      }
    };

    return h('section', {
      'data-testid': 'procurement-dashboard',
      style: {
        background: '#fff',
        border: '1px solid #cad5e2',
        borderRadius: 8,
        padding: 20,
        marginBottom: 20,
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
      }
    },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 } },
        h('div', null,
          h('h3', { style: { margin: 0, fontSize: 18, color: '#172b4d' } }, 'Bảng theo dõi Mua sắm & Bàn giao tài sản (UC1)'),
          h('p', { style: { margin: '4px 0 0 0', color: '#5e6c84', fontSize: 13 } }, 'Tổng hợp hồ sơ theo tiến trình xử lý và liên kết tài sản nghiệp vụ.')
        ),
        h('button', {
          type: 'button',
          disabled: loading || !connected,
          onClick: loadData,
          style: { padding: '6px 14px', border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 13 }
        }, loading ? 'Đang tải…' : 'Làm mới')
      ),

      !connected && h('p', { role: 'status', style: { color: '#64748b' } }, 'Kết nối tài khoản nghiệp vụ để xem số liệu tổng hợp.'),
      error && h('p', { role: 'alert', style: { color: '#dc2626' } }, error),

      connected && h(React.Fragment, null,
        h('div', {
          'data-testid': 'kpi-summary-cards',
          style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 20 }
        },
          ...Object.entries(stateLabels).map(([key, label]) => {
            const isSelected = filterState === key;
            const styleProps = stateColors[key] || { bg: '#f8fafc', color: '#334155', border: '#e2e8f0' };
            return h('button', {
              key,
              type: 'button',
              'data-state-filter': key,
              onClick: () => setFilterState(key),
              style: {
                padding: '12px 10px',
                textAlign: 'left',
                border: isSelected ? '2px solid #0284c7' : `1px solid ${styleProps.border}`,
                borderRadius: 8,
                background: isSelected ? '#f0f9ff' : styleProps.bg,
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }
            },
              h('div', { style: { fontSize: 11, fontWeight: 600, color: styleProps.color, textTransform: 'uppercase', letterSpacing: '0.04em' } }, label),
              h('div', { style: { fontSize: 20, fontWeight: 700, color: '#0f172a', marginTop: 4 } }, counts[key] ?? 0)
            );
          })
        ),

        h('div', { style: { display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' } },
          h('div', { style: { flex: 1 } },
            h('input', {
              type: 'text',
              'data-testid': 'asset-search-input',
              placeholder: 'Tìm kiếm theo mã tài sản, URN, hoặc tên hồ sơ…',
              value: assetQuery,
              onChange: e => setAssetQuery(e.target.value),
              style: { width: '100%', padding: '8px 12px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 13 }
            })
          ),
          assetQuery && h('button', {
            type: 'button',
            onClick: () => setAssetQuery(''),
            style: { padding: '8px 12px', border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 12 }
          }, 'Xóa lọc')
        ),

        selectedAsset && h('aside', {
          'data-testid': 'asset-detail-card',
          style: {
            background: '#f8fafc',
            border: '1px solid #bfdbfe',
            borderRadius: 8,
            padding: 16,
            marginBottom: 16,
            position: 'relative'
          }
        },
          h('button', {
            type: 'button',
            onClick: () => setSelectedAsset(null),
            style: { position: 'absolute', top: 12, right: 12, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16, color: '#64748b' }
          }, '✕'),
          selectedAsset.error ? h('p', { role: 'alert', style: { color: '#dc2626', margin: 0 } }, selectedAsset.error) :
          h('div', null,
            h('h4', { style: { margin: '0 0 8px 0', color: '#1e40af', fontSize: 14 } }, `Tài sản: ${selectedAsset.title || selectedAsset.id}`),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, fontSize: 12 } },
              h('div', null, h('span', { style: { color: '#64748b' } }, 'ID: '), h('strong', null, selectedAsset.id)),
              h('div', null, h('span', { style: { color: '#64748b' } }, 'Schema: '), h('strong', null, selectedAsset.schemaId)),
              h('div', null, h('span', { style: { color: '#64748b' } }, 'Phiên bản: '), h('strong', null, selectedAsset.version)),
              selectedAsset.attributes?.assetCode && h('div', null, h('span', { style: { color: '#64748b' } }, 'Mã tài sản: '), h('strong', null, selectedAsset.attributes.assetCode)),
              selectedAsset.attributes?.location && h('div', null, h('span', { style: { color: '#64748b' } }, 'Vị trí: '), h('strong', null, selectedAsset.attributes.location)),
              selectedAsset.attributes?.status && h('div', null, h('span', { style: { color: '#64748b' } }, 'Tình trạng: '), h('strong', null, selectedAsset.attributes.status))
            ),
            h('div', { style: { marginTop: 14, paddingTop: 12, borderTop: '1px solid #bfdbfe', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
              h('button', {
                type: 'button',
                'data-testid': 'bridge-to-incident-btn',
                disabled: bridgeBusy,
                onClick: () => handleBridgeToIncident(selectedAsset),
                style: {
                  padding: '7px 16px',
                  background: '#dc2626',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6
                }
              }, bridgeBusy ? 'Đang xử lý…' : '🚨 Báo sự cố thiết bị (Chuyển sang UC2)'),
              bridgeMessage && h('span', {
                'data-testid': 'bridge-status-message',
                role: 'status',
                style: { fontSize: 12, color: bridgeMessage.startsWith('Lỗi') ? '#dc2626' : '#15803d', fontWeight: 500 }
              }, bridgeMessage)
            )
          )
        ),

        h('div', { style: { overflowX: 'auto' } },
          h('table', {
            'data-testid': 'dashboard-records-table',
            style: { width: '100%', borderCollapse: 'collapse', fontSize: 13 }
          },
            h('thead', null,
              h('tr', { style: { borderBottom: '2px solid #e2e8f0', background: '#f8fafc' } },
                h('th', { style: { textAlign: 'left', padding: '10px 12px' } }, 'Hồ sơ mua sắm'),
                h('th', { style: { textAlign: 'left', padding: '10px 12px' } }, 'Trạng thái'),
                h('th', { style: { textAlign: 'left', padding: '10px 12px' } }, 'Tài sản liên kết (Asset)'),
                h('th', { style: { textAlign: 'left', padding: '10px 12px' } }, 'Phiên bản'),
                h('th', { style: { textAlign: 'left', padding: '10px 12px' } }, 'Cập nhật')
              )
            ),
            h('tbody', null,
              filteredRuns.length === 0 ?
                h('tr', null, h('td', { colSpan: 5, style: { textAlign: 'center', padding: 24, color: '#94a3b8' } }, 'Không có hồ sơ nào phù hợp bộ lọc.')) :
                filteredRuns.map(row => {
                  const stateStyle = stateColors[row.state] || { bg: '#f1f5f9', color: '#475569' };
                  return h('tr', { key: row.id, style: { borderBottom: '1px solid #f1f5f9' } },
                    h('td', { style: { padding: '10px 12px', fontWeight: 500, color: '#0f172a' } }, row.title || row.id),
                    h('td', { style: { padding: '10px 12px' } },
                      h('span', {
                        style: {
                          display: 'inline-block',
                          padding: '2px 8px',
                          borderRadius: 4,
                          fontSize: 12,
                          fontWeight: 500,
                          background: stateStyle.bg,
                          color: stateStyle.color
                        }
                      }, stateLabels[row.state] || row.state)
                    ),
                    h('td', { style: { padding: '10px 12px' } },
                      row.entityContext?.entityId ?
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                          h('button', {
                            type: 'button',
                            'data-testid': 'link-to-asset-' + row.id,
                            onClick: () => handleViewAsset(row.entityContext.entityId),
                            style: {
                              padding: '3px 8px',
                              background: '#eff6ff',
                              border: '1px solid #bfdbfe',
                              borderRadius: 4,
                              color: '#1d4ed8',
                              fontSize: 12,
                              cursor: 'pointer',
                              textDecoration: 'underline'
                            }
                          }, `🔗 Asset: ${row.entityContext.entityId.slice(0, 8)}…`),
                          (row.state === 'handed_over' || row.state === 'accepted') && h('button', {
                            type: 'button',
                            'data-testid': 'row-bridge-incident-' + row.id,
                            onClick: async () => {
                              await handleViewAsset(row.entityContext.entityId);
                              await handleBridgeToIncident({ id: row.entityContext.entityId, title: row.title });
                            },
                            style: {
                              padding: '2px 8px',
                              background: '#fff1f0',
                              border: '1px solid #ffa39e',
                              borderRadius: 4,
                              color: '#cf1322',
                              fontSize: 11,
                              cursor: 'pointer',
                              fontWeight: 600
                            }
                          }, '🚨 Báo sự cố')
                        ) :
                        (row.data?.assetId ?
                          h('span', { style: { color: '#64748b', fontSize: 12 } }, `📦 ${String(row.data.assetId).slice(0, 16)}…`) :
                          h('span', { style: { color: '#94a3b8', fontSize: 12 } }, 'Chưa liên kết'))
                    ),
                    h('td', { style: { padding: '10px 12px', color: '#64748b', fontSize: 12 } }, `v${row.version}`),
                    h('td', { style: { padding: '10px 12px', color: '#64748b', fontSize: 12 } },
                      row.updatedAt ? new Date(row.updatedAt).toLocaleDateString('vi-VN') : '—'
                    )
                  );
                })
            )
          )
        )
      )
    );
  };
}
module.exports = { createProcurementDashboardComponent };
