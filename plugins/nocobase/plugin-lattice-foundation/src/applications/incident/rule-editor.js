/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const { createWorkflowCommands } = require('../../client/workflow');

function createRuleEditorComponent(React) {
  const h = React.createElement;

  const attributeLabels = {
    temperature: 'Nhiệt độ (Temperature)',
    humidity: 'Độ ẩm (Humidity)',
    batteryLevel: 'Mức pin (Battery Level)'
  };

  const operatorLabels = {
    gt: '> Lớn hơn',
    gte: '≥ Lớn hơn hoặc bằng',
    lt: '< Nhỏ hơn',
    lte: '≤ Nhỏ hơn hoặc bằng'
  };

  const operatorSymbols = {
    gt: '>',
    gte: '≥',
    lt: '<',
    lte: '≤'
  };

  // Keep this form aligned with solutions/workflows/incident-module.json.
  const thresholdChoices = ['0', '5', '10', '15', '20', '25', '30', '35', '40', '50', '60', '70', '80', '90', '100'];

  const severityColors = {

    low: { bg: '#e6f4ff', color: '#0958d9', border: '#91caff', label: 'Thấp' },
    medium: { bg: '#fffbe6', color: '#d46b08', border: '#ffe58f', label: 'Trung bình' },
    high: { bg: '#fff2e8', color: '#d4380d', border: '#ffbb96', label: 'Cao' },
    critical: { bg: '#fff1f0', color: '#cf1322', border: '#ffa39e', label: 'Khẩn cấp' }
  };

  const defaultForm = {
    name: '',
    assetEntityId: '',
    attribute: 'temperature',
    operator: 'gt',
    threshold: '60',
    unit: 'celsius',
    severity: 'high',
    cooldownSeconds: '300',
    maxObservationAgeSeconds: '300',
    handlerId: 'alice',
    enabled: true
  };

  return function RuleEditor({ api, connection }) {
    const connected = connection?.connected === true;
    const actorId = connection?.identity?.subject;
    const organizationId = connection?.identity?.organizationId;
    const scope = React.useMemo(() => ({ api, connected, actorId, organizationId }), [api, connected, actorId, organizationId]);
    const scopeRef = React.useRef(scope);
    scopeRef.current = scope;
    const loadEpoch = React.useRef(0);
    const [rules, setRules] = React.useState([]);
    const [assets, setAssets] = React.useState([]);
    const [dataScope, setDataScope] = React.useState(scope);
    const visibleRules = dataScope === scope ? rules : [];
    const visibleAssets = dataScope === scope ? assets : [];
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState('');
    const [successMessage, setSuccessMessage] = React.useState('');
    const [isCreating, setIsCreating] = React.useState(false);
    const [form, setForm] = React.useState(defaultForm);
    const [formError, setFormError] = React.useState('');
    const [submitting, setSubmitting] = React.useState(false);
    const [retryCommand, setRetryCommand] = React.useState(null);
    const entityCommands = React.useMemo(() => api?.entity && connected && actorId
      ? createWorkflowCommands({
          api,
          actorId,
          channel: 'entity'
        })
      : null, [api, connected, actorId, organizationId]);

    const loadData = React.useCallback(async () => {
      const requestScope = scope;
      const request = ++loadEpoch.current;
      const current = () => scopeRef.current === requestScope && loadEpoch.current === request;
      if (!connected) {
        if (current()) {
          setRules([]);
          setAssets([]);
          setDataScope(requestScope);
          setLoading(false);
        }
        return;
      }
      setLoading(true);
      setError('');
      try {
        if (!api?.entity) throw new Error('Không có dịch vụ thực thể để tải luật cảnh báo.');
        const res = await api.entity('list', { query: { schemaId: 'incident-rule', limit: '100', offset: '0' } });
        if (!Array.isArray(res?.items)) throw new Error('Dữ liệu danh sách luật cảnh báo không hợp lệ.');
        if (!current()) return;
        setRules(res.items);
      } catch (err) {
        if (!current()) return;
        setRules([]);
        setError(err.message || 'Không thể tải danh sách luật cảnh báo.');
      }

      try {
        const assetRes = await api.entity('list', { query: { schemaId: 'incident-asset', limit: '100', offset: '0' } });
        if (!current()) return;
        setAssets(assetRes?.items || []);
      } catch {
        if (!current()) return;
        setAssets([]);
      } finally {
        if (current()) {
          setDataScope(requestScope);
          setLoading(false);
        }
      }
    }, [api, connected, scope]);

    React.useEffect(() => {
      loadEpoch.current++;
      setRules([]);
      setAssets([]);
      setRetryCommand(null);
      setError('');
      setFormError('');
      setSuccessMessage('');
      setSubmitting(false);
      setIsCreating(false);
      setForm(defaultForm);
      setDataScope(null);
      if (connected) loadData();
      else setLoading(false);
      return () => { loadEpoch.current++; };
    }, [loadData, scope, connected]);

    const handleAttributeChange = e => {
      const attr = e.target.value;
      const unit = attr === 'temperature' ? 'celsius' : 'percent';
      const threshold = attr === 'temperature' ? '60' : '20';
      setForm(prev => ({ ...prev, attribute: attr, unit, threshold }));
    };

    const handleSaveRule = async e => {
      e?.preventDefault?.();
      const commandScope = scope;
      setFormError('');
      setSuccessMessage('');

      if (!form.name.trim()) {
        setFormError('Vui lòng nhập tên luật cảnh báo.');
        return;
      }
      if (!form.assetEntityId.trim()) {
        setFormError('Vui lòng chọn hoặc nhập mã tài sản cần giám sát.');
        return;
      }
      if (!form.handlerId.trim()) {
        setFormError('Vui lòng nhập mã kỹ thuật viên phụ trách.');
        return;
      }

      setSubmitting(true);
      try {
        if (scopeRef.current !== commandScope || !entityCommands) throw new Error('Chưa kết nối tài khoản hoặc dịch vụ thực thể.');
        const title = form.name.trim();
        const attributes = {
          assetEntityId: form.assetEntityId.trim(),
          attribute: form.attribute,
          operator: form.operator,
          threshold: String(form.threshold),
          unit: form.unit,
          severity: form.severity,
          cooldownSeconds: String(form.cooldownSeconds),
          maxObservationAgeSeconds: String(form.maxObservationAgeSeconds),
          workflowDefinitionId: 'incident-response',
          workflowDefinitionVersion: '1',
          handlerId: form.handlerId.trim(),
          enabled: form.enabled
        };

        await entityCommands.execute('create', {
          schemaId: 'incident-rule',
          title,
          attributes
        });
        if (scopeRef.current !== commandScope) return;
        setRetryCommand(null);
        setSuccessMessage(`Đã tạo luật cảnh báo "${title}" thành công.`);
        setIsCreating(false);
        setForm(defaultForm);
        await loadData();
      } catch (err) {
        if (scopeRef.current !== commandScope) return;
        setRetryCommand(entityCommands?.uncertain ? { type: 'create', title: form.name.trim() } : null);
        if (err?.status === 403 || err?.code === 'authority_denied') {
          setFormError('Bạn không có quyền cấu hình luật cảnh báo sự cố.');
        } else {
          setFormError(err.message || 'Lỗi khi lưu luật cảnh báo.');
        }
      } finally {
        if (scopeRef.current === commandScope) setSubmitting(false);
      }
    };

    const handleToggleRule = async rule => {
      const commandScope = scope;
      const currentAttrs = rule.attributes || rule;
      const updatedEnabled = !currentAttrs.enabled;
      try {
        if (scopeRef.current !== commandScope || !entityCommands || !rule.id) throw new Error('Không tìm thấy luật cảnh báo hoặc tài khoản để cập nhật.');
        await entityCommands.execute('update', {
          expectedVersion: rule.version,
          title: rule.title,
          attributes: { ...currentAttrs, enabled: updatedEnabled }
        }, rule.id);
        if (scopeRef.current !== commandScope) return;
        setRetryCommand(null);
        await loadData();
      } catch (err) {
        if (scopeRef.current !== commandScope) return;
        setRetryCommand(entityCommands?.uncertain ? { type: 'update' } : null);
        setError(err.message || 'Không thể thay đổi trạng thái kích hoạt.');
      }
    };

    const handleArchiveRule = async rule => {
      const commandScope = scope;
      try {
        if (scopeRef.current !== commandScope || !entityCommands || !rule.id) throw new Error('Không tìm thấy luật cảnh báo hoặc tài khoản để lưu trữ.');
        await entityCommands.execute('archive', { expectedVersion: rule.version }, rule.id);
        if (scopeRef.current !== commandScope) return;
        setRetryCommand(null);
        setSuccessMessage('Đã lưu trữ luật cảnh báo.');
        await loadData();
      } catch (err) {
        if (scopeRef.current !== commandScope) return;
        setRetryCommand(entityCommands?.uncertain ? { type: 'archive' } : null);
        setError(err.message || 'Không thể xóa luật cảnh báo.');
      }
    };

    const retryEntityCommand = async () => {
      const commandScope = scope;
      if (!retryCommand || !entityCommands || scopeRef.current !== commandScope) return;
      const pending = retryCommand;
      setError('');
      setFormError('');
      setSubmitting(true);
      try {
        await entityCommands.retry();
        if (scopeRef.current !== commandScope) return;
        setRetryCommand(null);
        if (pending.type === 'create') {
          setSuccessMessage(`Đã tạo luật cảnh báo "${pending.title}" thành công.`);
          setIsCreating(false);
          setForm(defaultForm);
        } else if (pending.type === 'archive') {
          setSuccessMessage('Đã lưu trữ luật cảnh báo.');
        }
        await loadData();
      } catch (err) {
        if (scopeRef.current !== commandScope) return;
        setRetryCommand(entityCommands.uncertain ? pending : null);
        if (err?.status === 403 || err?.code === 'authority_denied') {
          setError('Bạn không có quyền cấu hình luật cảnh báo sự cố.');
        } else {
          setError(err.message || 'Không thể thử lại lệnh cấu hình luật cảnh báo.');
        }
      } finally {
        if (scopeRef.current === commandScope) setSubmitting(false);
      }
    };

    return h(
      'div',
      {
        'data-testid': 'rule-editor-view',
        style: {
          padding: 24,
          background: '#ffffff',
          borderRadius: 8,
          border: '1px solid #dcdfe6',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
        }
      },
      // Header
      h(
        'div',
        {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 20,
            borderBottom: '1px solid #eaedf3',
            paddingBottom: 16
          }
        },
        h(
          'div',
          null,
          h('h2', { style: { margin: '0 0 6px 0', fontSize: 20, color: '#172b4d', fontWeight: 600 } }, '⚙️ Cấu hình luật vượt ngưỡng (Rule Editor)'),
          h('p', { style: { margin: 0, fontSize: 13, color: '#5e6c84' } }, 'Tự động phát hiện bất thường từ cảm biến hiện trường và kích hoạt Case sự cố.')
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 10 } },
          h(
            'button',
            {
              type: 'button',
              'data-testid': 'open-create-rule-btn',
              disabled: !entityCommands || entityCommands.uncertain,
              onClick: () => {
                setIsCreating(!isCreating);
                setFormError('');
              },
              style: {
                padding: '8px 16px',
                background: '#0052cc',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                fontWeight: 600,
                fontSize: 13,
                cursor: 'pointer'
              }
            },
            isCreating ? 'Đóng biểu mẫu' : '+ Tạo luật mới'
          ),
          h(
            'button',
            {
              type: 'button',
              'data-testid': 'refresh-rules-btn',
              onClick: loadData,
              disabled: loading,
              style: {
                padding: '8px 14px',
                background: '#f4f5f7',
                color: '#172b4d',
                border: '1px solid #c1c7d0',
                borderRadius: 6,
                fontSize: 13,
                cursor: 'pointer'
              }
            },
            loading ? 'Đang tải…' : '⟳ Làm mới'
          )
        )
      ),

      // Messages
      error && h('div', { role: 'alert', 'data-testid': 'rule-editor-error', style: { padding: '10px 14px', background: '#ffebe6', color: '#bf2600', borderRadius: 6, marginBottom: 16, fontSize: 13 } }, error),
      successMessage && h('div', { role: 'status', 'data-testid': 'rule-editor-success', style: { padding: '10px 14px', background: '#e3fcef', color: '#006644', borderRadius: 6, marginBottom: 16, fontSize: 13 } }, successMessage),
      retryCommand && entityCommands?.uncertain && h('button', {
        type: 'button',
        'data-testid': 'retry-rule-command-btn',
        disabled: submitting,
        onClick: retryEntityCommand,
        style: { marginBottom: 16, padding: '7px 12px', background: '#fff7e6', color: '#ad6800', border: '1px solid #ffd591', borderRadius: 6, cursor: 'pointer', fontSize: 13 }
      }, submitting ? 'Đang thử lại…' : 'Thử lại lệnh cấu hình'),

      // Create / Edit Form
      isCreating &&
        h(
          'form',
          {
            'data-testid': 'create-rule-form',
            onSubmit: handleSaveRule,
            style: {
              background: '#fafbfc',
              border: '1px solid #dce2ea',
              borderRadius: 8,
              padding: 20,
              marginBottom: 24
            }
          },
          h('h4', { style: { margin: '0 0 16px 0', fontSize: 15, color: '#172b4d' } }, 'Thiết lập điều kiện giám sát mới'),
          formError && h('div', { role: 'alert', style: { color: '#de350b', marginBottom: 12, fontSize: 13 } }, formError),

          h(
            'div',
            { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 } },
            // Rule Name
            h(
              'div',
              null,
              h('label', { style: { display: 'block', fontSize: 12, fontWeight: 600, color: '#42526e', marginBottom: 4 } }, 'Tên luật *'),
              h('input', {
                'data-testid': 'rule-name-input',
                value: form.name,
                placeholder: 'Ví dụ: Cảnh báo quá nhiệt máy bơm P-101',
                onChange: e => {
                  const val = e.target.value;
                  setForm(prev => ({ ...prev, name: val }));
                },
                style: { width: '100%', padding: '7px 10px', borderRadius: 4, border: '1px solid #c1c7d0', fontSize: 13, boxSizing: 'border-box' }
              })
            ),
            // Asset Selection
            h(
              'div',
              null,
              h('label', { style: { display: 'block', fontSize: 12, fontWeight: 600, color: '#42526e', marginBottom: 4 } }, 'Tài sản giám sát (Asset ID) *'),
              visibleAssets.length > 0
                ? h(
                    'select',
                    {
                      'data-testid': 'rule-asset-select',
                      value: form.assetEntityId,
                      onChange: e => {
                        const val = e.target.value;
                        setForm(prev => ({ ...prev, assetEntityId: val }));
                      },
                      style: { width: '100%', padding: '7px 10px', borderRadius: 4, border: '1px solid #c1c7d0', fontSize: 13, boxSizing: 'border-box' }
                    },
                    h('option', { value: '' }, '-- Chọn tài sản --'),
                    visibleAssets.map(a => h('option', { key: a.id, value: a.id }, `${a.attributes?.assetCode || a.id} (${a.attributes?.title || a.attributes?.name || 'Tài sản'})`))
                  )
                : h('input', {
                    'data-testid': 'rule-asset-input',
                    value: form.assetEntityId,
                    placeholder: 'Nhập ID hoặc URN tài sản',
                    onChange: e => {
                      const val = e.target.value;
                      setForm(prev => ({ ...prev, assetEntityId: val }));
                    },
                    style: { width: '100%', padding: '7px 10px', borderRadius: 4, border: '1px solid #c1c7d0', fontSize: 13, boxSizing: 'border-box' }
                  })
            ),
            // Monitored Attribute
            h(
              'div',
              null,
              h('label', { style: { display: 'block', fontSize: 12, fontWeight: 600, color: '#42526e', marginBottom: 4 } }, 'Thuộc tính cảm biến *'),
              h(
                'select',
                {
                  'data-testid': 'rule-attribute-select',
                  value: form.attribute,
                  onChange: handleAttributeChange,
                  style: { width: '100%', padding: '7px 10px', borderRadius: 4, border: '1px solid #c1c7d0', fontSize: 13, boxSizing: 'border-box' }
                },
                Object.entries(attributeLabels).map(([k, v]) => h('option', { key: k, value: k }, v))
              )
            ),
            // Operator
            h(
              'div',
              null,
              h('label', { style: { display: 'block', fontSize: 12, fontWeight: 600, color: '#42526e', marginBottom: 4 } }, 'Toán tử so sánh *'),
              h(
                'select',
                {
                  'data-testid': 'rule-operator-select',
                  value: form.operator,
                  onChange: e => {
                    const val = e.target.value;
                    setForm(prev => ({ ...prev, operator: val }));
                  },
                  style: { width: '100%', padding: '7px 10px', borderRadius: 4, border: '1px solid #c1c7d0', fontSize: 13, boxSizing: 'border-box' }
                },
                Object.entries(operatorLabels).map(([k, v]) => h('option', { key: k, value: k }, v))
              )
            ),
            // Threshold
            h(
              'div',
              null,
              h('label', { style: { display: 'block', fontSize: 12, fontWeight: 600, color: '#42526e', marginBottom: 4 } }, `Ngưỡng kích hoạt (${form.unit}) *`),
              h('select', {
                'data-testid': 'rule-threshold-input',
                value: form.threshold,
                onChange: e => {
                  const val = e.target.value;
                  setForm(prev => ({ ...prev, threshold: val }));
                },
                style: { width: '100%', padding: '7px 10px', borderRadius: 4, border: '1px solid #c1c7d0', fontSize: 13, boxSizing: 'border-box' }
              }, thresholdChoices.map(value => h('option', { key: value, value }, value)))
            ),
            // Severity
            h(
              'div',
              null,
              h('label', { style: { display: 'block', fontSize: 12, fontWeight: 600, color: '#42526e', marginBottom: 4 } }, 'Mức độ nghiêm trọng *'),
              h(
                'select',
                {
                  'data-testid': 'rule-severity-select',
                  value: form.severity,
                  onChange: e => {
                    const val = e.target.value;
                    setForm(prev => ({ ...prev, severity: val }));
                  },
                  style: { width: '100%', padding: '7px 10px', borderRadius: 4, border: '1px solid #c1c7d0', fontSize: 13, boxSizing: 'border-box' }
                },
                Object.entries(severityColors).map(([k, v]) => h('option', { key: k, value: k }, v.label))
              )
            ),
            // Handler ID
            h(
              'div',
              null,
              h('label', { style: { display: 'block', fontSize: 12, fontWeight: 600, color: '#42526e', marginBottom: 4 } }, 'Kỹ thuật viên phụ trách *'),
              h('input', {
                'data-testid': 'rule-handler-input',
                value: form.handlerId,
                placeholder: 'Ví dụ: alice, warehouse',
                onChange: e => {
                  const val = e.target.value;
                  setForm(prev => ({ ...prev, handlerId: val }));
                },
                style: { width: '100%', padding: '7px 10px', borderRadius: 4, border: '1px solid #c1c7d0', fontSize: 13, boxSizing: 'border-box' }
              })
            ),
            // Cooldown
            h(
              'div',
              null,
              h('label', { style: { display: 'block', fontSize: 12, fontWeight: 600, color: '#42526e', marginBottom: 4 } }, 'Thời gian chờ chống lặp (Cooldown)'),
              h(
                'select',
                {
                  'data-testid': 'rule-cooldown-select',
                  value: form.cooldownSeconds,
                  onChange: e => {
                    const val = e.target.value;
                    setForm(prev => ({ ...prev, cooldownSeconds: val }));
                  },
                  style: { width: '100%', padding: '7px 10px', borderRadius: 4, border: '1px solid #c1c7d0', fontSize: 13, boxSizing: 'border-box' }
                },
                h('option', { value: '0' }, 'Không chờ (0 giây)'),
                h('option', { value: '60' }, '1 phút (60 giây)'),
                h('option', { value: '300' }, '5 phút (300 giây)'),
                h('option', { value: '900' }, '15 phút (900 giây)'),
                h('option', { value: '3600' }, '1 giờ (3600 giây)')
              )
            ),
            // Max Observation Age
            h(
              'div',
              null,
              h('label', { style: { display: 'block', fontSize: 12, fontWeight: 600, color: '#42526e', marginBottom: 4 } }, 'Tuổi dữ liệu hợp lệ tối đa'),
              h(
                'select',
                {
                  'data-testid': 'rule-max-age-select',
                  value: form.maxObservationAgeSeconds,
                  onChange: e => {
                    const val = e.target.value;
                    setForm(prev => ({ ...prev, maxObservationAgeSeconds: val }));
                  },
                  style: { width: '100%', padding: '7px 10px', borderRadius: 4, border: '1px solid #c1c7d0', fontSize: 13, boxSizing: 'border-box' }
                },
                h('option', { value: '30' }, '30 giây'),
                h('option', { value: '60' }, '1 phút (60 giây)'),
                h('option', { value: '120' }, '2 phút (120 giây)'),
                h('option', { value: '300' }, '5 phút (300 giây)'),
                h('option', { value: '600' }, '10 phút (600 giây)')
              )
            )
          ),

          // Action Target & Enabled
          h(
            'div',
            { style: { marginTop: 14, display: 'flex', alignItems: 'center', gap: 20 } },
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                'data-testid': 'rule-enabled-checkbox',
                checked: form.enabled,
                onChange: e => {
                  const checked = e.target.checked;
                  setForm(prev => ({ ...prev, enabled: checked }));
                }
              }),
              'Kích hoạt luật ngay sau khi lưu'
            ),
            h('span', { style: { fontSize: 12, color: '#6b778c' } }, '🎯 Tác vụ kích hoạt: Khởi tạo quy trình "incident-response" v1')
          ),

          // Submit / Cancel Buttons
          h(
            'div',
            { style: { marginTop: 18, display: 'flex', gap: 10 } },
            h(
              'button',
              {
                type: 'submit',
                'data-testid': 'save-rule-btn',
                disabled: submitting || !entityCommands || entityCommands.uncertain,
                style: {
                  padding: '8px 18px',
                  background: '#0052cc',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: 'pointer'
                }
              },
              submitting ? 'Đang lưu…' : 'Lưu luật'
            ),
            h(
              'button',
              {
                type: 'button',
                'data-testid': 'cancel-create-rule-btn',
                onClick: () => setIsCreating(false),
                style: {
                  padding: '8px 14px',
                  background: '#f4f5f7',
                  color: '#42526e',
                  border: '1px solid #dfe1e6',
                  borderRadius: 6,
                  fontSize: 13,
                  cursor: 'pointer'
                }
              },
              'Hủy'
            )
          )
        ),

      // Rules Table
      visibleRules.length === 0 && !loading
        ? h(
            'div',
            {
              'data-testid': 'empty-rules-msg',
              style: {
                padding: '40px 20px',
                textAlign: 'center',
                color: '#6b778c',
                background: '#f9fafb',
                borderRadius: 8,
                border: '1px dashed #dce2ea'
              }
            },
            h('p', { style: { margin: 0, fontSize: 14 } }, 'Chưa có luật cảnh báo nào được cấu hình.'),
            h('p', { style: { margin: '6px 0 0 0', fontSize: 12 } }, 'Nhấp "+ Tạo luật mới" để thiết lập ngưỡng giám sát cho tài sản.')
          )
        : h(
            'div',
            { style: { overflowX: 'auto' } },
            h(
              'table',
              {
                'data-testid': 'rules-table',
                style: { width: '100%', borderCollapse: 'collapse', fontSize: 13 }
              },
              h(
                'thead',
                null,
                h(
                  'tr',
                  { style: { background: '#f4f5f7', color: '#5e6c84', textAlign: 'left', borderBottom: '1px solid #dfe1e6' } },
                  h('th', { style: { padding: '10px 12px' } }, 'Tên luật'),
                  h('th', { style: { padding: '10px 12px' } }, 'Tài sản'),
                  h('th', { style: { padding: '10px 12px' } }, 'Điều kiện kích hoạt'),
                  h('th', { style: { padding: '10px 12px' } }, 'Mức độ'),
                  h('th', { style: { padding: '10px 12px' } }, 'Người phụ trách'),
                  h('th', { style: { padding: '10px 12px' } }, 'Trạng thái'),
                  h('th', { style: { padding: '10px 12px' } }, 'Thao tác')
                )
              ),
              h(
                'tbody',
                null,
                visibleRules.map((rule, idx) => {
                  const attrs = rule.attributes || rule;
                  const severityStyle = severityColors[attrs.severity] || severityColors.medium;
                  return h(
                    'tr',
                    {
                      key: rule.id || idx,
                      'data-testid': `rule-row-${rule.id || idx}`,
                      style: { borderBottom: '1px solid #eaedf3' }
                    },
                    h(
                      'td',
                      { style: { padding: '10px 12px' } },
                      h('div', { style: { fontWeight: 600, color: '#172b4d' } }, rule.title || 'Chưa đặt tên'),
                      h('div', { style: { fontSize: 11, color: '#6b778c' } }, rule.id)
                    ),
                    h('td', { style: { padding: '10px 12px', color: '#172b4d' } }, attrs.assetEntityId || '—'),
                    h(
                      'td',
                      { style: { padding: '10px 12px', color: '#172b4d' } },
                      h(
                        'code',
                        { style: { background: '#f4f5f7', padding: '2px 6px', borderRadius: 4, fontSize: 12 } },
                        `${attrs.attribute || 'temperature'} ${operatorSymbols[attrs.operator] || attrs.operator} ${attrs.threshold} ${attrs.unit || ''}`
                      )
                    ),
                    h(
                      'td',
                      { style: { padding: '10px 12px' } },
                      h(
                        'span',
                        {
                          style: {
                            display: 'inline-block',
                            padding: '2px 8px',
                            borderRadius: 4,
                            background: severityStyle.bg,
                            color: severityStyle.color,
                            border: `1px solid ${severityStyle.border}`,
                            fontWeight: 600,
                            fontSize: 11
                          }
                        },
                        severityStyle.label
                      )
                    ),
                    h('td', { style: { padding: '10px 12px', color: '#42526e' } }, attrs.handlerId || 'alice'),
                    h(
                      'td',
                      { style: { padding: '10px 12px' } },
                      h(
                        'button',
                        {
                          type: 'button',
                          'data-testid': `toggle-rule-btn-${rule.id || idx}`,
                          disabled: !entityCommands || entityCommands.uncertain,
                          onClick: () => handleToggleRule(rule),
                          style: {
                            padding: '3px 8px',
                            borderRadius: 4,
                            border: '1px solid',
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: 'pointer',
                            background: attrs.enabled ? '#e3fcef' : '#f4f5f7',
                            color: attrs.enabled ? '#006644' : '#6b778c',
                            borderColor: attrs.enabled ? '#abf5d1' : '#dfe1e6'
                          }
                        },
                        attrs.enabled ? 'Đang bật' : 'Đã tắt'
                      )
                    ),
                    h(
                      'td',
                      { style: { padding: '10px 12px' } },
                      h(
                        'button',
                        {
                          type: 'button',
                          'data-testid': `archive-rule-btn-${rule.id || idx}`,
                          disabled: !entityCommands || entityCommands.uncertain,
                          onClick: () => handleArchiveRule(rule),
                          style: {
                            padding: '3px 8px',
                            background: 'transparent',
                            color: '#de350b',
                            border: '1px solid #ffbdad',
                            borderRadius: 4,
                            fontSize: 11,
                            cursor: 'pointer'
                          }
                        },
                        'Lưu trữ'
                      )
                    )
                  );
                })
              )
            )
          )
    );
  };
}

module.exports = { createRuleEditorComponent };
