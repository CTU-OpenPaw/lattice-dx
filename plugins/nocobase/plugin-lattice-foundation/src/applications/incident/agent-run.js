/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const { createWorkflowCommands } = require('../../client/workflow');

function createAgentRunComponent(React) {
  const h = React.createElement;

  const errorMessages = {
    model_unavailable: 'Dịch vụ mô hình AI (Model Runtime) tạm thời không phản hồi. Vui lòng thử lại sau giây lát.',
    tool_denied: 'Agent bị từ chối quyền truy cập dữ liệu cảm biến hoặc tài sản do chính sách bảo mật hoặc giới hạn phạm vi.',
    invalid_output: 'Kết quả phân tích từ mô hình AI không đúng định dạng cấu trúc chuẩn (JSON schema).',
    worker_error: 'Tiến trình worker gặp sự cố nội bộ trong quá trình thực thi phân tích.',
    timed_out: 'Tác vụ phân tích đã vượt quá thời gian tối đa quy định (300 giây).'
  };

  return function AgentRun({ api, connection, caseItem, runId, onJobUpdate, onTransition }) {
    const connected = connection?.connected === true;
    const actorId = connection?.identity?.subject;
    const organizationId = connection?.identity?.organizationId;
    const currentRunId = runId || caseItem?.id || caseItem?.runId;
    const runData = caseItem?.data || {};
    const agentJobId = runData.agentJobId;
    const expectedProposalId = runData.proposalId;
    const expectedAssetId = runData.assetEntityId || caseItem?.assetEntityId;
    const expectedNotificationId = runData.notificationId || caseItem?.notificationId;
    const scope = React.useMemo(() => ({ api, connected, actorId, organizationId, currentRunId, agentJobId, expectedProposalId, expectedAssetId, expectedNotificationId }),
      [api, connected, actorId, organizationId, currentRunId, agentJobId, expectedProposalId, expectedAssetId, expectedNotificationId]);
    const scopeRef = React.useRef(scope);
    scopeRef.current = scope;
    const loadEpoch = React.useRef(0);
    const workflowCommands = React.useMemo(() => api?.workflow && connected && actorId
      ? createWorkflowCommands({ api, actorId })
      : null, [api, connected, actorId, organizationId, currentRunId]);
    const agentCommands = React.useMemo(() => api?.agent && connected && actorId
      ? createWorkflowCommands({ api, actorId, channel: 'agent' })
      : null, [api, connected, actorId, organizationId, currentRunId, agentJobId]);

    const [jobData, setJobData] = React.useState(null);
    const [jobScope, setJobScope] = React.useState(null);
    const job = jobScope === scope ? jobData : null;
    const [loading, setLoading] = React.useState(false);
    const [actionBusy, setActionBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const [successMessage, setSuccessMessage] = React.useState('');
    const [retryCommand, setRetryCommand] = React.useState(null);
    const [startRequested, setStartRequested] = React.useState(false);

    const loadJob = React.useCallback(async () => {
      const requestScope = scope;
      const request = ++loadEpoch.current;
      const current = () => scopeRef.current === requestScope && loadEpoch.current === request;
      setJobData(null);
      setJobScope(null);
      setLoading(true);
      setError('');
      if (!connected || !currentRunId) {
        if (current()) {
          setError('Kết nối tài khoản nghiệp vụ để tải tác vụ AI.');
          setLoading(false);
        }
        return;
      }
      if (!agentJobId) {
        if (current()) {
          setJobScope(requestScope);
          setError('Chưa có tác vụ AI được liên kết với hồ sơ sự cố này.');
          setLoading(false);
        }
        return;
      }
      if (!api?.agent || !expectedAssetId || !expectedNotificationId) {
        if (current()) {
          setJobScope(requestScope);
          setError('Không đủ ngữ cảnh hoặc dịch vụ để đọc tác vụ AI đã liên kết.');
          setLoading(false);
        }
        return;
      }
      try {
        const loadedJob = await api.agent('detail', { id: agentJobId });
        if (!current()) return;
        const matchesRun = loadedJob?.id === agentJobId
          && loadedJob?.runId === currentRunId
          && loadedJob?.assetId === expectedAssetId
          && loadedJob?.notificationId === expectedNotificationId;
        if (!matchesRun) throw new Error('Tác vụ AI không khớp với hồ sơ sự cố, tài sản hoặc notification đã liên kết.');
        if (loadedJob.status === 'completed' && (!expectedProposalId || loadedJob.proposalId !== expectedProposalId
          || !loadedJob.proposal || typeof loadedJob.proposal.summary !== 'string' || !Array.isArray(loadedJob.proposal.evidence))) {
          throw new Error('Kết quả phân tích không khớp với mã đề xuất được lưu trong hồ sơ sự cố.');
        }
        setJobData(loadedJob);
        setJobScope(requestScope);
        setError(loadedJob.status === 'completed' ? '' : 'Chưa có kết quả phân tích hoàn tất.');
        onJobUpdate?.(loadedJob);
      } catch (err) {
        if (!current()) return;
        setJobData(null);
        setJobScope(requestScope);
        setError(err.message || 'Không thể tải thông tin tác vụ AI.');
      } finally {
        if (current()) setLoading(false);
      }
    }, [api, connected, currentRunId, agentJobId, expectedProposalId, expectedAssetId, expectedNotificationId, scope, onJobUpdate]);

    React.useEffect(() => {
      loadEpoch.current++;
      setJobData(null);
      setJobScope(null);
      setRetryCommand(null);
      setStartRequested(false);
      setActionBusy(false);
      setSuccessMessage('');
      loadJob();
      return () => { loadEpoch.current++; };
    }, [loadJob, scope]);

    React.useEffect(() => {
      if (caseItem?.status !== 'investigating') setStartRequested(false);
    }, [caseItem?.status, scope]);

    // Handle Start Analysis
    const handleStartAnalysis = async () => {
      const commandScope = scope;
      if (!caseItem?.id || !workflowCommands || scopeRef.current !== commandScope) {
        setError('Chưa kết nối tài khoản hoặc dịch vụ workflow.');
        return;
      }
      setActionBusy(true);
      setError('');
      try {
        await workflowCommands.execute('transition', { action: 'request_analysis', expectedVersion: caseItem.version, input: {} }, caseItem.id);
        if (scopeRef.current !== commandScope) return;
        setRetryCommand(null);
        setSuccessMessage('Đã gửi yêu cầu phân tích sự cố tới AI Agent.');
        setStartRequested(true);
        onTransition?.('request_analysis');
      } catch (err) {
        if (scopeRef.current !== commandScope) return;
        setRetryCommand(workflowCommands.uncertain ? { type: 'start' } : null);
        setError(err.status === 403 || err.response?.status === 403
          ? 'Chỉ Kỹ thuật viên phụ trách mới có quyền yêu cầu phân tích sự cố.'
          : (err.message || 'Không thể bắt đầu phân tích.'));
      } finally {
        if (scopeRef.current === commandScope) setActionBusy(false);
      }
    };

    // Handle Retry Analysis
    const handleRetry = async () => {
      const commandScope = scope;
      if (!job?.id || !agentCommands || scopeRef.current !== commandScope) {
        setError('Chưa có tác vụ AI hợp lệ để thử lại.');
        return;
      }
      setActionBusy(true);
      setError('');
      try {
        const retried = await agentCommands.execute('retry', { expectedVersion: job.version }, job.id);
        if (scopeRef.current !== commandScope) return;
        setRetryCommand(null);
        setSuccessMessage('Đã gửi yêu cầu thử lại phân tích sự cố.');
        if (retried?.id === agentJobId && retried?.runId === currentRunId && retried?.assetId === expectedAssetId && retried?.notificationId === expectedNotificationId) {
          setJobData(retried);
          setJobScope(commandScope);
        } else {
          setJobData(null);
          setJobScope(null);
        }
        onTransition?.('retry_analysis');
      } catch (err) {
        if (scopeRef.current !== commandScope) return;
        setRetryCommand(agentCommands.uncertain ? { type: 'retry' } : null);
        setError(err.status === 403 || err.response?.status === 403
          ? 'Không có quyền thử lại phân tích sự cố.'
          : (err.message || 'Thử lại phân tích thất bại.'));
      } finally {
        if (scopeRef.current === commandScope) setActionBusy(false);
      }
    };

    const retryPendingCommand = async () => {
      const commandScope = scope;
      if (!retryCommand || scopeRef.current !== commandScope) return;
      const helper = retryCommand.type === 'start' ? workflowCommands : agentCommands;
      if (!helper) return;
      setActionBusy(true);
      setError('');
      try {
        const result = await helper.retry();
        if (scopeRef.current !== commandScope) return;
        setRetryCommand(null);
        if (retryCommand.type === 'start') {
          setStartRequested(true);
          setSuccessMessage('Đã gửi yêu cầu phân tích sự cố tới AI Agent.');
          onTransition?.('request_analysis');
        } else {
          if (result?.id === agentJobId && result?.runId === currentRunId && result?.assetId === expectedAssetId && result?.notificationId === expectedNotificationId) {
            setJobData(result);
            setJobScope(commandScope);
          }
          setSuccessMessage('Đã gửi yêu cầu thử lại phân tích sự cố.');
          onTransition?.('retry_analysis');
        }
      } catch (err) {
        if (scopeRef.current !== commandScope) return;
        const helper = retryCommand.type === 'start' ? workflowCommands : agentCommands;
        setRetryCommand(helper?.uncertain ? retryCommand : null);
        setError(err.status === 403 || err.response?.status === 403
          ? 'Không có quyền thực hiện lại lệnh phân tích sự cố.'
          : (err.message || 'Thử lại lệnh phân tích thất bại.'));
      } finally {
        if (scopeRef.current === commandScope) setActionBusy(false);
      }
    };

    const getStatusBadge = (status) => {
      switch (status) {
        case 'queued':
        case 'pending':
          return { label: 'Chờ Worker nhận việc', bg: '#fffbe6', color: '#d46b08', border: '#ffe58f', icon: '⏳' };
        case 'running':
          return { label: 'Đang phân tích hiện trường', bg: '#e6f4ff', color: '#0958d9', border: '#91caff', icon: '⚡' };
        case 'completed':
          return { label: 'Phân tích hoàn tất', bg: '#f6ffed', color: '#389e0d', border: '#b7eb8f', icon: '✅' };
        case 'failed':
        case 'analysis_failed':
          return { label: 'Phân tích thất bại', bg: '#fff1f0', color: '#cf1322', border: '#ffa39e', icon: '❌' };
        case 'timed_out':
          return { label: 'Hết thời gian xử lý', bg: '#fff1f0', color: '#cf1322', border: '#ffa39e', icon: '⏱️' };
        default:
          return { label: 'Chưa kích hoạt', bg: '#f5f5f5', color: '#595959', border: '#d9d9d9', icon: '⚪' };
      }
    };

    const jobStatus = job ? job.status : (caseItem?.status === 'analyzing' ? 'running' : 'none');
    const badge = getStatusBadge(jobStatus);

    return h('div', {
      'data-testid': 'lattice-agent-run-block',
      style: {
        padding: 16,
        background: '#ffffff',
        borderRadius: 8,
        border: '1px solid #dce3ed',
        marginBottom: 16
      }
    },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { fontSize: 20 } }, '🤖'),
          h('h4', { style: { margin: 0, fontSize: 15, fontWeight: 700, color: '#172b4d' } }, 'Tác vụ AI Agent (Incident Analysis Agent)')
        ),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('span', {
            'data-testid': 'lattice-agent-status-badge',
            style: {
              padding: '3px 8px',
              borderRadius: 4,
              fontSize: 12,
              fontWeight: 600,
              background: badge.bg,
              color: badge.color,
              border: `1px solid ${badge.border}`
            }
          }, `${badge.icon} ${badge.label}`),
          h('button', {
            type: 'button',
            'data-testid': 'lattice-agent-refresh-btn',
            disabled: loading,
            onClick: loadJob,
            style: { padding: '4px 8px', borderRadius: 4, border: '1px solid #cbd5e1', background: '#fff', fontSize: 12, cursor: 'pointer' }
          }, loading ? '…' : '⟳')
        )
      ),

      error && h('div', { role: 'alert', 'data-testid': 'lattice-agent-error-banner', style: { padding: '8px 12px', background: '#fff1f0', color: '#cf1322', border: '1px solid #ffa39e', borderRadius: 6, fontSize: 13, marginBottom: 12 } }, error),
      successMessage && h('div', { role: 'status', style: { padding: '8px 12px', background: '#f6ffed', color: '#389e0d', border: '1px solid #b7eb8f', borderRadius: 6, fontSize: 13, marginBottom: 12 } }, successMessage),
      retryCommand && (retryCommand.type === 'start' ? workflowCommands?.uncertain : agentCommands?.uncertain) && h('button', {
        type: 'button',
        'data-testid': 'lattice-agent-retry-command-btn',
        disabled: actionBusy || !connected,
        onClick: retryPendingCommand,
        style: { marginBottom: 12, padding: '7px 12px', background: '#fff7e6', color: '#ad6800', border: '1px solid #ffd591', borderRadius: 6, cursor: 'pointer', fontSize: 13 }
      }, actionBusy ? 'Đang thử lại…' : 'Thử lại lệnh cũ'),

      // Diagnostic Error View when failed
      (jobStatus === 'failed' || jobStatus === 'analysis_failed' || job?.errorCode) && h('div', {
        'data-testid': 'lattice-agent-diagnostic-box',
        style: {
          padding: 12,
          background: '#fff2e8',
          border: '1px solid #ffbb96',
          borderRadius: 6,
          marginBottom: 14
        }
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, color: '#d4380d', fontSize: 13, marginBottom: 4 } },
          '⚠️ Chi tiết lỗi phân tích:'
        ),
        h('p', { style: { margin: '0 0 6px 0', fontSize: 13, color: '#172b4d' } },
          job?.errorCode ? (errorMessages[job.errorCode] || `Mã lỗi: ${job.errorCode}`) : 'Tiến trình phân tích gặp lỗi bất ngờ hoặc timeout.'
        ),
        h('div', { style: { fontSize: 12, color: '#8c8c8c' } },
          'Mã sự cố: ', h('strong', null, currentRunId), ' | Số lần đã chạy: ', h('strong', null, job?.attempts || 1)
        )
      ),

      // Process Stepper
      h('div', {
        'data-testid': 'lattice-agent-stepper',
        style: {
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: 8,
          marginBottom: 16,
          background: '#f8fafc',
          padding: 12,
          borderRadius: 6,
          border: '1px solid #e2e8f0'
        }
      },
        h('div', { style: { fontSize: 12, color: jobStatus !== 'none' ? '#0958d9' : '#8c8c8c' } },
          h('div', { style: { fontWeight: 600 } }, '1. Đọc số đo cảm biến'),
          h('div', { style: { fontSize: 11, color: '#5e6c84' } }, 'Kiểm tra NGSI-LD & observedAt')
        ),
        h('div', { style: { fontSize: 12, color: ['running', 'completed'].includes(jobStatus) ? '#0958d9' : '#8c8c8c' } },
          h('div', { style: { fontWeight: 600 } }, '2. Đối chiếu luật cảnh báo'),
          h('div', { style: { fontSize: 11, color: '#5e6c84' } }, 'Đánh giá ngưỡng vượt & tuổi dữ liệu')
        ),
        h('div', { style: { fontSize: 12, color: jobStatus === 'completed' ? '#389e0d' : '#8c8c8c' } },
          h('div', { style: { fontWeight: 600 } }, '3. Tổng hợp đề xuất'),
          h('div', { style: { fontSize: 11, color: '#5e6c84' } }, 'Sinh phương án & bằng chứng')
        )
      ),

      // Metadata details
      job && h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, fontSize: 12, color: '#5e6c84', marginBottom: 14 } },
        h('div', null, 'Mã Job: ', h('strong', { style: { color: '#172b4d' } }, job.id)),
        h('div', null, 'Lượt quy trình: ', h('strong', { style: { color: '#172b4d' } }, String(job.runId).slice(0, 16) + '…')),
        h('div', null, 'Số lần chạy: ', h('strong', { style: { color: '#172b4d' } }, job.attempts || 1)),
        job.deadline && h('div', null, 'Thời hạn: ', h('strong', { style: { color: '#172b4d' } }, new Date(job.deadline).toLocaleTimeString('vi-VN')))
      ),

      // Action buttons
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 } },
        (caseItem?.status === 'investigating' && !job && !startRequested) && h('button', {
          type: 'button',
          'data-testid': 'lattice-agent-start-btn',
          disabled: actionBusy || !workflowCommands || workflowCommands.uncertain,
          onClick: handleStartAnalysis,
          style: {
            padding: '7px 16px',
            borderRadius: 6,
            background: '#0958d9',
            color: '#fff',
            border: 'none',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer'
          }
        }, actionBusy ? 'Đang kích hoạt…' : '🚀 Kích hoạt phân tích AI'),

        (jobStatus === 'failed' || jobStatus === 'timed_out') && h('button', {
          type: 'button',
          'data-testid': 'lattice-agent-retry-btn',
          disabled: actionBusy || !agentCommands || agentCommands.uncertain,
          onClick: handleRetry,
          style: {
            padding: '7px 16px',
            borderRadius: 6,
            background: '#cf1322',
            color: '#fff',
            border: 'none',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer'
          }
        }, actionBusy ? 'Đang gửi lại…' : '🔄 Thử lại phân tích (Retry)'),

        jobStatus === 'running' && h('div', {
          style: { fontSize: 13, color: '#0958d9', display: 'flex', alignItems: 'center', gap: 6 }
        }, '⏳ AI Agent đang tiến hành phân tích số liệu... Vui lòng chờ kết quả.')
      )
    );
  };
}

module.exports = { createAgentRunComponent };
