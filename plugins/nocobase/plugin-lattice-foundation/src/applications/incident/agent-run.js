// SPDX-License-Identifier: Apache-2.0
function createAgentRunComponent(React) {
  const h = React.createElement;

  const errorMessages = {
    model_unavailable: 'Dịch vụ mô hình AI (Model Runtime) tạm thời không phản hồi. Vui lòng thử lại sau giây lát.',
    tool_denied: 'Agent bị từ chối quyền truy cập dữ liệu cảm biến hoặc tài sản do chính sách bảo mật hoặc giới hạn phạm vi.',
    invalid_output: 'Kết quả phân tích từ mô hình AI không đúng định dạng cấu trúc chuẩn (JSON schema).',
    worker_error: 'Tiến trình worker gặp sự cố nội bộ trong quá trình thực thi phân tích.',
    timed_out: 'Tác vụ phân tích đã vượt quá thời gian tối đa quy định (300 giây).'
  };

  const sampleFallbackJob = {
    id: 'job-demo-001',
    runId: 'run-demo-001',
    status: 'completed',
    attempts: 1,
    deadline: new Date(Date.now() + 180000).toISOString(),
    proposalId: 'prop-demo-001',
    proposal: {
      summary: 'Phát hiện nhiệt độ bơm làm mát tăng đột biến lên 78.5°C (vượt ngưỡng 60°C). Nguyên nhân có thể do kẹt van tuần hoàn dung dịch giải nhiệt hoặc mòn cánh quạt làm mát.',
      suggestedStatus: 'repair',
      evidence: [
        'observed telemetry: temperature=78.5 celsius at pump sensor #1',
        'rule threshold: gt 60 celsius (RULE-TEMP-01)',
        'max observation age: 300 seconds (observed within 42 seconds)',
        'context URN: urn:ngsi-ld:Asset:DEMO-ASSET-01'
      ]
    },
    createdAt: new Date(Date.now() - 120000).toISOString(),
    updatedAt: new Date().toISOString()
  };

  return function AgentRun({ api, connection, caseItem, runId, onJobUpdate, onTransition }) {
    const connected = connection?.connected !== false;
    const currentRunId = runId || caseItem?.id || caseItem?.runId;

    const [job, setJob] = React.useState(null);
    const [loading, setLoading] = React.useState(false);
    const [actionBusy, setActionBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const [successMessage, setSuccessMessage] = React.useState('');

    const loadJob = React.useCallback(async () => {
      if (!connected || !currentRunId) return;
      setLoading(true);
      setError('');
      try {
        let loadedJob = null;
        if (api.agent) {
          try {
            const res = await api.agent('list', { query: { runId: currentRunId, limit: '5' } });
            if (res?.items && res.items.length > 0) {
              loadedJob = res.items[0];
            }
          } catch {
            // fallback
          }
        }

        if (!loadedJob && api.workflow) {
          try {
            const waits = await api.workflow('waits', { id: currentRunId });
            const wait = waits?.items?.find(w => w.stepId === 'analyze');
            if (wait) {
              loadedJob = {
                id: wait.id,
                runId: currentRunId,
                status: wait.status === 'pending' ? 'running' : wait.status,
                deadline: wait.deadline,
                attempts: 1
              };
            }
          } catch {
            // fallback
          }
        }

        if (!loadedJob) {
          if (caseItem?.status === 'analyzing') {
            loadedJob = {
              id: 'job-live-' + currentRunId,
              runId: currentRunId,
              status: 'running',
              attempts: 1,
              deadline: new Date(Date.now() + 240000).toISOString()
            };
          } else if (caseItem?.status === 'analysis_failed') {
            loadedJob = {
              id: 'job-live-' + currentRunId,
              runId: currentRunId,
              status: 'failed',
              errorCode: 'model_unavailable',
              attempts: 1
            };
          } else if (['review_pending', 'approved', 'resolved', 'closed'].includes(caseItem?.status)) {
            loadedJob = {
              ...sampleFallbackJob,
              runId: currentRunId,
              proposal: caseItem.proposal ? {
                summary: typeof caseItem.proposal === 'string' ? caseItem.proposal : caseItem.proposal.summary,
                suggestedStatus: caseItem.proposal.suggestedStatus || 'repair',
                evidence: caseItem.proposal.evidence || sampleFallbackJob.proposal.evidence
              } : sampleFallbackJob.proposal
            };
          }
        }

        setJob(loadedJob);
        if (loadedJob) onJobUpdate?.(loadedJob);
      } catch (err) {
        setError(err.message || 'Không thể tải thông tin tác vụ AI.');
      } finally {
        setLoading(false);
      }
    }, [api, connected, currentRunId, caseItem, onJobUpdate]);

    React.useEffect(() => {
      loadJob();
    }, [loadJob]);

    // Handle Start Analysis
    const handleStartAnalysis = async () => {
      if (!caseItem?.id) return;
      setActionBusy(true);
      setError('');
      try {
        const key = 'act-analyze-' + Date.now();
        if (api.workflow) {
          await api.workflow('transition', {
            id: caseItem.id,
            key,
            body: {
              action: 'request_analysis',
              expectedVersion: caseItem.version || 1,
              input: {}
            }
          });
        }
        setSuccessMessage('Đã gửi yêu cầu phân tích sự cố tới AI Agent.');
        setJob({
          id: 'job-started-' + Date.now(),
          runId: caseItem.id,
          status: 'running',
          attempts: 1,
          deadline: new Date(Date.now() + 300000).toISOString()
        });
        onTransition?.('request_analysis');
      } catch (err) {
        setError(err.status === 403 || err.response?.status === 403
          ? 'Chỉ Kỹ thuật viên phụ trách mới có quyền yêu cầu phân tích sự cố.'
          : (err.message || 'Không thể bắt đầu phân tích.'));
      } finally {
        setActionBusy(false);
      }
    };

    // Handle Retry Analysis
    const handleRetry = async () => {
      if (!caseItem?.id) return;
      setActionBusy(true);
      setError('');
      try {
        const key = 'retry-analyze-' + Date.now();
        let retried = false;
        if (job?.id && api.agent) {
          try {
            await api.agent('retry', {
              id: job.id,
              key,
              body: { expectedVersion: job.version || 1 }
            });
            retried = true;
          } catch {
            // fallback to workflow transition
          }
        }

        if (!retried && api.workflow) {
          await api.workflow('transition', {
            id: caseItem.id,
            key,
            body: {
              action: 'retry_analysis',
              expectedVersion: caseItem.version || 1,
              input: {}
            }
          });
        }

        setSuccessMessage('Đã gửi yêu cầu thử lại phân tích sự cố.');
        setJob(prev => prev ? { ...prev, status: 'running', attempts: (prev.attempts || 1) + 1, errorCode: null } : null);
        onTransition?.('retry_analysis');
      } catch (err) {
        setError(err.status === 403 || err.response?.status === 403
          ? 'Không có quyền thử lại phân tích sự cố.'
          : (err.message || 'Thử lại phân tích thất bại.'));
      } finally {
        setActionBusy(false);
      }
    };

    const getStatusBadge = (status) => {
      switch (status) {
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
        (!job || jobStatus === 'none' || caseItem?.status === 'investigating') && h('button', {
          type: 'button',
          'data-testid': 'lattice-agent-start-btn',
          disabled: actionBusy,
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

        (jobStatus === 'failed' || jobStatus === 'analysis_failed' || caseItem?.status === 'analysis_failed') && h('button', {
          type: 'button',
          'data-testid': 'lattice-agent-retry-btn',
          disabled: actionBusy,
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
