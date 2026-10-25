// SPDX-License-Identifier: Apache-2.0
const { createAgentRunComponent } = require('./agent-run');
const { createEvidenceProposalComponent } = require('./evidence-proposal');
const { createCaseResolutionComponent } = require('./resolution');
const { createEvidenceComponents } = require('../../client/evidence-blocks');
const { createInboxComponents } = require('../../client/inbox-blocks');
const { createEntityContextComponent } = require('../../client/entity-context');
const { createWorkflowCommands } = require('../../client/workflow');

function createCaseBoardComponent(React) {
  const h = React.createElement;
  const AgentRun = createAgentRunComponent(React);
  const EvidenceProposal = createEvidenceProposalComponent(React);
  const CaseResolution = createCaseResolutionComponent(React);
  const ContextEntityBlock = createEntityContextComponent(React);
  const { AttachmentBlock, ActivityTimelineBlock } = createEvidenceComponents(React);
  const { ApprovalBlock } = createInboxComponents(React, { AttachmentBlock, ActivityTimelineBlock });

  const caseApprovalBlock = {
    id: 'case-approval',
    type: 'approval',
    title: 'Xử lý quy trình sự cố (Approval Engine)',
    collection: 'workflow-runs',
    definitionId: 'incident-response',
    attachmentBlockId: 'case-files',
    timelineBlockId: 'case-history',
    contextBlockId: 'case-context',
    actionLabels: {
      assign: 'Phân công kỹ thuật viên',
      accept: 'Tiếp nhận kiểm tra',
      request_analysis: 'Yêu cầu AI phân tích',
      retry_analysis: 'Thử lại phân tích',
      approve: 'Duyệt đề xuất xử lý',
      reject: 'Từ chối đề xuất',
      rework: 'Yêu cầu kiểm tra lại',
      record_resolution: 'Ghi nhận khắc phục xong',
      close: 'Xác nhận đóng sự cố'
    },
    fieldLabels: {
      receiptNote: 'Ghi chú tiếp nhận',
      reviewNote: 'Ý kiến phê duyệt',
      reason: 'Lý do từ chối',
      reworkNote: 'Yêu cầu kiểm tra lại',
      resolutionNote: 'Biên bản khắc phục',
      closeNote: 'Ghi chú đóng sự cố'
    }
  };

  const caseAttachmentBlock = {
    id: 'case-files',
    type: 'attachment',
    title: 'Biên bản & Tài liệu sự cố',
    collection: 'workflow-runs',
    definitionId: 'incident-response',
    allowUpload: true,
    fileFields: ['attachmentId']
  };

  const caseTimelineBlock = {
    id: 'case-history',
    type: 'activity-timeline',
    title: 'Nhật ký & Lịch sử xử lý',
    collection: 'workflow-runs',
    definitionId: 'incident-response',
    pageSize: 10,
    actionLabels: {
      assign: 'Phân công',
      accept: 'Tiếp nhận',
      request_analysis: 'Yêu cầu AI phân tích',
      retry_analysis: 'Thử lại phân tích',
      approve: 'Duyệt đề xuất',
      reject: 'Từ chối đề xuất',
      rework: 'Yêu cầu kiểm tra lại',
      record_resolution: 'Khắc phục xong',
      close: 'Đóng sự cố'
    },
    stateLabels: {
      open: 'Mới tiếp nhận',
      assigned: 'Đã giao việc',
      investigating: 'Đang kiểm tra',
      analyzing: 'Đang phân tích AI',
      analysis_failed: 'Phân tích thất bại',
      review_pending: 'Chờ duyệt đề xuất',
      approved: 'Đã duyệt đề xuất',
      rejected: 'Đề xuất bị từ chối',
      resolved: 'Đã khắc phục xong',
      closed: 'Đã đóng sự cố'
    }
  };

  const caseContextBlock = {
    id: 'case-context',
    type: 'context-entity',
    title: 'Thông tin tài sản nghiệp vụ & Lịch sử số đo',
    collection: 'workflow-runs',
    definitionId: 'incident-response',
    entitySchemaId: 'asset'
  };

  const incidentManifest = {
    id: 'incident',
    collections: [
      { id: 'cases', source: 'lattice-api', resource: 'workflows' },
      { id: 'workflow-runs', source: 'lattice-api', resource: 'workflows' }
    ],
    blocks: [caseApprovalBlock, caseAttachmentBlock, caseTimelineBlock, caseContextBlock]
  };

  const stateConfig = {
    open: { label: 'Mới tiếp nhận', color: '#0958d9', bg: '#e6f4ff', border: '#91caff', column: 'inbox' },
    assigned: { label: 'Đã giao việc', color: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe', column: 'inbox' },
    investigating: { label: 'Đang kiểm tra', color: '#722ed1', bg: '#f9f0ff', border: '#d3adf7', column: 'processing' },
    analyzing: { label: 'Đang phân tích AI', color: '#13c2c2', bg: '#e6fffb', border: '#87e8de', column: 'processing' },
    analysis_failed: { label: 'Phân tích lỗi', color: '#cf1322', bg: '#fff1f0', border: '#ffa39e', column: 'processing' },
    review_pending: { label: 'Chờ duyệt đề xuất', color: '#d46b08', bg: '#fffbe6', border: '#ffe58f', column: 'review' },
    approved: { label: 'Đề xuất đã duyệt', color: '#389e0d', bg: '#f6ffed', border: '#b7eb8f', column: 'review' },
    rejected: { label: 'Đề xuất bị từ chối', color: '#cf1322', bg: '#fff1f0', border: '#ffa39e', column: 'review' },
    resolved: { label: 'Đã khắc phục', color: '#0958d9', bg: '#e6f4ff', border: '#91caff', column: 'done' },
    closed: { label: 'Đã đóng sự cố', color: '#595959', bg: '#f5f5f5', border: '#d9d9d9', column: 'done' }
  };

  const severityConfig = {
    critical: { label: 'Khẩn cấp', color: '#cf1322', bg: '#fff1f0', border: '#ffa39e', badge: '🔴' },
    high: { label: 'Cao', color: '#d4380d', bg: '#fff2e8', border: '#ffbb96', badge: '🟠' },
    medium: { label: 'Trung bình', color: '#d46b08', bg: '#fffbe6', border: '#ffe58f', badge: '🟡' },
    low: { label: 'Thấp', color: '#0958d9', bg: '#e6f4ff', border: '#91caff', badge: '🔵' }
  };

  const boardColumns = [
    { id: 'inbox', title: 'Tiếp nhận & Giao việc', states: ['open', 'assigned'], bg: '#f0f5ff', color: '#1d39c4' },
    { id: 'processing', title: 'Kiểm tra & Phân tích AI', states: ['investigating', 'analyzing', 'analysis_failed'], bg: '#f9f0ff', color: '#531dab' },
    { id: 'review', title: 'Phê duyệt đề xuất', states: ['review_pending', 'approved', 'rejected'], bg: '#fffbe6', color: '#ad6800' },
    { id: 'done', title: 'Khắc phục & Đã đóng', states: ['resolved', 'closed'], bg: '#f6ffed', color: '#237804' }
  ];

  const defaultCreateForm = {
    title: '',
    assetEntityId: '',
    handlerId: 'handler'
  };

  return function CaseBoard({ api, connection, onSelectCase, initialAssetId }) {
    const connected = connection?.connected === true;
    const actorId = connection?.identity?.subject;
    const organizationId = connection?.identity?.organizationId;
    const scope = React.useMemo(() => ({ api, connected, actorId, organizationId }), [api, connected, actorId, organizationId]);
    const scopeRef = React.useRef(scope);
    scopeRef.current = scope;
    const loadEpoch = React.useRef(0);
    const [cases, setCases] = React.useState([]);
    const [assets, setAssets] = React.useState([]);
    const [departments, setDepartments] = React.useState([]);
    const [dataScope, setDataScope] = React.useState(scope);
    const visibleCases = dataScope === scope ? cases : [];
    const visibleAssets = dataScope === scope ? assets : [];
    const visibleDepartments = dataScope === scope ? departments : [];
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState('');
    const [successMessage, setSuccessMessage] = React.useState('');

    const [viewMode, setViewMode] = React.useState('board'); // 'board' | 'list'
    const [searchQuery, setSearchQuery] = React.useState('');
    const [filterStatus, setFilterStatus] = React.useState('all');
    const [filterSeverity, setFilterSeverity] = React.useState('all');
    const [filterHandler, setFilterHandler] = React.useState('all');
    const [filterAsset, setFilterAsset] = React.useState(initialAssetId || 'all');
    const [filterDepartment, setFilterDepartment] = React.useState('all');

    const [selectedCase, setSelectedCase] = React.useState(null);
    const [detailTab, setDetailTab] = React.useState('overview');
    const [isCreating, setIsCreating] = React.useState(false);
    const [createForm, setCreateForm] = React.useState({
      ...defaultCreateForm,
      assetEntityId: initialAssetId || ''
    });
    const [actionNote, setActionNote] = React.useState('');
    const [actionBusy, setActionBusy] = React.useState(false);
    const [retryWorkflowCommand, setRetryWorkflowCommand] = React.useState(null);
    const workflowCommands = React.useMemo(() => api?.workflow && connected && actorId
      ? createWorkflowCommands({ api, actorId })
      : null, [api, connected, actorId, organizationId]);

    const loadData = React.useCallback(async () => {
      const requestScope = scope;
      const request = ++loadEpoch.current;
      const current = () => scopeRef.current === requestScope && loadEpoch.current === request;
      if (!connected) {
        if (current()) {
          setCases([]);
          setAssets([]);
          setDepartments([]);
          setDataScope(requestScope);
          setLoading(false);
        }
        return;
      }
      setLoading(true);
      setError('');
      try {
        if (!api?.workflow) throw new Error('Không có dịch vụ quy trình để tải sự cố.');
        const res = await api.workflow('list', {
          query: { definitionId: 'incident-response', limit: '100', offset: '0' }
        });
        if (!Array.isArray(res?.items)) throw new Error('Dữ liệu danh sách workflow sự cố không hợp lệ.');
        const loadedCases = res.items.map(item => ({
          id: item.id,
          title: item.title,
          status: item.state || item.status || 'open',
          version: item.version || 1,
          severity: item.severity || item.data?.severity || 'high',
          assetEntityId: item.assetEntityId || item.data?.assetEntityId || '',
          handlerId: item.handlerId || item.data?.handlerId || 'Chưa gán',
          notificationId: item.notificationId || item.data?.notificationId || '',
          createdAt: item.createdAt || new Date().toISOString(),
          updatedAt: item.updatedAt || new Date().toISOString(),
          resolutionNote: item.resolutionNote || item.data?.resolutionNote || '',
          closeNote: item.closeNote || item.data?.closeNote || '',
          data: item.data || {},
          availableTransitions: item.availableTransitions || []
        }));
        if (!current()) return;
        setCases(loadedCases);
      } catch (err) {
        if (!current()) return;
        setCases([]);
        setError(err.message || 'Không thể tải dữ liệu sự cố.');
      }

      if (api?.entity) {
        try {
          const assetRes = await api.entity('list', { query: { schemaId: 'incident-asset', limit: '100', offset: '0' } });
          if (!current()) return;
          setAssets(assetRes?.items || []);
        } catch {
          if (!current()) return;
          setAssets([]);
        }
      }

      if (api?.request) {
        try {
          const deptRes = await api.request({ url: 'latticeDepartments:list', method: 'get', params: { paginate: false } });
          if (!current()) return;
          setDepartments(deptRes?.data?.data || []);
        } catch {
          if (!current()) return;
          setDepartments([]);
        }
      }
      if (current()) {
        setDataScope(requestScope);
        setLoading(false);
      }
    }, [api, connected, scope]);

    React.useEffect(() => {
      loadEpoch.current++;
      setCases([]);
      setAssets([]);
      setDepartments([]);
      setSelectedCase(null);
      setRetryWorkflowCommand(null);
      setError('');
      setSuccessMessage('');
      setActionBusy(false);
      setActionNote('');
      setDataScope(null);
      if (connected) loadData();
      else setLoading(false);
      return () => { loadEpoch.current++; };
    }, [loadData, scope, connected]);

    React.useEffect(() => {
      if (initialAssetId) {
        setFilterAsset(initialAssetId);
        setCreateForm(prev => ({ ...prev, assetEntityId: initialAssetId }));
      }
    }, [initialAssetId]);

    const assetMap = React.useMemo(() => {
      const map = {};
      for (const a of visibleAssets) {
        map[a.id] = a;
      }
      return map;
    }, [visibleAssets]);

    const filteredCases = React.useMemo(() => {
      return visibleCases.filter(c => {
        if (filterStatus !== 'all' && c.status !== filterStatus) return false;
        if (filterSeverity !== 'all' && c.severity !== filterSeverity) return false;
        if (filterHandler !== 'all' && c.handlerId !== filterHandler) return false;
        if (filterAsset !== 'all' && c.assetEntityId !== filterAsset) return false;
        if (filterDepartment !== 'all') {
          const asset = assetMap[c.assetEntityId];
          const dept = asset?.attributes?.department || asset?.attributes?.departmentId;
          if (dept !== filterDepartment) return false;
        }
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          const matchTitle = c.title?.toLowerCase().includes(q);
          const matchId = String(c.id).toLowerCase().includes(q);
          const matchAsset = c.assetEntityId?.toLowerCase().includes(q);
          const matchHandler = c.handlerId?.toLowerCase().includes(q);
          if (!matchTitle && !matchId && !matchAsset && !matchHandler) return false;
        }
        return true;
      });
    }, [visibleCases, filterStatus, filterSeverity, filterHandler, filterAsset, filterDepartment, searchQuery, assetMap]);

    const handleCreateCase = e => {
      e.preventDefault();
      setError('Chưa thể tạo sự cố thủ công vì chưa có nguồn notification hợp lệ. Sự cố cần được khởi tạo từ notification đã xác thực.');
    };

    const workflowCommandBlocked = actionBusy || !connected || !workflowCommands || workflowCommands.uncertain;

    const handleTransition = async (caseItem, action) => {
      const commandScope = scope;
      setActionBusy(true);
      setError('');
      try {
        const input = {};
        if (action === 'accept') input.receiptNote = actionNote.trim() || 'Kỹ thuật viên đã tiếp nhận';
        if (action === 'approve') input.reviewNote = actionNote.trim() || 'Người quản lý duyệt đề xuất';
        if (action === 'reject') input.reason = actionNote.trim() || 'Từ chối đề xuất xử lý';
        if (action === 'rework') input.reworkNote = actionNote.trim() || 'Yêu cầu kiểm tra lại';
        if (action === 'record_resolution') input.resolutionNote = actionNote.trim() || 'Đã khắc phục hoàn tất sự cố';
        if (action === 'close') input.closeNote = actionNote.trim() || 'Đã đóng sự cố';

        if (!workflowCommands) throw new Error('Chưa kết nối dịch vụ quy trình.');
        if (scopeRef.current !== commandScope) return;
        await workflowCommands.execute('transition', {
          action,
          expectedVersion: caseItem.version,
          input
        }, caseItem.id);

        if (scopeRef.current !== commandScope) return;
        setRetryWorkflowCommand(null);
        setSuccessMessage(`Đã thực hiện thao tác "${action}" thành công.`);
        setActionNote('');
        setSelectedCase(null);
        await loadData();
      } catch (err) {
        if (scopeRef.current !== commandScope) return;
        setRetryWorkflowCommand(workflowCommands?.uncertain ? { caseItem, action } : null);
        setError(err.status === 403 || err.response?.status === 403
          ? 'Không có quyền thực hiện thao tác chuyển trạng thái này.'
          : (err.message || 'Thao tác thất bại.'));
      } finally {
        if (scopeRef.current === commandScope) setActionBusy(false);
      }
    };

    const retryWorkflowTransition = async () => {
      const commandScope = scope;
      if (!retryWorkflowCommand || !workflowCommands || scopeRef.current !== commandScope) return;
      const pending = retryWorkflowCommand;
      setActionBusy(true);
      setError('');
      try {
        await workflowCommands.retry();
        if (scopeRef.current !== commandScope) return;
        setRetryWorkflowCommand(null);
        setSuccessMessage(`Đã thực hiện thao tác "${pending.action}" thành công.`);
        setActionNote('');
        setSelectedCase(null);
        await loadData();
      } catch (err) {
        if (scopeRef.current !== commandScope) return;
        setRetryWorkflowCommand(workflowCommands.uncertain ? pending : null);
        setError(err.status === 403 || err.response?.status === 403
          ? 'Không có quyền thực hiện thao tác chuyển trạng thái này.'
          : (err.message || 'Thử lại thao tác thất bại.'));
      } finally {
        if (scopeRef.current === commandScope) setActionBusy(false);
      }
    };

    const renderCard = (c) => {
      const stateInfo = stateConfig[c.status] || stateConfig.open;
      const sevInfo = severityConfig[c.severity] || severityConfig.medium;
      const asset = assetMap[c.assetEntityId];
      const assetName = asset?.title || (c.assetEntityId ? `Tài sản #${c.assetEntityId.slice(-6)}` : 'Chưa gắn tài sản');

      return h('div', {
        key: c.id,
        'data-testid': `lattice-case-card-${c.id}`,
        onClick: () => {
          setSelectedCase(c);
          onSelectCase?.(c);
        },
        style: {
          padding: 12,
          marginBottom: 10,
          background: '#ffffff',
          borderRadius: 6,
          border: '1px solid #dcdfe6',
          boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
          cursor: 'pointer',
          transition: 'all 0.2s ease'
        }
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 } },
          h('span', {
            'data-testid': 'lattice-case-severity',
            style: {
              padding: '2px 6px',
              borderRadius: 4,
              fontSize: 11,
              fontWeight: 600,
              background: sevInfo.bg,
              color: sevInfo.color,
              border: `1px solid ${sevInfo.border}`
            }
          }, `${sevInfo.badge} ${sevInfo.label}`),
          h('span', {
            'data-testid': 'lattice-case-status',
            style: {
              padding: '2px 6px',
              borderRadius: 4,
              fontSize: 11,
              fontWeight: 500,
              background: stateInfo.bg,
              color: stateInfo.color,
              border: `1px solid ${stateInfo.border}`
            }
          }, stateInfo.label)
        ),
        h('h5', { style: { margin: '0 0 6px 0', fontSize: 13, color: '#172b4d', fontWeight: 600, lineHeight: 1.4 } }, c.title),
        h('div', { style: { fontSize: 11, color: '#5e6c84', marginBottom: 4 } },
          '📦 ', h('strong', { style: { color: '#0958d9' } }, assetName)
        ),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: '#7a869a', marginTop: 8 } },
          h('span', null, '👤 ', c.handlerId || 'Chưa gán'),
          h('time', null, new Date(c.createdAt).toLocaleDateString('vi-VN'))
        )
      );
    };

    const renderBoardView = () => {
      return h('div', {
        'data-testid': 'lattice-case-board-view',
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: 16,
          marginTop: 16
        }
      },
        ...boardColumns.map(col => {
          const colCases = filteredCases.filter(c => col.states.includes(c.status));
          return h('div', {
            key: col.id,
            'data-testid': `lattice-case-column-${col.id}`,
            style: {
              background: '#f4f5f7',
              borderRadius: 8,
              padding: 12,
              minHeight: 360,
              border: '1px solid #dfe1e6'
            }
          },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, paddingBottom: 8, borderBottom: '2px solid ' + col.color } },
              h('h4', { style: { margin: 0, fontSize: 13, fontWeight: 700, color: col.color } }, col.title),
              h('span', { style: { background: col.color, color: '#fff', borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 600 } }, colCases.length)
            ),
            colCases.length === 0
              ? h('div', { style: { padding: '24px 8px', textAlign: 'center', color: '#a5b2c6', fontSize: 12, fontStyle: 'italic' } }, 'Không có sự cố')
              : colCases.map(c => renderCard(c))
          );
        })
      );
    };

    const renderListView = () => {
      return h('div', {
        'data-testid': 'lattice-case-list-view',
        style: { marginTop: 16, overflowX: 'auto', background: '#fff', borderRadius: 8, border: '1px solid #dce3ed' }
      },
        h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 13, textAlign: 'left' } },
          h('thead', null,
            h('tr', { style: { background: '#f8fafc', borderBottom: '1px solid #dce3ed', color: '#5e6c84', fontSize: 12 } },
              h('th', { style: { padding: '10px 14px' } }, 'Tiêu đề sự cố'),
              h('th', { style: { padding: '10px 14px' } }, 'Mức ưu tiên'),
              h('th', { style: { padding: '10px 14px' } }, 'Trạng thái'),
              h('th', { style: { padding: '10px 14px' } }, 'Kỹ thuật viên'),
              h('th', { style: { padding: '10px 14px' } }, 'Tài sản liên quan'),
              h('th', { style: { padding: '10px 14px' } }, 'Thời gian tạo'),
              h('th', { style: { padding: '10px 14px', textAlign: 'right' } }, 'Thao tác')
            )
          ),
          h('tbody', null,
            filteredCases.length === 0
              ? h('tr', null, h('td', { colSpan: 7, style: { padding: 24, textAlign: 'center', color: '#5e6c84' } }, 'Không tìm thấy sự cố nào phù hợp.'))
              : filteredCases.map(c => {
                const stateInfo = stateConfig[c.status] || stateConfig.open;
                const sevInfo = severityConfig[c.severity] || severityConfig.medium;
                const asset = assetMap[c.assetEntityId];
                const assetName = asset?.title || (c.assetEntityId ? `Tài sản #${c.assetEntityId.slice(-6)}` : '—');
                return h('tr', {
                  key: c.id,
                  'data-testid': `lattice-case-row-${c.id}`,
                  style: { borderBottom: '1px solid #f0f0f0', cursor: 'pointer' },
                  onClick: () => setSelectedCase(c)
                },
                  h('td', { style: { padding: '12px 14px', fontWeight: 600, color: '#172b4d' } }, c.title),
                  h('td', { style: { padding: '12px 14px' } },
                    h('span', { style: { padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: sevInfo.bg, color: sevInfo.color, border: '1px solid ' + sevInfo.border } },
                      `${sevInfo.badge} ${sevInfo.label}`
                    )
                  ),
                  h('td', { style: { padding: '12px 14px' } },
                    h('span', { style: { padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 500, background: stateInfo.bg, color: stateInfo.color, border: '1px solid ' + stateInfo.border } },
                      stateInfo.label
                    )
                  ),
                  h('td', { style: { padding: '12px 14px', color: '#42526e' } }, c.handlerId || 'Chưa gán'),
                  h('td', { style: { padding: '12px 14px', color: '#0958d9' } }, assetName),
                  h('td', { style: { padding: '12px 14px', color: '#7a869a', fontSize: 12 } }, new Date(c.createdAt).toLocaleString('vi-VN')),
                  h('td', { style: { padding: '12px 14px', textAlign: 'right' } },
                    h('button', {
                      type: 'button',
                      style: { padding: '4px 10px', fontSize: 12, borderRadius: 4, border: '1px solid #cdd7e5', background: '#fff', color: '#0958d9', cursor: 'pointer' },
                      onClick: (e) => {
                        e.stopPropagation();
                        setSelectedCase(c);
                      }
                    }, 'Chi tiết')
                  )
                );
              })
          )
        )
      );
    };

    return h('div', {
      'data-testid': 'lattice-case-board-container',
      style: { padding: 16, background: '#fff', borderRadius: 8, border: '1px solid #dce3ed', marginTop: 16 }
    },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 16 } },
        h('div', null,
          h('h3', { style: { margin: '0 0 4px 0', color: '#172b4d', fontSize: 18, fontWeight: 700 } }, 'Điều phối & Xử lý sự cố (Case Board)'),
          h('p', { style: { margin: 0, color: '#5e6c84', fontSize: 13 } }, 'Theo dõi sự cố hiện trường từ cảm biến, phân công kỹ thuật viên và điều phối xử lý theo quy trình.')
        ),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', {
            type: 'button',
            'data-testid': 'lattice-refresh-cases-btn',
            disabled: loading,
            onClick: loadData,
            style: { padding: '6px 12px', borderRadius: 6, border: '1px solid #cdd7e5', background: '#fff', color: '#172b4d', cursor: 'pointer', fontSize: 13 }
          }, loading ? 'Đang tải…' : '⟳ Làm mới'),
          h('button', {
            type: 'button',
            'data-testid': 'lattice-create-case-btn',
            onClick: () => setIsCreating(true),
            style: { padding: '6px 14px', borderRadius: 6, border: 'none', background: '#0052cc', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: 13 }
          }, '+ Báo sự cố mới')
        )
      ),

      error && h('div', { role: 'alert', 'data-testid': 'lattice-case-board-error', style: { padding: 10, background: '#ffebe6', color: '#cf1322', borderRadius: 6, marginBottom: 12, fontSize: 13 } }, error),
      successMessage && h('div', { role: 'status', style: { padding: 10, background: '#e3fcef', color: '#216e4e', borderRadius: 6, marginBottom: 12, fontSize: 13 } }, successMessage),
      retryWorkflowCommand && workflowCommands?.uncertain && h('button', {
        type: 'button',
        'data-testid': 'lattice-retry-workflow-command-btn',
        disabled: actionBusy || !connected,
        onClick: retryWorkflowTransition,
        style: { marginBottom: 12, padding: '7px 12px', background: '#fff7e6', color: '#ad6800', border: '1px solid #ffd591', borderRadius: 6, cursor: 'pointer', fontSize: 13 }
      }, actionBusy ? 'Đang thử lại…' : 'Thử lại thao tác'),

      // UC1 Bridge Banner
      h('div', {
        'data-testid': 'lattice-uc1-bridge-banner',
        style: {
          background: '#f0fdf4',
          border: '1px solid #bbf7d0',
          borderRadius: 8,
          padding: '10px 14px',
          marginBottom: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 10,
          fontSize: 13
        }
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { fontSize: 16 } }, '🔄'),
          h('span', { style: { color: '#166534', fontWeight: 600 } }, 'Liên kết UC1 (Bàn giao) → UC2 (Sự cố):'),
          h('span', { style: { color: '#14532d' } }, 'Điều phối xử lý sự cố thiết bị đã nghiệm thu & bàn giao từ luồng Mua sắm.')
        ),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            'data-testid': 'filter-uc1-pump-btn',
            onClick: () => { setFilterAsset('urn:ngsi-ld:Asset:DEMO-ASSET-01'); },
            style: {
              padding: '4px 10px',
              background: filterAsset === 'urn:ngsi-ld:Asset:DEMO-ASSET-01' ? '#16a34a' : '#fff',
              color: filterAsset === 'urn:ngsi-ld:Asset:DEMO-ASSET-01' ? '#fff' : '#166534',
              border: '1px solid #86efac',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 500
            }
          }, 'Bơm làm mát A1 (DEMO-ASSET-01)'),
          h('button', {
            type: 'button',
            'data-testid': 'filter-all-assets-btn',
            onClick: () => { setFilterAsset('all'); },
            style: {
              padding: '4px 10px',
              background: filterAsset === 'all' ? '#16a34a' : '#fff',
              color: filterAsset === 'all' ? '#fff' : '#166534',
              border: '1px solid #86efac',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 12
            }
          }, 'Tất cả tài sản')
        )
      ),

      // Toolbar: Search, Filters & View Toggle
      h('div', {
        'data-testid': 'lattice-case-toolbar',
        style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', background: '#f8fafc', padding: 12, borderRadius: 6, border: '1px solid #e2e8f0' }
      },
        h('input', {
          'data-testid': 'lattice-case-search',
          placeholder: 'Tìm theo tiêu đề, ID, tài sản…',
          value: searchQuery,
          onChange: e => setSearchQuery(e.target.value),
          style: { padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13, minWidth: 200 }
        }),
        h('select', {
          'data-testid': 'lattice-filter-status',
          value: filterStatus,
          onChange: e => setFilterStatus(e.target.value),
          style: { padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13, background: '#fff' }
        },
          h('option', { value: 'all' }, 'Trạng thái: Tất cả'),
          h('option', { value: 'open' }, 'Mới tiếp nhận'),
          h('option', { value: 'assigned' }, 'Đã giao việc'),
          h('option', { value: 'investigating' }, 'Đang kiểm tra'),
          h('option', { value: 'analyzing' }, 'Đang phân tích AI'),
          h('option', { value: 'analysis_failed' }, 'Phân tích thất bại'),
          h('option', { value: 'review_pending' }, 'Chờ duyệt đề xuất'),
          h('option', { value: 'approved' }, 'Đã duyệt đề xuất'),
          h('option', { value: 'rejected' }, 'Đề xuất bị từ chối'),
          h('option', { value: 'resolved' }, 'Đã khắc phục'),
          h('option', { value: 'closed' }, 'Đã đóng sự cố')
        ),
        h('select', {
          'data-testid': 'lattice-filter-severity',
          value: filterSeverity,
          onChange: e => setFilterSeverity(e.target.value),
          style: { padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13, background: '#fff' }
        },
          h('option', { value: 'all' }, 'Mức ưu tiên: Tất cả'),
          h('option', { value: 'critical' }, '🔴 Khẩn cấp'),
          h('option', { value: 'high' }, '🟠 Cao'),
          h('option', { value: 'medium' }, '🟡 Trung bình'),
          h('option', { value: 'low' }, '🔵 Thấp')
        ),
        h('select', {
          'data-testid': 'lattice-filter-asset',
          value: filterAsset,
          onChange: e => setFilterAsset(e.target.value),
          style: { padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13, background: '#fff', maxWidth: 180 }
        },
          h('option', { value: 'all' }, 'Tài sản: Tất cả'),
          ...visibleAssets.map(a => h('option', { key: a.id, value: a.id }, a.title || a.id.slice(-8)))
        ),
        h('select', {
          'data-testid': 'lattice-filter-department',
          value: filterDepartment,
          onChange: e => setFilterDepartment(e.target.value),
          style: { padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13, background: '#fff', maxWidth: 180 }
        },
          h('option', { value: 'all' }, 'Đơn vị: Tất cả'),
          ...visibleDepartments.map(d => h('option', { key: d.id, value: d.name || d.id }, d.name || d.code || d.id))
        ),
        h('div', { style: { marginLeft: 'auto', display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #cbd5e1' } },
          h('button', {
            type: 'button',
            'data-testid': 'lattice-view-board-btn',
            onClick: () => setViewMode('board'),
            style: {
              padding: '6px 12px',
              border: 'none',
              background: viewMode === 'board' ? '#0052cc' : '#fff',
              color: viewMode === 'board' ? '#fff' : '#172b4d',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600
            }
          }, '📊 Board'),
          h('button', {
            type: 'button',
            'data-testid': 'lattice-view-list-btn',
            onClick: () => setViewMode('list'),
            style: {
              padding: '6px 12px',
              border: 'none',
              background: viewMode === 'list' ? '#0052cc' : '#fff',
              color: viewMode === 'list' ? '#fff' : '#172b4d',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600
            }
          }, '📋 Danh sách')
        )
      ),

      viewMode === 'board' ? renderBoardView() : renderListView(),

      // Modal / Drawer chi tiết sự cố & thao tác workflow
      selectedCase && dataScope === scope && h('div', {
        'data-testid': 'lattice-case-detail-modal',
        style: {
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(9, 30, 66, 0.54)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: 16
        }
      },
        h('div', {
          style: {
            background: '#fff',
            borderRadius: 8,
            width: '100%',
            maxWidth: 640,
            maxHeight: '90vh',
            overflowY: 'auto',
            padding: 24,
            boxShadow: '0 8px 30px rgba(0,0,0,0.12)'
          }
        },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 } },
            h('div', null,
              h('div', { style: { fontSize: 12, color: '#5e6c84', marginBottom: 4 } }, `Mã sự cố: ${selectedCase.id}`),
              h('h3', { style: { margin: 0, color: '#172b4d', fontSize: 18 } }, selectedCase.title)
            ),
            h('button', {
              type: 'button',
              onClick: () => setSelectedCase(null),
              style: { border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer', color: '#5e6c84' }
            }, '✕')
          ),

          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16, background: '#f8fafc', padding: 12, borderRadius: 6 } },
            h('div', null,
              h('span', { style: { fontSize: 12, color: '#5e6c84', display: 'block' } }, 'Trạng thái hiện tại:'),
              h('strong', { style: { color: stateConfig[selectedCase.status]?.color || '#172b4d' } }, stateConfig[selectedCase.status]?.label || selectedCase.status)
            ),
            h('div', null,
              h('span', { style: { fontSize: 12, color: '#5e6c84', display: 'block' } }, 'Mức ưu tiên:'),
              h('strong', { style: { color: severityConfig[selectedCase.severity]?.color || '#172b4d' } }, severityConfig[selectedCase.severity]?.label || selectedCase.severity)
            ),
            h('div', null,
              h('span', { style: { fontSize: 12, color: '#5e6c84', display: 'block' } }, 'Tài sản:'),
              h('strong', { style: { color: '#0958d9' } }, assetMap[selectedCase.assetEntityId]?.title || selectedCase.assetEntityId)
            ),
            h('div', null,
              h('span', { style: { fontSize: 12, color: '#5e6c84', display: 'block' } }, 'Kỹ thuật viên phụ trách:'),
              h('strong', null, selectedCase.handlerId || 'Chưa gán')
            )
          ),

          // Detail Modal Tabs Bar
          h('div', { style: { display: 'flex', borderBottom: '1px solid #dfe1e6', marginBottom: 16, overflowX: 'auto', gap: 4 } },
            h('button', {
              type: 'button',
              'data-testid': 'lattice-modal-tab-overview',
              onClick: () => setDetailTab('overview'),
              style: { padding: '8px 12px', border: 'none', background: 'transparent', borderBottom: detailTab === 'overview' ? '2px solid #0052cc' : '2px solid transparent', color: detailTab === 'overview' ? '#0052cc' : '#5e6c84', fontWeight: detailTab === 'overview' ? 700 : 500, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }
            }, '📋 Tổng quan'),
            h('button', {
              type: 'button',
              'data-testid': 'lattice-modal-tab-resolution',
              onClick: () => setDetailTab('resolution'),
              style: { padding: '8px 12px', border: 'none', background: 'transparent', borderBottom: detailTab === 'resolution' ? '2px solid #0052cc' : '2px solid transparent', color: detailTab === 'resolution' ? '#0052cc' : '#5e6c84', fontWeight: detailTab === 'resolution' ? 700 : 500, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }
            }, '🛠️ Khắc phục & Đóng case'),
            h('button', {
              type: 'button',
              'data-testid': 'lattice-modal-tab-evidence',
              onClick: () => setDetailTab('evidence'),
              style: { padding: '8px 12px', border: 'none', background: 'transparent', borderBottom: detailTab === 'evidence' ? '2px solid #0052cc' : '2px solid transparent', color: detailTab === 'evidence' ? '#0052cc' : '#5e6c84', fontWeight: detailTab === 'evidence' ? 700 : 500, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }
            }, '📑 Đề xuất AI'),
            h('button', {
              type: 'button',
              'data-testid': 'lattice-modal-tab-attachments',
              onClick: () => setDetailTab('attachments'),
              style: { padding: '8px 12px', border: 'none', background: 'transparent', borderBottom: detailTab === 'attachments' ? '2px solid #0052cc' : '2px solid transparent', color: detailTab === 'attachments' ? '#0052cc' : '#5e6c84', fontWeight: detailTab === 'attachments' ? 700 : 500, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }
            }, '📎 Tệp & Biên bản'),
            h('button', {
              type: 'button',
              'data-testid': 'lattice-modal-tab-timeline',
              onClick: () => setDetailTab('timeline'),
              style: { padding: '8px 12px', border: 'none', background: 'transparent', borderBottom: detailTab === 'timeline' ? '2px solid #0052cc' : '2px solid transparent', color: detailTab === 'timeline' ? '#0052cc' : '#5e6c84', fontWeight: detailTab === 'timeline' ? 700 : 500, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }
            }, '⏱️ Lịch sử xử lý'),
            h('button', {
              type: 'button',
              'data-testid': 'lattice-modal-tab-approval',
              onClick: () => setDetailTab('approval'),
              style: { padding: '8px 12px', border: 'none', background: 'transparent', borderBottom: detailTab === 'approval' ? '2px solid #0052cc' : '2px solid transparent', color: detailTab === 'approval' ? '#0052cc' : '#5e6c84', fontWeight: detailTab === 'approval' ? 700 : 500, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }
            }, '⚖️ Luồng Approval'),
            h('button', {
              type: 'button',
              'data-testid': 'lattice-modal-tab-context',
              onClick: () => setDetailTab('context'),
              style: { padding: '8px 12px', border: 'none', background: 'transparent', borderBottom: detailTab === 'context' ? '2px solid #0052cc' : '2px solid transparent', color: detailTab === 'context' ? '#0052cc' : '#5e6c84', fontWeight: detailTab === 'context' ? 700 : 500, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }
            }, '🏢 Ngữ cảnh Tài sản & Số đo')
          ),

          // TAB: OVERVIEW
          detailTab === 'overview' && h('div', null,
            // Agent Run Block (when investigating, analyzing, failed, or has job)
            ['investigating', 'analyzing', 'analysis_failed', 'review_pending', 'approved'].includes(selectedCase.status) && h(AgentRun, {
              api,
              connection,
              caseItem: selectedCase,
              runId: selectedCase.id,
              onTransition: () => loadData()
            }),

            // Actions
            h('div', { style: { borderTop: '1px solid #e2e8f0', paddingTop: 16, marginTop: 16 } },
              h('h4', { style: { margin: '0 0 8px 0', fontSize: 14 } }, 'Thao tác nhanh quy trình:'),
              h('div', { style: { marginBottom: 12 } },
                h('input', {
                  'data-testid': 'lattice-case-action-note',
                  placeholder: 'Ghi chú xử lý / lý do duyệt / biên bản…',
                  value: actionNote,
                  onChange: e => setActionNote(e.target.value),
                  style: { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13 }
                })
              ),
              h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                selectedCase.status === 'open' && h('button', {
                  type: 'button',
                  'data-testid': 'lattice-action-assign',
                  disabled: workflowCommandBlocked,
                  onClick: () => handleTransition(selectedCase, 'assign'),
                  style: { padding: '6px 14px', background: '#0958d9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }
                }, 'Phân công kỹ thuật viên'),

                selectedCase.status === 'assigned' && h('button', {
                  type: 'button',
                  'data-testid': 'lattice-action-accept',
                  disabled: workflowCommandBlocked,
                  onClick: () => handleTransition(selectedCase, 'accept'),
                  style: { padding: '6px 14px', background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }
                }, 'Nhận việc kiểm tra'),

                selectedCase.status === 'investigating' && h('button', {
                  type: 'button',
                  'data-testid': 'lattice-action-analyze',
                  disabled: workflowCommandBlocked,
                  onClick: () => handleTransition(selectedCase, 'request_analysis'),
                  style: { padding: '6px 14px', background: '#722ed1', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }
                }, 'Yêu cầu AI phân tích'),

                selectedCase.status === 'analysis_failed' && h('button', {
                  type: 'button',
                  'data-testid': 'lattice-action-retry-analysis',
                  disabled: workflowCommandBlocked,
                  onClick: () => handleTransition(selectedCase, 'retry_analysis'),
                  style: { padding: '6px 14px', background: '#cf1322', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }
                }, 'Thử lại phân tích'),

                selectedCase.status === 'review_pending' && h('div', { style: { display: 'flex', gap: 8 } },
                  h('button', {
                    type: 'button',
                    'data-testid': 'lattice-action-approve',
                    disabled: workflowCommandBlocked,
                    onClick: () => handleTransition(selectedCase, 'approve'),
                    style: { padding: '6px 14px', background: '#389e0d', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }
                  }, 'Duyệt đề xuất'),
                  h('button', {
                    type: 'button',
                    'data-testid': 'lattice-action-reject',
                    disabled: workflowCommandBlocked,
                    onClick: () => handleTransition(selectedCase, 'reject'),
                    style: { padding: '6px 14px', background: '#cf1322', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }
                  }, 'Từ chối đề xuất')
                ),

                selectedCase.status === 'rejected' && h('button', {
                  type: 'button',
                  'data-testid': 'lattice-action-rework',
                  disabled: workflowCommandBlocked,
                  onClick: () => handleTransition(selectedCase, 'rework'),
                  style: { padding: '6px 14px', background: '#d46b08', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }
                }, 'Yêu cầu kiểm tra lại (Rework)'),

                selectedCase.status === 'approved' && h('button', {
                  type: 'button',
                  'data-testid': 'lattice-action-resolve',
                  disabled: workflowCommandBlocked,
                  onClick: () => handleTransition(selectedCase, 'record_resolution'),
                  style: { padding: '6px 14px', background: '#0958d9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }
                }, 'Ghi nhận khắc phục xong'),

                selectedCase.status === 'resolved' && h('button', {
                  type: 'button',
                  'data-testid': 'lattice-action-close',
                  disabled: workflowCommandBlocked,
                  onClick: () => handleTransition(selectedCase, 'close'),
                  style: { padding: '6px 14px', background: '#237804', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }
                }, 'Đóng sự cố'),

                h('button', {
                  type: 'button',
                  onClick: () => setSelectedCase(null),
                  style: { padding: '6px 14px', background: '#fff', color: '#5e6c84', border: '1px solid #cbd5e1', borderRadius: 6, cursor: 'pointer', fontSize: 13, marginLeft: 'auto' }
                }, 'Đóng hộp thoại')
              )
            )
          ),

          // TAB: RESOLUTION & CLOSE
          detailTab === 'resolution' && h('div', {
            'data-testid': 'lattice-tab-panel-resolution'
          }, h(CaseResolution, {
            api,
            connection,
            caseItem: selectedCase,
            runId: selectedCase.id,
            onTransition: () => loadData(),
            onReload: () => loadData()
          })),

          // TAB: EVIDENCE & PROPOSAL
          detailTab === 'evidence' && h('div', {
            'data-testid': 'lattice-tab-panel-evidence'
          }, h(EvidenceProposal, {
            api,
            connection,
            caseItem: selectedCase,
            onApprove: () => { loadData(); setSelectedCase(null); },
            onReject: () => { loadData(); setSelectedCase(null); },
            onRework: () => { loadData(); setSelectedCase(null); }
          })),

          // TAB: ATTACHMENTS (Reused AttachmentBlock)
          detailTab === 'attachments' && h('div', {
            'data-testid': 'lattice-tab-panel-attachments'
          }, h(AttachmentBlock, {
            manifest: incidentManifest,
            block: caseAttachmentBlock,
            api,
            connected,
            selectedId: selectedCase.id,
            run: selectedCase,
            actorId,
            onUploaded: () => loadData()
          })),

          // TAB: TIMELINE (Reused ActivityTimelineBlock)
          detailTab === 'timeline' && h('div', {
            'data-testid': 'lattice-tab-panel-timeline'
          }, h(ActivityTimelineBlock, {
            manifest: incidentManifest,
            block: caseTimelineBlock,
            api,
            connected,
            selectedId: selectedCase.id,
            run: selectedCase,
            actorId,
            actorName: api.connection?.identity?.username || 'User',
            canReadDirectory: true
          })),

          // TAB: APPROVAL (Reused ApprovalBlock)
          detailTab === 'approval' && h('div', {
            'data-testid': 'lattice-tab-panel-approval'
          }, h(ApprovalBlock, {
            manifest: incidentManifest,
            block: caseApprovalBlock,
            api,
            connected,
            selectedId: selectedCase.id,
            actorId,
            actorName: api.connection?.identity?.username || 'User',
            canReadDirectory: true,
            onSaved: () => loadData()
          })),

          // TAB: CONTEXT ENTITY & TELEMETRY (Reused ContextEntityBlock from UC1)
          detailTab === 'context' && h('div', {
            'data-testid': 'lattice-tab-panel-context'
          }, h(ContextEntityBlock, {
            manifest: incidentManifest,
            block: caseContextBlock,
            api,
            connected,
            selectedId: selectedCase.id,
            run: {
              ...selectedCase,
              recordId: selectedCase.recordId || selectedCase.id,
              entityContext: {
                entityId: selectedCase.assetEntityId,
                schemaId: 'incident-asset',
                entityVersion: 1
              }
            },
            actorId
          }))
        )
      ),

      // Modal tạo sự cố mới
      isCreating && h('div', {
        'data-testid': 'lattice-create-case-modal',
        style: {
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(9, 30, 66, 0.54)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: 16
        }
      },
        h('form', {
          onSubmit: handleCreateCase,
          style: {
            background: '#fff',
            borderRadius: 8,
            width: '100%',
            maxWidth: 520,
            padding: 24,
            boxShadow: '0 8px 30px rgba(0,0,0,0.12)'
          }
        },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 } },
            h('h3', { style: { margin: 0, color: '#172b4d', fontSize: 16 } }, 'Tạo mới hồ sơ sự cố thiết bị'),
            h('button', {
              type: 'button',
              onClick: () => setIsCreating(false),
              style: { border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer', color: '#5e6c84' }
            }, '✕')
          ),
          h('div', {
            role: 'status',
            'data-testid': 'case-create-notification-required',
            style: { padding: 12, marginBottom: 16, background: '#fff7e6', color: '#ad6800', border: '1px solid #ffd591', borderRadius: 6, fontSize: 13 }
          }, 'Chưa thể tạo sự cố thủ công vì chưa có nguồn notification hợp lệ. Sự cố cần được khởi tạo từ notification đã xác thực.'),

          h('div', { style: { marginBottom: 12 } },
            h('label', { style: { display: 'block', fontSize: 12, fontWeight: 600, color: '#344563', marginBottom: 4 } }, 'Tiêu đề sự cố *'),
            h('input', {
              'data-testid': 'lattice-create-case-title',
              required: true,
              value: createForm.title,
              placeholder: 'Ví dụ: Bơm cấp nước quá nhiệt tại Kho A',
              onChange: e => setCreateForm(prev => ({ ...prev, title: e.target.value })),
              style: { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13 }
            })
          ),

          h('div', { style: { marginBottom: 12 } },
            h('label', { style: { display: 'block', fontSize: 12, fontWeight: 600, color: '#344563', marginBottom: 4 } }, 'Tài sản xảy ra sự cố *'),
            h('select', {
              'data-testid': 'lattice-create-case-asset',
              required: true,
              value: createForm.assetEntityId,
              onChange: e => setCreateForm(prev => ({ ...prev, assetEntityId: e.target.value })),
              style: { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13, background: '#fff' }
            },
              h('option', { value: '' }, '-- Chọn tài sản giám sát --'),
              ...visibleAssets.map(a => h('option', { key: a.id, value: a.id }, `${a.title || a.id.slice(-8)} (${a.schemaId})`))
            )
          ),

          h('div', { style: { marginBottom: 16 } },
            h('div', null,
              h('label', { style: { display: 'block', fontSize: 12, fontWeight: 600, color: '#344563', marginBottom: 4 } }, 'Kỹ thuật viên phụ trách *'),
              h('input', {
                'data-testid': 'lattice-create-case-handler',
                required: true,
                value: createForm.handlerId,
                placeholder: 'ID kỹ thuật viên',
                onChange: e => setCreateForm(prev => ({ ...prev, handlerId: e.target.value })),
                style: { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13 }
              })
            )
          ),

          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
            h('button', {
              type: 'button',
              onClick: () => setIsCreating(false),
              style: { padding: '8px 16px', background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, cursor: 'pointer', fontSize: 13 }
            }, 'Hủy bỏ'),
            h('button', {
              type: 'submit',
              'data-testid': 'lattice-submit-case-btn',
              disabled: true,
              style: { padding: '8px 18px', background: '#0052cc', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 13 }
            }, 'Chưa khả dụng')
          )
        )
      )
    );
  };
}

module.exports = { createCaseBoardComponent };
