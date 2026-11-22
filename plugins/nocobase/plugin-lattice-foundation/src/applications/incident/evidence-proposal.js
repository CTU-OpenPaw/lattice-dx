/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const { createWorkflowCommands } = require('../../client/workflow');

function validProposal(value) {
  return value && typeof value === 'object'
    && typeof value.summary === 'string' && value.summary.trim().length > 0
    && ['ready', 'in_use', 'repair', 'retired'].includes(value.suggestedStatus)
    && Array.isArray(value.evidence) && value.evidence.length <= 20
    && value.evidence.every(item => typeof item === 'string' && item.trim().length > 0);
}

function createEvidenceProposalComponent(React) {
  const h = React.createElement;

  const statusMap = {
    repair: { label: 'Yêu cầu sửa chữa (Repair)', color: '#d4380d', bg: '#fff2e8', border: '#ffbb96', icon: '🛠️' },
    ready: { label: 'Sẵn sàng hoạt động (Ready)', color: '#389e0d', bg: '#f6ffed', border: '#b7eb8f', icon: '✅' },
    in_use: { label: 'Tiếp tục vận hành (In Use)', color: '#0958d9', bg: '#e6f4ff', border: '#91caff', icon: '⚡' },
    retired: { label: 'Thanh lý / Ngừng sử dụng (Retired)', color: '#595959', bg: '#f5f5f5', border: '#d9d9d9', icon: '⛔' }
  };

  return function EvidenceProposal({
    api,
    connection,
    caseItem,
    onApprove,
    onReject,
    onRework
  }) {
    const connected = connection?.connected === true;
    const actorId = connection?.identity?.subject;
    const organizationId = connection?.identity?.organizationId;
    const runId = caseItem?.id || caseItem?.runId;
    const agentJobId = caseItem?.data?.agentJobId;
    const expectedProposalId = caseItem?.data?.proposalId;
    const expectedAssetId = caseItem?.data?.assetEntityId || caseItem?.assetEntityId;
    const expectedNotificationId = caseItem?.data?.notificationId || caseItem?.notificationId;
    const scope = React.useMemo(() => ({ api, connected, actorId, organizationId, runId, agentJobId, expectedProposalId, expectedAssetId, expectedNotificationId }),
      [api, connected, actorId, organizationId, runId, agentJobId, expectedProposalId, expectedAssetId, expectedNotificationId]);
    const scopeRef = React.useRef(scope);
    scopeRef.current = scope;
    const loadEpoch = React.useRef(0);
    const workflowCommands = React.useMemo(() => api?.workflow && connected && actorId
      ? createWorkflowCommands({ api, actorId })
      : null, [api, connected, actorId, organizationId, runId, agentJobId, expectedProposalId]);
    const [activeTab, setActiveTab] = React.useState('proposal'); // 'proposal' | 'evidence' | 'review'
    const [actionNote, setActionNote] = React.useState('');
    const [actionBusy, setActionBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const [successMessage, setSuccessMessage] = React.useState('');
    const [job, setJob] = React.useState(null);
    const [jobScope, setJobScope] = React.useState(null);
    const [loading, setLoading] = React.useState(false);
    const [retryCommand, setRetryCommand] = React.useState(null);
    const visibleJob = jobScope === scope ? job : null;
    const proposalReady = visibleJob?.status === 'completed' && validProposal(visibleJob.proposal);
    const proposalData = proposalReady ? visibleJob.proposal : null;
    const suggested = proposalData ? statusMap[proposalData.suggestedStatus] : null;
    const caseStatus = caseItem?.status || 'review_pending';

    const loadJob = React.useCallback(async () => {
      const requestScope = scope;
      const request = ++loadEpoch.current;
      const current = () => scopeRef.current === requestScope && loadEpoch.current === request;
      setJob(null);
      setJobScope(null);
      setError('');
      if (!connected) {
        if (current()) {
          setError('Kết nối tài khoản nghiệp vụ để tải kết quả phân tích.');
          setLoading(false);
        }
        return;
      }
      if (!agentJobId || !expectedProposalId || !expectedAssetId || !expectedNotificationId) {
        if (current()) {
          setJobScope(requestScope);
          setError('Chưa có kết quả phân tích được liên kết với hồ sơ sự cố này.');
          setLoading(false);
        }
        return;
      }
      if (!api?.agent) {
        if (current()) {
          setJobScope(requestScope);
          setError('Không có dịch vụ agent để đọc kết quả phân tích.');
          setLoading(false);
        }
        return;
      }
      setLoading(true);
      try {
        const loadedJob = await api.agent('detail', { id: agentJobId });
        if (!current()) return;
        if (loadedJob?.id !== agentJobId || loadedJob?.runId !== runId || loadedJob?.assetId !== expectedAssetId
          || loadedJob?.notificationId !== expectedNotificationId || loadedJob?.proposalId !== expectedProposalId) {
          throw new Error('Kết quả phân tích không khớp với hồ sơ sự cố, tài sản hoặc notification đã liên kết.');
        }
        setJob(loadedJob);
        setJobScope(requestScope);
        if (loadedJob.status !== 'completed' || !validProposal(loadedJob.proposal)) {
          setError('Chưa có kết quả phân tích hoàn tất để phê duyệt.');
        }
      } catch (err) {
        if (!current()) return;
        setJob(null);
        setJobScope(requestScope);
        setError(err.message || 'Không thể tải thông tin tác vụ AI.');
      } finally {
        if (current()) setLoading(false);
      }
    }, [api, connected, scope, agentJobId, expectedProposalId, expectedAssetId, expectedNotificationId, runId]);

    React.useEffect(() => {
      loadEpoch.current++;
      setJob(null);
      setJobScope(null);
      setRetryCommand(null);
      setActionBusy(false);
      setActionNote('');
      setSuccessMessage('');
      loadJob();
      return () => { loadEpoch.current++; };
    }, [loadJob, scope]);

    const performTransition = async (action, input, successText, callback) => {
      const commandScope = scope;
      if (!caseItem?.id || !workflowCommands || scopeRef.current !== commandScope) {
        setError('Chưa kết nối tài khoản hoặc dịch vụ quy trình.');
        return;
      }
      if (['approve', 'reject'].includes(action) && !proposalReady) {
        setError('Chưa có kết quả phân tích hợp lệ để duyệt hoặc từ chối.');
        return;
      }
      setActionBusy(true);
      setError('');
      try {
        await workflowCommands.execute('transition', { action, expectedVersion: caseItem.version, input }, caseItem.id);
        if (scopeRef.current !== commandScope) return;
        setRetryCommand(null);
        setSuccessMessage(successText);
        setActionNote('');
        callback?.();
      } catch (err) {
        if (scopeRef.current !== commandScope) return;
        setRetryCommand(workflowCommands.uncertain ? { action, input, successText } : null);
        setError(err.status === 403 || err.response?.status === 403
          ? 'Bạn không có quyền thực hiện thao tác workflow này.'
          : (err.message || 'Thao tác workflow thất bại.'));
      } finally {
        if (scopeRef.current === commandScope) setActionBusy(false);
      }
    };

    const handleApprove = async () => {
      const reviewNote = actionNote.trim() || 'Người quản lý duyệt đề xuất xử lý của AI';
      await performTransition('approve', { reviewNote }, 'Đã phê duyệt đề xuất thành công. Quy trình chuyển sang bước khắc phục.', () => onApprove?.(reviewNote));
    };

    const handleReject = async () => {
      if (!actionNote.trim()) {
        setError('Vui lòng nhập lý do từ chối đề xuất xử lý.');
        return;
      }
      const reason = actionNote.trim();
      await performTransition('reject', { reason }, 'Đã từ chối đề xuất xử lý.', () => onReject?.(reason));
    };

    const handleRework = async () => {
      const reworkNote = actionNote.trim() || 'Yêu cầu kiểm tra lại hiện trường';
      await performTransition('rework', { reworkNote }, 'Đã chuyển yêu cầu kiểm tra lại (Rework) cho kỹ thuật viên.', () => onRework?.(reworkNote));
    };

    const retryWorkflowCommand = async () => {
      const commandScope = scope;
      if (!retryCommand || !workflowCommands || scopeRef.current !== commandScope) return;
      const pending = retryCommand;
      setActionBusy(true);
      setError('');
      try {
        await workflowCommands.retry();
        if (scopeRef.current !== commandScope) return;
        setRetryCommand(null);
        setSuccessMessage(pending.successText);
        setActionNote('');
        if (pending.action === 'approve') onApprove?.(pending.input.reviewNote);
        if (pending.action === 'reject') onReject?.(pending.input.reason);
        if (pending.action === 'rework') onRework?.(pending.input.reworkNote);
      } catch (err) {
        if (scopeRef.current !== commandScope) return;
        setRetryCommand(workflowCommands.uncertain ? pending : null);
        setError(err.status === 403 || err.response?.status === 403
          ? 'Bạn không có quyền thực hiện thao tác workflow này.'
          : (err.message || 'Thử lại workflow thất bại.'));
      } finally {
        if (scopeRef.current === commandScope) setActionBusy(false);
      }
    };

    return h('div', {
      'data-testid': 'lattice-evidence-proposal-block',
      style: {
        padding: 16,
        background: '#ffffff',
        borderRadius: 8,
        border: '1px solid #dce3ed',
        marginTop: 16
      }
    },
      // Header
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 16 } },
        h('div', null,
          h('h4', { style: { margin: '0 0 4px 0', fontSize: 16, fontWeight: 700, color: '#172b4d' } },
            '📑 Đề xuất Giải pháp & Bằng chứng Nguồn (Evidence & AI Proposal)'
          ),
          h('p', { style: { margin: 0, fontSize: 12, color: '#5e6c84' } },
            'Kết quả phân tích nguyên nhân sự cố, trích dẫn chứng cứ số đo và đề xuất trạng thái tài sản từ AI Agent.'
          )
        ),
        h('div', {
          'data-testid': 'lattice-proposal-status-tag',
          style: {
            padding: '4px 10px',
            borderRadius: 6,
            background: suggested?.bg || '#f5f5f5',
            color: suggested?.color || '#595959',
            border: `1px solid ${suggested?.border || '#d9d9d9'}`,
            fontSize: 12,
            fontWeight: 700
          }
        }, suggested ? `${suggested.icon} ${suggested.label}` : 'Chưa có kết quả phân tích'),
        h('button', {
          type: 'button',
          'data-testid': 'lattice-proposal-refresh-btn',
          disabled: loading || !connected,
          onClick: loadJob,
          style: { padding: '4px 8px', borderRadius: 4, border: '1px solid #cbd5e1', background: '#fff', fontSize: 12, cursor: 'pointer' }
        }, loading ? 'Đang tải…' : 'Tải kết quả')
      ),

      error && h('div', { role: 'alert', 'data-testid': 'lattice-proposal-error', style: { padding: '8px 12px', background: '#fff1f0', color: '#cf1322', border: '1px solid #ffa39e', borderRadius: 6, fontSize: 13, marginBottom: 12 } }, error),
      successMessage && h('div', { role: 'status', style: { padding: '8px 12px', background: '#f6ffed', color: '#389e0d', border: '1px solid #b7eb8f', borderRadius: 6, fontSize: 13, marginBottom: 12 } }, successMessage),
      retryCommand && workflowCommands?.uncertain && h('button', {
        type: 'button',
        'data-testid': 'lattice-proposal-retry-command-btn',
        disabled: actionBusy || !connected,
        onClick: retryWorkflowCommand,
        style: { marginBottom: 12, padding: '7px 12px', background: '#fff7e6', color: '#ad6800', border: '1px solid #ffd591', borderRadius: 6, cursor: 'pointer', fontSize: 13 }
      }, actionBusy ? 'Đang thử lại…' : 'Thử lại thao tác'),

      // Navigation Tabs
      h('div', { style: { display: 'flex', borderBottom: '1px solid #dfe1e6', marginBottom: 16 } },
        h('button', {
          type: 'button',
          'data-testid': 'lattice-tab-proposal-btn',
          onClick: () => setActiveTab('proposal'),
          style: {
            padding: '8px 16px',
            border: 'none',
            background: 'transparent',
            borderBottom: activeTab === 'proposal' ? '2px solid #0052cc' : '2px solid transparent',
            color: activeTab === 'proposal' ? '#0052cc' : '#5e6c84',
            fontWeight: activeTab === 'proposal' ? 700 : 500,
            cursor: 'pointer',
            fontSize: 13
          }
        }, '💡 Nội dung đề xuất'),
        h('button', {
          type: 'button',
          'data-testid': 'lattice-tab-evidence-btn',
          onClick: () => setActiveTab('evidence'),
          style: {
            padding: '8px 16px',
            border: 'none',
            background: 'transparent',
            borderBottom: activeTab === 'evidence' ? '2px solid #0052cc' : '2px solid transparent',
            color: activeTab === 'evidence' ? '#0052cc' : '#5e6c84',
            fontWeight: activeTab === 'evidence' ? 700 : 500,
            cursor: 'pointer',
            fontSize: 13
          }
        }, `🔍 Bằng chứng trích dẫn (${proposalData?.evidence.length || 0})`),
        h('button', {
          type: 'button',
          'data-testid': 'lattice-tab-review-btn',
          onClick: () => setActiveTab('review'),
          style: {
            padding: '8px 16px',
            border: 'none',
            background: 'transparent',
            borderBottom: activeTab === 'review' ? '2px solid #0052cc' : '2px solid transparent',
            color: activeTab === 'review' ? '#0052cc' : '#5e6c84',
            fontWeight: activeTab === 'review' ? 700 : 500,
            cursor: 'pointer',
            fontSize: 13
          }
        }, '⚖️ Phê duyệt đề xuất')
      ),

      // TAB 1: Proposal Content
      activeTab === 'proposal' && h('div', { 'data-testid': 'lattice-proposal-content-view' },
        proposalData ? h('div', { style: { padding: 14, background: '#f8fafc', borderRadius: 6, border: '1px solid #e2e8f0', marginBottom: 14 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 6 } },
            h('span', { style: { fontSize: 12, fontWeight: 700, color: '#0958d9' } }, '📋 TỔNG KẾT NGUYÊN NHÂN & PHƯƠNG ÁN XỬ LÝ:'),
            h('span', { style: { fontSize: 11, color: '#5e6c84' } }, `Mã đề xuất: ${visibleJob.proposalId}`)
          ),
          h('p', {
            'data-testid': 'lattice-proposal-summary-text',
            style: { margin: 0, fontSize: 13, lineHeight: 1.6, color: '#172b4d' }
          }, proposalData.summary)
        ) : h('div', { role: 'status', 'data-testid': 'lattice-proposal-no-result', style: { padding: 14, background: '#f8fafc', borderRadius: 6, border: '1px solid #e2e8f0', color: '#5e6c84', fontSize: 13 } }, loading ? 'Đang tải kết quả phân tích…' : 'Chưa có kết quả phân tích hoàn tất được liên kết với hồ sơ này.')
      ),

      // TAB 2: Evidence Ledger
      activeTab === 'evidence' && h('div', { 'data-testid': 'lattice-evidence-ledger-view' },
        h('div', { style: { marginBottom: 10, fontSize: 12, color: '#5e6c84' } },
          'Bằng chứng xác thực nguồn dữ liệu vi phạm ngưỡng (Data Provenance & Citations):'
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          ...(proposalData?.evidence || []).map((item, idx) => h('div', {
            key: idx,
            'data-testid': `lattice-evidence-item-${idx}`,
            style: {
              padding: '10px 12px',
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: 6,
              fontSize: 13,
              color: '#172b4d',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8
            }
          },
            h('span', { style: { color: '#0958d9', fontWeight: 700 } }, `[E${idx + 1}]`),
            h('span', { style: { flex: 1 } }, item)
          ))
        ),
        h('div', { style: { marginTop: 14, padding: 10, background: '#fafafa', borderRadius: 6, border: '1px dashed #d9d9d9', fontSize: 11, color: '#8c8c8c' } },
          '🔒 Đề xuất được lưu trữ với tính bất biến (Immutable Result) tại bảng incident_agent_decisions; không bị ghi đè khi cập nhật hồ sơ sau này.'
        )
      ),

      // TAB 3: Manager Review Panel
      activeTab === 'review' && h('div', { 'data-testid': 'lattice-proposal-review-view' },
        h('div', { style: { padding: 12, background: '#f8fafc', borderRadius: 6, border: '1px solid #e2e8f0', marginBottom: 16 } },
          h('div', { style: { fontSize: 12, color: '#5e6c84', marginBottom: 4 } }, 'Trạng thái phê duyệt hiện tại:'),
          h('div', { style: { fontSize: 14, fontWeight: 700, color: '#172b4d' } },
            caseStatus === 'review_pending' ? 'Chờ Quản lý xem xét và phê duyệt đề xuất'
              : caseStatus === 'approved' ? '✅ Đề xuất đã được duyệt'
              : caseStatus === 'rejected' ? '❌ Đề xuất đã bị từ chối'
              : `Trạng thái hồ sơ: ${caseStatus}`
          ),
          !proposalReady && h('p', { role: 'alert', style: { margin: '10px 0 0 0', color: '#cf1322', fontSize: 13 } }, 'Chưa có kết quả phân tích hợp lệ. Phê duyệt và từ chối đang bị khóa.')
        ),

        (caseStatus === 'review_pending' || caseStatus === 'rejected') && h('div', null,
          h('label', { style: { display: 'block', fontSize: 12, fontWeight: 600, color: '#344563', marginBottom: 6 } },
            'Ý kiến chỉ đạo / Ghi chú phê duyệt hoặc Lý do từ chối:'
          ),
          h('textarea', {
            'data-testid': 'lattice-review-note-input',
            rows: 3,
            placeholder: 'Nhập ghi chú chỉ đạo hoặc lý do...',
            value: actionNote,
            onChange: e => setActionNote(e.target.value),
            style: { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13, marginBottom: 12 }
          }),

          caseStatus === 'review_pending' && h('div', { style: { display: 'flex', gap: 10 } },
            h('button', {
              type: 'button',
              'data-testid': 'lattice-proposal-approve-btn',
              disabled: actionBusy || !proposalReady || !workflowCommands || workflowCommands.uncertain,
              onClick: handleApprove,
              style: {
                padding: '8px 18px',
                borderRadius: 6,
                background: '#389e0d',
                color: '#fff',
                border: 'none',
                fontWeight: 600,
                fontSize: 13,
                cursor: 'pointer'
              }
            }, actionBusy ? 'Đang duyệt…' : '✅ Phê duyệt đề xuất'),
            h('button', {
              type: 'button',
              'data-testid': 'lattice-proposal-reject-btn',
              disabled: actionBusy || !proposalReady || !workflowCommands || workflowCommands.uncertain,
              onClick: handleReject,
              style: {
                padding: '8px 18px',
                borderRadius: 6,
                background: '#cf1322',
                color: '#fff',
                border: 'none',
                fontWeight: 600,
                fontSize: 13,
                cursor: 'pointer'
              }
            }, actionBusy ? 'Đang từ chối…' : '❌ Từ chối đề xuất')
          ),

          caseStatus === 'rejected' && h('div', null,
            h('button', {
              type: 'button',
              'data-testid': 'lattice-proposal-rework-btn',
              disabled: actionBusy || !workflowCommands || workflowCommands.uncertain,
              onClick: handleRework,
              style: {
                padding: '8px 18px',
                borderRadius: 6,
                background: '#d46b08',
                color: '#fff',
                border: 'none',
                fontWeight: 600,
                fontSize: 13,
                cursor: 'pointer'
              }
            }, actionBusy ? 'Đang gửi…' : '🔄 Yêu cầu kiểm tra lại (Rework)')
          )
        ),

        caseStatus === 'approved' && proposalReady && h('div', {
          style: { padding: 12, background: '#f6ffed', color: '#237804', border: '1px solid #b7eb8f', borderRadius: 6, fontSize: 13 }
        }, 'Đề xuất đã được duyệt thành công. Kỹ thuật viên phụ trách có thể thực hiện khắc phục sự cố tại hiện trường.')
      )
    );
  };
}

module.exports = { createEvidenceProposalComponent };
