// SPDX-License-Identifier: Apache-2.0
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

  const severityColors = {

    low: { bg: '#e6f4ff', color: '#0958d9', border: '#91caff', label: 'Thấp' },
    medium: { bg: '#fffbe6', color: '#d46b08', border: '#ffe58f', label: 'Trung bình' },
    high: { bg: '#fff2e8', color: '#d4380d', border: '#ffbb96', label: 'Cao' },
    critical: { bg: '#fff1f0', color: '#cf1322', border: '#ffa39e', label: 'Khẩn cấp' }
  };

  const defaultForm = {
    code: '',
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
    const connected = connection?.connected !== false;
    const [rules, setRules] = React.useState([]);
    const [assets, setAssets] = React.useState([]);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState('');
    const [successMessage, setSuccessMessage] = React.useState('');
    const [isCreating, setIsCreating] = React.useState(false);
    const [form, setForm] = React.useState(defaultForm);
    const [formError, setFormError] = React.useState('');
    const [submitting, setSubmitting] = React.useState(false);

    const loadData = React.useCallback(async () => {
      if (!connected || !api) return;
      setLoading(true);
      setError('');
      try {
        let loadedRules = [];
        if (api.entity) {
          try {
            const res = await api.entity('list', { schemaId: 'incident-rule', limit: '100', offset: '0' });
            loadedRules = res?.items || [];
          } catch {
            // If entity schema list is not present, fallback to empty or custom endpoint
          }
        }
        setRules(loadedRules);

        let loadedAssets = [];
        if (api.entity) {
          try {
            const assetRes = await api.entity('list', { schemaId: 'asset', limit: '100', offset: '0' });
            loadedAssets = assetRes?.items || [];
          } catch {}
        }
        setAssets(loadedAssets);
      } catch (err) {
        setError(err.message || 'Không thể tải danh sách luật cảnh báo.');
      } finally {
        setLoading(false);
      }
    }, [api, connected]);

    React.useEffect(() => {
      loadData();
    }, [loadData]);

    const handleAttributeChange = e => {
      const attr = e.target.value;
      const unit = attr === 'temperature' ? 'celsius' : 'percent';
      const threshold = attr === 'temperature' ? '60' : '20';
      setForm(prev => ({ ...prev, attribute: attr, unit, threshold }));
    };

    const handleSaveRule = async e => {
      e?.preventDefault?.();
      setFormError('');
      setSuccessMessage('');

      if (!form.code.trim()) {
        setFormError('Vui lòng nhập mã luật cảnh báo.');
        return;
      }
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
        const payload = {
          code: form.code.trim(),
          name: form.name.trim(),
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

        let created;
        if (api?.entity) {
          created = await api.entity('create', {
            schemaId: 'incident-rule',
            body: payload,
            key: 'rule-create-' + Date.now()
          });
        }

        const newRule = created || { id: 'rule-' + Date.now(), attributes: payload };
        setRules(prev => [newRule, ...prev]);
        setSuccessMessage(`Đã tạo luật cảnh báo "${payload.name}" thành công.`);
        setIsCreating(false);
        setForm(defaultForm);
      } catch (err) {
        if (err?.status === 403 || err?.code === 'authority_denied') {
          setFormError('Bạn không có quyền cấu hình luật cảnh báo sự cố.');
        } else {
          setFormError(err.message || 'Lỗi khi lưu luật cảnh báo.');
        }
      } finally {
        setSubmitting(false);
      }
    };

    const handleToggleRule = async (rule, index) => {
      const currentAttrs = rule.attributes || rule;
      const updatedEnabled = !currentAttrs.enabled;
      try {
        if (api?.entity && rule.id) {
          await api.entity('update', {
            id: rule.id,
            body: { ...currentAttrs, enabled: updatedEnabled },
            key: 'rule-toggle-' + Date.now()
          });
        }
        setRules(prev => {
          const clone = [...prev];
          const target = clone[index];
          if (target.attributes) {
            target.attributes = { ...target.attributes, enabled: updatedEnabled };
          } else {
            clone[index] = { ...target, enabled: updatedEnabled };
          }
          return clone;
        });
      } catch (err) {
        setError(err.message || 'Không thể thay đổi trạng thái kích hoạt.');
      }
    };

    const handleDeleteRule = async (ruleId, index) => {
      try {
        if (api?.entity && ruleId) {
          await api.entity('delete', { id: ruleId, key: 'rule-del-' + Date.now() });
        }
        setRules(prev => prev.filter((_, i) => i !== index));
        setSuccessMessage('Đã xóa luật cảnh báo.');
      } catch (err) {
        setError(err.message || 'Không thể xóa luật cảnh báo.');
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
            // Rule Code
            h(
              'div',
              null,
              h('label', { style: { display: 'block', fontSize: 12, fontWeight: 600, color: '#42526e', marginBottom: 4 } }, 'Mã luật *'),
              h('input', {
                'data-testid': 'rule-code-input',
                value: form.code,
                placeholder: 'Ví dụ: RULE-TEMP-01',
                onChange: e => {
                  const val = e.target.value;
                  setForm(prev => ({ ...prev, code: val }));
                },
                style: { width: '100%', padding: '7px 10px', borderRadius: 4, border: '1px solid #c1c7d0', fontSize: 13, boxSizing: 'border-box' }
              })
            ),
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
              assets.length > 0
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
                    assets.map(a => h('option', { key: a.id, value: a.id }, `${a.attributes?.assetCode || a.id} (${a.attributes?.title || a.attributes?.name || 'Tài sản'})`))
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
              h('input', {
                type: 'number',
                'data-testid': 'rule-threshold-input',
                value: form.threshold,
                onChange: e => {
                  const val = e.target.value;
                  setForm(prev => ({ ...prev, threshold: val }));
                },
                style: { width: '100%', padding: '7px 10px', borderRadius: 4, border: '1px solid #c1c7d0', fontSize: 13, boxSizing: 'border-box' }
              })
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
                disabled: submitting,
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
      rules.length === 0 && !loading
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
                  h('th', { style: { padding: '10px 12px' } }, 'Mã / Tên luật'),
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
                rules.map((rule, idx) => {
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
                      h('div', { style: { fontWeight: 600, color: '#172b4d' } }, attrs.name || 'Chưa đặt tên'),
                      h('div', { style: { fontSize: 11, color: '#6b778c' } }, attrs.code || rule.id)
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
                          onClick: () => handleToggleRule(rule, idx),
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
                          'data-testid': `delete-rule-btn-${rule.id || idx}`,
                          onClick: () => handleDeleteRule(rule.id, idx),
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
                        'Xóa'
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
