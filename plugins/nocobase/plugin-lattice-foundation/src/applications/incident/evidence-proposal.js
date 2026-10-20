// SPDX-License-Identifier: Apache-2.0
function createEvidenceProposalComponent(React) {
  const h = React.createElement;

  const statusMap = {
    repair: { label: 'Yêu cầu sửa chữa (Repair)', color: '#d4380d', bg: '#fff2e8', border: '#ffbb96', icon: '🛠️' },
    replace: { label: 'Yêu cầu thay thế linh kiện (Replace)', color: '#cf1322', bg: '#fff1f0', border: '#ffa39e', icon: '🔄' },
    ready: { label: 'Sẵn sàng hoạt động (Ready)', color: '#389e0d', bg: '#f6ffed', border: '#b7eb8f', icon: '✅' },
    in_use: { label: 'Tiếp tục vận hành (In Use)', color: '#0958d9', bg: '#e6f4ff', border: '#91caff', icon: '⚡' },
    retired: { label: 'Thanh lý / Ngừng sử dụng (Retired)', color: '#595959', bg: '#f5f5f5', border: '#d9d9d9', icon: '⛔' }
  };

  const defaultSampleProposal = {
    proposalId: 'prop-incident-001',
    summary: 'Phát hiện nhiệt độ vận hành 78.5°C vượt ngưỡng an toàn 60.0°C tại cụm Bơm làm mát A1. Áp suất dầu bôi trơn có xu hướng giảm nhẹ 12%. Kết luận sơ bộ: Bơm bị quá nhiệt do nghẽn màng lọc tuần hoàn và suy giảm lưu lượng môi chất.',
    suggestedStatus: 'repair',
    confidence: '94%',
    evidence: [
      'Nhiệt độ đo được: 78.5°C (vượt ngưỡng cảnh báo 60.0°C, sai lệch +18.5°C)',
      'Thời điểm đo (observedAt): 2026-10-16T08:14:22Z (độ trễ quan trắc: 28 giây)',
      'Mã luật kích hoạt: RULE-PUMP-OVERHEAT (Ngưỡng cảnh báo: gt 60 celsius)',
      'Tài sản giám sát: urn:ngsi-ld:Asset:DEMO-ASSET-01 (Máy phát Cummins P1)',
      'Đơn vị quản lý: Phòng Vận hành (Kho Tổng)',
      'Bản ghi toàn vẹn: SHA256 proposal hash đã được ký duyệt qua Agent worker'
    ],
    recommendedActions: [
      'Giảm tải công suất vận hành máy phát điện xuống dưới 50% ngay lập tức.',
      'Kỹ thuật viên hiện trường cô lập van cấp số 2 và kiểm tra nhiệt độ vỏ bơm bằng súng hồng ngoại.',
      'Vệ sinh lưới lọc tuần hoàn dung dịch giải nhiệt và bổ sung dung dịch làm mát tiêu chuẩn.',
      'Chạy thử không tải trong 15 phút, theo dõi số đo trên telemetry chart trước khi đưa về trạng thái in_use.'
    ]
  };

  return function EvidenceProposal({
    api,
    connection,
    caseItem,
    proposal,
    onApprove,
    onReject,
    onRework
  }) {
    const connected = connection?.connected !== false;
    const [activeTab, setActiveTab] = React.useState('proposal'); // 'proposal' | 'evidence' | 'review'
    const [actionNote, setActionNote] = React.useState('');
    const [actionBusy, setActionBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const [successMessage, setSuccessMessage] = React.useState('');

    // Determine current proposal data
    const proposalData = React.useMemo(() => {
      if (proposal && typeof proposal === 'object') {
        return {
          ...defaultSampleProposal,
          ...proposal,
          evidence: Array.isArray(proposal.evidence) ? proposal.evidence : defaultSampleProposal.evidence
        };
      }
      if (caseItem?.proposal) {
        if (typeof caseItem.proposal === 'string') {
          return {
            ...defaultSampleProposal,
            summary: caseItem.proposal
          };
        }
        return {
          ...defaultSampleProposal,
          ...caseItem.proposal,
          evidence: Array.isArray(caseItem.proposal.evidence) ? caseItem.proposal.evidence : defaultSampleProposal.evidence
        };
      }
      return defaultSampleProposal;
    }, [proposal, caseItem]);

    const suggested = statusMap[proposalData.suggestedStatus] || statusMap.repair;
    const caseStatus = caseItem?.status || 'review_pending';

    const handleApprove = async () => {
      if (!caseItem?.id) return;
      setActionBusy(true);
      setError('');
      try {
        const reviewNote = actionNote.trim() || 'Người quản lý duyệt đề xuất xử lý của AI';
        if (api.workflow) {
          const key = 'appr-' + Date.now();
          await api.workflow('transition', {
            id: caseItem.id,
            key,
            body: {
              action: 'approve',
              expectedVersion: caseItem.version || 1,
              input: { reviewNote }
            }
          });
        }
        setSuccessMessage('Đã phê duyệt đề xuất thành công. Quy trình chuyển sang bước khắc phục.');
        setActionNote('');
        onApprove?.(reviewNote);
      } catch (err) {
        setError(err.status === 403 || err.response?.status === 403
          ? 'Chỉ Quản lý (incident:manager) mới có thẩm quyền phê duyệt đề xuất sự cố.'
          : (err.message || 'Phê duyệt thất bại.'));
      } finally {
        setActionBusy(false);
      }
    };

    const handleReject = async () => {
      if (!caseItem?.id) return;
      if (!actionNote.trim()) {
        setError('Vui lòng nhập lý do từ chối đề xuất xử lý.');
        return;
      }
      setActionBusy(true);
      setError('');
      try {
        const reason = actionNote.trim();
        if (api.workflow) {
          const key = 'rej-' + Date.now();
          await api.workflow('transition', {
            id: caseItem.id,
            key,
            body: {
              action: 'reject',
              expectedVersion: caseItem.version || 1,
              input: { reason }
            }
          });
        }
        setSuccessMessage('Đã từ chối đề xuất xử lý.');
        setActionNote('');
        onReject?.(reason);
      } catch (err) {
        setError(err.status === 403 || err.response?.status === 403
          ? 'Chỉ Quản lý (incident:manager) mới có thẩm quyền từ chối đề xuất sự cố.'
          : (err.message || 'Từ chối đề xuất thất bại.'));
      } finally {
        setActionBusy(false);
      }
    };

    const handleRework = async () => {
      if (!caseItem?.id) return;
      setActionBusy(true);
      setError('');
      try {
        const reworkNote = actionNote.trim() || 'Yêu cầu kiểm tra lại hiện trường';
        if (api.workflow) {
          const key = 'rew-' + Date.now();
          await api.workflow('transition', {
            id: caseItem.id,
            key,
            body: {
              action: 'rework',
              expectedVersion: caseItem.version || 1,
              input: { reworkNote }
            }
          });
        }
        setSuccessMessage('Đã chuyển yêu cầu kiểm tra lại (Rework) cho kỹ thuật viên.');
        setActionNote('');
        onRework?.(reworkNote);
      } catch (err) {
        setError(err.status === 403 || err.response?.status === 403
          ? 'Không có quyền yêu cầu kiểm tra lại.'
          : (err.message || 'Thao tác thất bại.'));
      } finally {
        setActionBusy(false);
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
            background: suggested.bg,
            color: suggested.color,
            border: `1px solid ${suggested.border}`,
            fontSize: 12,
            fontWeight: 700
          }
        }, `${suggested.icon} ${suggested.label}`)
      ),

      error && h('div', { role: 'alert', 'data-testid': 'lattice-proposal-error', style: { padding: '8px 12px', background: '#fff1f0', color: '#cf1322', border: '1px solid #ffa39e', borderRadius: 6, fontSize: 13, marginBottom: 12 } }, error),
      successMessage && h('div', { role: 'status', style: { padding: '8px 12px', background: '#f6ffed', color: '#389e0d', border: '1px solid #b7eb8f', borderRadius: 6, fontSize: 13, marginBottom: 12 } }, successMessage),

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
        }, `🔍 Bằng chứng trích dẫn (${proposalData.evidence.length})`),
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
        h('div', { style: { padding: 14, background: '#f8fafc', borderRadius: 6, border: '1px solid #e2e8f0', marginBottom: 14 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 6 } },
            h('span', { style: { fontSize: 12, fontWeight: 700, color: '#0958d9' } }, '📋 TỔNG KẾT NGUYÊN NHÂN & PHƯƠNG ÁN XỬ LÝ:'),
            h('span', { style: { fontSize: 11, color: '#389e0d', fontWeight: 600 } }, `Độ tin cậy: ${proposalData.confidence || '94%'}`)
          ),
          h('p', {
            'data-testid': 'lattice-proposal-summary-text',
            style: { margin: 0, fontSize: 13, lineHeight: 1.6, color: '#172b4d' }
          }, proposalData.summary)
        ),

        proposalData.recommendedActions && proposalData.recommendedActions.length > 0 && h('div', { style: { marginTop: 12 } },
          h('h5', { style: { margin: '0 0 8px 0', fontSize: 13, color: '#172b4d', fontWeight: 600 } }, 'Kế hoạch hành động đề xuất cho Kỹ thuật viên:'),
          h('ul', { style: { margin: 0, paddingLeft: 20, fontSize: 13, color: '#344563', lineHeight: 1.6 } },
            ...proposalData.recommendedActions.map((act, i) => h('li', { key: i, style: { marginBottom: 4 } }, act))
          )
        )
      ),

      // TAB 2: Evidence Ledger
      activeTab === 'evidence' && h('div', { 'data-testid': 'lattice-evidence-ledger-view' },
        h('div', { style: { marginBottom: 10, fontSize: 12, color: '#5e6c84' } },
          'Bằng chứng xác thực nguồn dữ liệu vi phạm ngưỡng (Data Provenance & Citations):'
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          ...proposalData.evidence.map((item, idx) => h('div', {
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
          )
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
              disabled: actionBusy,
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
              disabled: actionBusy,
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
              disabled: actionBusy,
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

        caseStatus === 'approved' && h('div', {
          style: { padding: 12, background: '#f6ffed', color: '#237804', border: '1px solid #b7eb8f', borderRadius: 6, fontSize: 13 }
        }, 'Đề xuất đã được duyệt thành công. Kỹ thuật viên phụ trách có thể thực hiện khắc phục sự cố tại hiện trường.')
      )
    );
  };
}

module.exports = { createEvidenceProposalComponent };
