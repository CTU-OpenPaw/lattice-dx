/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use client';

import { useState, useTransition } from 'react';
import {
  INITIAL_ACTION_REQUIRED_TASKS,
  INITIAL_DEMO_SHORTCUTS,
  MOCK_WAREHOUSE_STAFF,
  MAX_FILE_SIZE_BYTES,
  validateOrderCreateInput,
  getScanStatusBadge,
  validateTaskDecisionInput,
  type TaskItem,
  type TaskStatus,
  type OrderCreateInput,
  type OrderCreateValidationErrors,
  type AttachmentItem,
} from '@dx/contracts';

const initialOrderForm: OrderCreateInput = {
  title: '',
  customerName: '',
  deliveryAddress: '',
  sku: '',
  quantity: 1,
  warehouseAssigneeId: '',
  note: '',
  attachments: [],
};

export default function WorkspacePage() {
  const [activeTab, setActiveTab] = useState<'action_required' | 'in_progress' | 'completed' | 'created_by_me'>('action_required');
  const [appFilter, setAppFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [tasks, setTasks] = useState<TaskItem[]>(INITIAL_ACTION_REQUIRED_TASKS);
  const [selectedTask, setSelectedTask] = useState<TaskItem | null>(null);
  const [isActionPending, startTransition] = useTransition();
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState('10:30');

  // Secondary actions menu state
  const [openMenuTaskId, setOpenMenuTaskId] = useState<string | null>(null);

  // Form tạo đơn hàng Logistics & tệp đính kèm ClamAV (Task H04)
  const [isOrderModalOpen, setIsOrderModalOpen] = useState(false);
  const [orderForm, setOrderForm] = useState<OrderCreateInput>(initialOrderForm);
  const [orderErrors, setOrderErrors] = useState<OrderCreateValidationErrors>({});
  const [isSavingOrder, setIsSavingOrder] = useState(false);

  // Decision Modal cho "Từ chối" (cần lý do)
  const [rejectingTask, setRejectingTask] = useState<TaskItem | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectError, setRejectError] = useState<string | null>(null);

  // Decision Modal cho "Nhận việc" (cần ghi chú)
  const [receivingTask, setReceivingTask] = useState<TaskItem | null>(null);
  const [receiptNote, setReceiptNote] = useState('');
  const [receiptError, setReceiptError] = useState<string | null>(null);

  // Lọc tác vụ
  const filteredTasks = tasks.filter(task => {
    if (appFilter !== 'all' && task.appId !== appFilter) return false;
    if (statusFilter !== 'all' && task.status !== statusFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchTitle = task.title.toLowerCase().includes(q);
      const matchCode = task.businessCode.toLowerCase().includes(q);
      if (!matchTitle && !matchCode) return false;
    }
    return true;
  });

  // Xử lý tải tệp đính kèm và quét virus ClamAV (Task H04)
  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // 1. Kiểm tra kích thước nghiêm ngặt 1 MiB (Fail-closed ngay tại client)
    if (file.size > MAX_FILE_SIZE_BYTES) {
      const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
      setToastMessage(`⚠️ Tệp "${file.name}" (${sizeMb} MB) vượt quá giới hạn cho phép (tối đa 1 MiB). Đã hủy tải lên.`);
      setOrderErrors(prev => ({
        ...prev,
        attachments: `Tệp "${file.name}" (${sizeMb} MB) vượt quá kích thước tối đa cho phép (1 MiB).`,
      }));
      e.target.value = '';
      return;
    }

    setOrderErrors(prev => ({ ...prev, attachments: undefined }));

    const newAttachmentId = `att-${Date.now()}`;
    const isEicar = file.name.toLowerCase().includes('eicar');

    const newAttachment: AttachmentItem = {
      id: newAttachmentId,
      name: file.name,
      size: file.size,
      scanStatus: 'scanning',
      uploadedAt: new Date().toISOString(),
    };

    setOrderForm(prev => ({
      ...prev,
      attachments: [...(prev.attachments || []), newAttachment],
    }));

    // Giả lập quy trình daemon ClamAV quét tệp (stream -> scanWithClamd)
    setTimeout(() => {
      setOrderForm(prev => ({
        ...prev,
        attachments: (prev.attachments || []).map(att => {
          if (att.id !== newAttachmentId) return att;
          if (isEicar) {
            return {
              ...att,
              scanStatus: 'rejected',
              scanDetails: 'ClamAV phát hiện: Eicar-Test-Signature FOUND! Tệp bị cách ly.',
            };
          }
          return {
            ...att,
            scanStatus: 'clean',
            scanDetails: 'ClamAV stream: OK (Clean)',
            downloadUrl: '#download',
          };
        }),
      }));
    }, 700);

    e.target.value = '';
  }

  // Thêm tệp mẫu sạch (clean)
  function handleAddCleanSampleFile() {
    const cleanAtt: AttachmentItem = {
      id: `att-${Date.now()}`,
      name: 'hop_dong_van_chuyen_2026.pdf',
      size: 768000, // 750 KB
      scanStatus: 'scanning',
      uploadedAt: new Date().toISOString(),
    };

    setOrderForm(prev => ({
      ...prev,
      attachments: [...(prev.attachments || []), cleanAtt],
    }));

    setTimeout(() => {
      setOrderForm(prev => ({
        ...prev,
        attachments: (prev.attachments || []).map(a =>
          a.id === cleanAtt.id
            ? { ...a, scanStatus: 'clean', scanDetails: 'ClamAV stream: OK (Clean)', downloadUrl: '#download' }
            : a
        ),
      }));
    }, 600);
  }

  // Thêm tệp mẫu EICAR (mã độc thử nghiệm) để kiểm thử tính năng cách ly
  function handleAddEicarTestFile() {
    const eicarAttachment: AttachmentItem = {
      id: `att-eicar-${Date.now()}`,
      name: 'eicar_antivirus_test_string.com',
      size: 68,
      scanStatus: 'scanning',
      uploadedAt: new Date().toISOString(),
    };

    setOrderForm(prev => ({
      ...prev,
      attachments: [...(prev.attachments || []), eicarAttachment],
    }));

    setTimeout(() => {
      setOrderForm(prev => ({
        ...prev,
        attachments: (prev.attachments || []).map(att => {
          if (att.id !== eicarAttachment.id) return att;
          return {
            ...att,
            scanStatus: 'rejected',
            scanDetails: 'ClamAV: Eicar-Signature FOUND. Phát hiện mã độc!',
          };
        }),
      }));
      setOrderErrors(prev => ({
        ...prev,
        attachments: 'Tệp đính kèm bị ClamAV phát hiện chứa mã độc, không thể lưu đơn.',
      }));
    }, 600);
  }

  function handleRemoveAttachment(id: string) {
    setOrderForm(prev => ({
      ...prev,
      attachments: (prev.attachments || []).filter(a => a.id !== id),
    }));
    setOrderErrors(prev => ({ ...prev, attachments: undefined }));
  }

  // Lưu đơn nháp Logistics (Task H04)
  function handleSaveOrderDraft() {
    const validation = validateOrderCreateInput(orderForm);
    if (!validation.isValid) {
      setOrderErrors(validation.errors);
      return;
    }

    setIsSavingOrder(true);

    setTimeout(() => {
      const assignedStaff = MOCK_WAREHOUSE_STAFF.find(s => s.id === orderForm.warehouseAssigneeId);
      const assignedName = assignedStaff ? assignedStaff.name : 'Kho';
      const newCode = `#ORD-${Math.floor(100 + Math.random() * 900)}`;

      const newDraftTask: TaskItem = {
        id: `task-ord-${Date.now()}`,
        businessCode: newCode,
        title: orderForm.title.trim(),
        appId: 'logistics',
        appName: 'Logistics',
        stakeholderLabel: 'Người tạo: Hưng',
        status: 'draft',
        statusLabel: 'Bản nháp',
        dueDateLabel: '—',
        assignedTo: assignedName,
        createdBy: 'Hưng',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        primaryAction: {
          kind: 'submit_to_warehouse',
          label: 'Gửi đơn cho kho',
          isPrimary: true,
        },
        secondaryActions: [
          {
            kind: 'view_details',
            label: 'Xem chi tiết',
            isPrimary: false,
          },
        ],
      };

      setTasks(prev => [newDraftTask, ...prev]);
      setIsSavingOrder(false);
      setIsOrderModalOpen(false);
      setOrderForm(initialOrderForm);
      setOrderErrors({});
      setToastMessage(`Đã tạo bản nháp đơn hàng ${newCode} thành công! Tệp đính kèm đã sẵn sàng.`);
      setTimeout(() => setToastMessage(null), 4000);
    }, 600);
  }

  // Xử lý hành động nghiệp vụ an toàn
  function handleTaskAction(task: TaskItem, actionKind: string) {
    if (isActionPending) return;

    startTransition(async () => {
      await new Promise(resolve => setTimeout(resolve, 600));

      if (actionKind === 'approve') {
        setToastMessage(`Đã duyệt thành công yêu cầu ${task.businessCode}!`);
        setTasks(prev => prev.filter(t => t.id !== task.id));
      } else if (actionKind === 'submit_to_warehouse') {
        setToastMessage(`Đã gửi đơn hàng ${task.businessCode} cho kho thành công!`);
        setTasks(prev =>
          prev.map(t =>
            t.id === task.id
              ? {
                  ...t,
                  status: 'awaiting_receipt',
                  statusLabel: 'Chờ kho nhận việc',
                  primaryAction: undefined,
                  stakeholderLabel: `Người được giao: ${t.assignedTo}`,
                }
              : t
          )
        );
      } else if (actionKind === 'receive_work') {
        setToastMessage(`Kho đã tiếp nhận nhiệm vụ xử lý đơn hàng ${task.businessCode}!`);
        setTasks(prev => prev.filter(t => t.id !== task.id));
      }

      if (selectedTask?.id === task.id) {
        setSelectedTask(null);
      }

      setTimeout(() => setToastMessage(null), 4000);
    });
  }

  function handlePrimaryActionClick(task: TaskItem) {
    if (!task.primaryAction) return;

    if (task.primaryAction.kind === 'receive_work') {
      setReceivingTask(task);
      setReceiptNote('Kho Cần Thơ đã tiếp nhận nhiệm vụ và chuẩn bị phân loại hàng hóa');
      setReceiptError(null);
    } else {
      handleTaskAction(task, task.primaryAction.kind);
    }
  }

  function handleReload() {
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    setLastUpdated(timeStr);
    setToastMessage('Đã tải lại dữ liệu mới nhất từ hệ thống');
    setTimeout(() => setToastMessage(null), 3000);
  }

  return (
    <div className="app-container">
      {/* 1. Header (60px) */}
      <header className="top-header">
        <div className="header-left">
          <span className="brand-title">LatticeDX</span>
          <span className="brand-badge">Workspace</span>
        </div>

        <div className="header-center">
          <div className="search-command-bar">
            <span>🔍</span>
            <input
              type="text"
              placeholder="Lọc theo nội dung hoặc nhấn Ctrl+K"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            <span className="kbd-shortcut">Ctrl+K</span>
          </div>
        </div>

        <div className="header-right">
          <span className="company-tag">Công ty ABC</span>
          <button className="notification-bell" aria-label="Thông báo">
            <span>🔔</span>
            <span className="notification-badge">2</span>
          </button>
          <div className="user-profile" title="Tài khoản cá nhân">
            <div className="user-avatar">H</div>
            <span className="user-name">Hưng</span>
          </div>
        </div>
      </header>

      <div className="app-body">
        {/* 2. Sidebar (224px) */}
        <aside className="sidebar">
          <nav className="sidebar-nav" aria-label="Điều hướng chính">
            <div className="nav-item active">
              <span>📋 Công việc của tôi</span>
            </div>
            <div className="nav-item">
              <span>📦 Ứng dụng</span>
            </div>
            <div className="nav-item">
              <span>📊 Báo cáo</span>
            </div>
            <div className="nav-item">
              <span>✨ AI Assistant</span>
              <span className="nav-badge-planned">Dự kiến</span>
            </div>
          </nav>

          <div className="sidebar-footer">
            <div className="nav-item">
              <span>❓ Trợ giúp</span>
            </div>
            <div className="nav-item">
              <span>⚙️ Cài đặt cá nhân</span>
            </div>
          </div>
        </aside>

        {/* 3. Main Viewport */}
        <main className="main-viewport">
          <h1 className="page-title">Công việc của tôi</h1>

          {/* Lối tắt ứng dụng - NẰM NGOÀI VÙNG TABS (Mục 7.1) */}
          <section className="shortcuts-section" aria-label="Lối tắt ứng dụng">
            <div className="shortcuts-header">
              <span className="shortcuts-title">Lối tắt ứng dụng</span>
              <a href="#apps" className="shortcuts-all-link">Xem tất cả ứng dụng →</a>
            </div>
            <div className="shortcuts-grid">
              {INITIAL_DEMO_SHORTCUTS.map(app => (
                <div key={app.id} className="shortcut-card">
                  <div className="card-top">
                    <div className={`card-icon ${app.id}`}>
                      {app.id === 'purchasing' ? '🛒' : app.id === 'logistics' ? '🚚' : '💳'}
                    </div>
                    <div className="card-info">
                      <h3>{app.name}</h3>
                      <p>{app.description}</p>
                    </div>
                  </div>
                  <div className="card-actions">
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => {
                        if (app.id === 'logistics') {
                          setIsOrderModalOpen(true);
                        } else {
                          setToastMessage(`Tính năng "${app.quickActionLabel}" đang được cấu hình cho ứng dụng ${app.name}`);
                          setTimeout(() => setToastMessage(null), 3000);
                        }
                      }}
                    >
                      {app.quickActionLabel}
                    </button>
                    <button className="btn btn-outline btn-sm">Mở</button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Tabs Bar */}
          <div className="tabs-container" role="tablist">
            <button
              className={`tab-btn ${activeTab === 'action_required' ? 'active' : ''}`}
              onClick={() => setActiveTab('action_required')}
              role="tab"
            >
              Cần xử lý ({tasks.length})
            </button>
            <button
              className={`tab-btn ${activeTab === 'in_progress' ? 'active' : ''}`}
              onClick={() => setActiveTab('in_progress')}
              role="tab"
            >
              Đang thực hiện
            </button>
            <button
              className={`tab-btn ${activeTab === 'completed' ? 'active' : ''}`}
              onClick={() => setActiveTab('completed')}
              role="tab"
            >
              Đã hoàn thành
            </button>
            <button
              className={`tab-btn ${activeTab === 'created_by_me' ? 'active' : ''}`}
              onClick={() => setActiveTab('created_by_me')}
              role="tab"
            >
              Tôi đã tạo
            </button>
          </div>

          {/* Toolbar */}
          <div className="toolbar">
            <div className="toolbar-filters">
              <select
                className="select-filter"
                value={appFilter}
                onChange={e => setAppFilter(e.target.value)}
                aria-label="Lọc theo ứng dụng"
              >
                <option value="all">Ứng dụng: Tất cả</option>
                <option value="purchasing">Mua sắm nội bộ</option>
                <option value="logistics">Logistics</option>
                <option value="expenses">Quản lý chi tiêu</option>
              </select>

              <select
                className="select-filter"
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                aria-label="Lọc theo trạng thái"
              >
                <option value="all">Trạng thái: Tất cả</option>
                <option value="pending_approval">Chờ duyệt</option>
                <option value="draft">Bản nháp</option>
                <option value="awaiting_receipt">Chờ kho nhận việc</option>
              </select>

              <input
                type="text"
                className="input-filter"
                placeholder="Lọc theo nội dung…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />

              {(appFilter !== 'all' || statusFilter !== 'all' || searchQuery) && (
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => { setAppFilter('all'); setStatusFilter('all'); setSearchQuery(''); }}
                >
                  Xóa bộ lọc
                </button>
              )}
            </div>

            <div className="toolbar-right">
              <span>Cập nhật lúc {lastUpdated}</span>
              <button className="btn-reload" onClick={handleReload} title="Tải lại dữ liệu">
                ⟳
              </button>
            </div>
          </div>

          {/* Bảng công việc (Data Table) */}
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: '35%' }}>Công việc</th>
                  <th style={{ width: '15%' }}>Ứng dụng</th>
                  <th style={{ width: '18%' }}>Người liên quan</th>
                  <th style={{ width: '14%' }}>Trạng thái</th>
                  <th style={{ width: '10%' }}>Hạn xử lý</th>
                  <th style={{ width: '8%', textAlign: 'right' }}>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {filteredTasks.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', padding: '36px', color: '#64748B' }}>
                      Không có công việc nào phù hợp với bộ lọc hiện tại.
                    </td>
                  </tr>
                ) : (
                  filteredTasks.map(task => (
                    <tr key={task.id}>
                      <td>
                        <div className="task-title-cell">
                          <span className="task-title-text" onClick={() => setSelectedTask(task)}>
                            {task.title}
                          </span>
                          <span className="task-code">{task.businessCode}</span>
                        </div>
                      </td>
                      <td>{task.appName}</td>
                      <td>{task.stakeholderLabel}</td>
                      <td>
                        <span className={`status-badge badge-${task.status}`}>
                          {task.statusLabel}
                        </span>
                      </td>
                      <td>
                        {task.dueDateLabel ? (
                          <span style={{ color: task.dueDateLabel.includes('hôm nay') ? '#D97706' : '#64748B' }}>
                            {task.dueDateLabel}
                          </span>
                        ) : '—'}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div className="actions-cell" style={{ justifyContent: 'flex-end', position: 'relative' }}>
                          {task.primaryAction && (
                            <button
                              className="btn btn-primary btn-sm"
                              disabled={isActionPending}
                              onClick={() => handlePrimaryActionClick(task)}
                            >
                              {isActionPending ? '…' : task.primaryAction.label}
                            </button>
                          )}
                          {task.secondaryActions && task.secondaryActions.length > 0 && (
                            <div style={{ position: 'relative', display: 'inline-block' }}>
                              <button
                                className="btn btn-outline btn-sm btn-icon"
                                title="Thao tác khác"
                                onClick={() => setOpenMenuTaskId(openMenuTaskId === task.id ? null : task.id)}
                              >
                                ···
                              </button>
                              {openMenuTaskId === task.id && (
                                <div style={{
                                  position: 'absolute',
                                  right: 0,
                                  top: '100%',
                                  marginTop: '4px',
                                  background: '#FFFFFF',
                                  border: '1px solid #D8E0EA',
                                  borderRadius: '6px',
                                  boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                                  zIndex: 30,
                                  minWidth: '140px',
                                  padding: '4px 0',
                                }}>
                                  {task.secondaryActions.map((sec, idx) => (
                                    <button
                                      key={idx}
                                      style={{
                                        display: 'block',
                                        width: '100%',
                                        padding: '7px 12px',
                                        textAlign: 'left',
                                        background: 'none',
                                        border: 'none',
                                        cursor: 'pointer',
                                        fontSize: '12px',
                                        color: sec.kind === 'reject' ? '#DC2626' : '#334155',
                                        fontWeight: 500,
                                      }}
                                      onClick={() => {
                                        setOpenMenuTaskId(null);
                                        if (sec.kind === 'reject') {
                                          setRejectingTask(task);
                                          setRejectReason('');
                                          setRejectError(null);
                                        } else {
                                          setSelectedTask(task);
                                        }
                                      }}
                                    >
                                      {sec.label}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </main>
      </div>

      {/* Drawer xem chi tiết công việc */}
      {selectedTask && (
        <div className="drawer-overlay" onClick={() => setSelectedTask(null)}>
          <div className="drawer-panel" onClick={e => e.stopPropagation()}>
            <div className="drawer-header">
              <div>
                <h2>{selectedTask.title}</h2>
                <span className="task-code" style={{ fontSize: '13px' }}>{selectedTask.businessCode}</span>
              </div>
              <button
                className="btn btn-outline btn-sm"
                onClick={() => setSelectedTask(null)}
                aria-label="Đóng"
              >
                ✕
              </button>
            </div>

            <div className="drawer-body">
              <div className="drawer-section">
                <h4>Trạng thái & Tiến độ</h4>
                <span className={`status-badge badge-${selectedTask.status}`} style={{ fontSize: '13px', padding: '5px 10px' }}>
                  {selectedTask.statusLabel}
                </span>
              </div>

              <div className="drawer-section">
                <h4>Thông tin người liên quan</h4>
                <p><strong>Người tạo:</strong> {selectedTask.createdBy}</p>
                <p><strong>Người được giao:</strong> {selectedTask.assignedTo}</p>
              </div>

              <div className="drawer-section">
                <h4>Dữ liệu nghiệp vụ ({selectedTask.appName})</h4>
                <p>Mã chứng từ: <code>{selectedTask.businessCode}</code></p>
                <p>Thời điểm tạo: {new Date(selectedTask.createdAt).toLocaleString('vi-VN')}</p>
                <p>Hạn xử lý: {selectedTask.dueDateLabel ?? 'Không có'}</p>
              </div>

              <div className="drawer-section">
                <h4>Tệp đính kèm (Giới hạn 1 MiB · Quét ClamAV)</h4>
                <div style={{ padding: '12px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <span style={{ fontWeight: 600 }}>Ho_so_yeu_cau.pdf</span>
                    <span style={{ fontSize: '12px', color: '#166534', display: 'block' }}>🛡️ 780 KB · Đã quét virus an toàn qua ClamAV</span>
                  </div>
                  <button className="btn btn-outline btn-sm">Tải về</button>
                </div>
              </div>

              <div className="drawer-section">
                <h4>Lịch sử xử lý (Audit Trail)</h4>
                <div style={{ fontSize: '13px', color: '#475569', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div>• <strong>{selectedTask.createdBy}</strong> đã tạo bản ghi và gửi yêu cầu ({new Date(selectedTask.createdAt).toLocaleTimeString('vi-VN')})</div>
                  <div>• Hệ thống tự động chuyển tiếp tới người có thẩm quyền: <strong>{selectedTask.assignedTo}</strong></div>
                </div>
              </div>
            </div>

            <div className="drawer-footer">
              <button className="btn btn-outline" onClick={() => setSelectedTask(null)}>
                Đóng
              </button>
              {selectedTask.primaryAction && (
                <button
                  className="btn btn-primary"
                  disabled={isActionPending}
                  onClick={() => handlePrimaryActionClick(selectedTask)}
                >
                  {isActionPending ? 'Đang xử lý…' : selectedTask.primaryAction.label}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal Tạo đơn hàng Logistics & Quét tệp ClamAV (Task H04) */}
      {isOrderModalOpen && (
        <div className="modal-overlay" onClick={() => setIsOrderModalOpen(false)}>
          <div className="modal-container" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">🚚 Tạo đơn hàng Logistics</div>
                <div className="modal-subtitle">Lưu bản nháp nghiệp vụ · Tự động quét virus ClamAV</div>
              </div>
              <button
                className="btn btn-outline btn-sm"
                onClick={() => setIsOrderModalOpen(false)}
                aria-label="Đóng"
              >
                ✕
              </button>
            </div>

            <div className="modal-body">
              {/* Tiêu đề đơn hàng */}
              <div className="form-group">
                <label className="form-label">
                  Nội dung đơn hàng <span className="required-star">*</span>
                </label>
                <input
                  type="text"
                  className={`form-input ${orderErrors.title ? 'has-error' : ''}`}
                  placeholder="Ví dụ: Vận chuyển linh kiện máy chủ chi nhánh Cần Thơ"
                  value={orderForm.title}
                  onChange={e => {
                    setOrderForm(prev => ({ ...prev, title: e.target.value }));
                    if (orderErrors.title) setOrderErrors(prev => ({ ...prev, title: undefined }));
                  }}
                />
                {orderErrors.title && <span className="form-error-msg">⚠️ {orderErrors.title}</span>}
              </div>

              {/* Khách hàng & Địa chỉ */}
              <div className="form-grid-2">
                <div className="form-group">
                  <label className="form-label">
                    Khách hàng / Đơn vị nhận <span className="required-star">*</span>
                  </label>
                  <input
                    type="text"
                    className={`form-input ${orderErrors.customerName ? 'has-error' : ''}`}
                    placeholder="Ví dụ: Viettel Cần Thơ"
                    value={orderForm.customerName}
                    onChange={e => {
                      setOrderForm(prev => ({ ...prev, customerName: e.target.value }));
                      if (orderErrors.customerName) setOrderErrors(prev => ({ ...prev, customerName: undefined }));
                    }}
                  />
                  {orderErrors.customerName && <span className="form-error-msg">⚠️ {orderErrors.customerName}</span>}
                </div>

                <div className="form-group">
                  <label className="form-label">
                    Địa chỉ nhận hàng <span className="required-star">*</span>
                  </label>
                  <input
                    type="text"
                    className={`form-input ${orderErrors.deliveryAddress ? 'has-error' : ''}`}
                    placeholder="Ví dụ: 285 Cách Mạng Tháng Tám, Q.10"
                    value={orderForm.deliveryAddress}
                    onChange={e => {
                      setOrderForm(prev => ({ ...prev, deliveryAddress: e.target.value }));
                      if (orderErrors.deliveryAddress) setOrderErrors(prev => ({ ...prev, deliveryAddress: undefined }));
                    }}
                  />
                  {orderErrors.deliveryAddress && <span className="form-error-msg">⚠️ {orderErrors.deliveryAddress}</span>}
                </div>
              </div>

              {/* SKU & Số lượng */}
              <div className="form-grid-2">
                <div className="form-group">
                  <label className="form-label">
                    Mã mặt hàng (SKU) <span className="required-star">*</span>
                  </label>
                  <input
                    type="text"
                    className={`form-input ${orderErrors.sku ? 'has-error' : ''}`}
                    placeholder="Ví dụ: SKU-ACC-102"
                    value={orderForm.sku}
                    onChange={e => {
                      setOrderForm(prev => ({ ...prev, sku: e.target.value }));
                      if (orderErrors.sku) setOrderErrors(prev => ({ ...prev, sku: undefined }));
                    }}
                  />
                  {orderErrors.sku && <span className="form-error-msg">⚠️ {orderErrors.sku}</span>}
                </div>

                <div className="form-group">
                  <label className="form-label">
                    Số lượng <span className="required-star">*</span>
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={1000000}
                    className={`form-input ${orderErrors.quantity ? 'has-error' : ''}`}
                    value={orderForm.quantity || ''}
                    onChange={e => {
                      const val = parseInt(e.target.value, 10);
                      setOrderForm(prev => ({ ...prev, quantity: isNaN(val) ? 0 : val }));
                      if (orderErrors.quantity) setOrderErrors(prev => ({ ...prev, quantity: undefined }));
                    }}
                  />
                  {orderErrors.quantity && <span className="form-error-msg">⚠️ {orderErrors.quantity}</span>}
                </div>
              </div>

              {/* Người kho nhận việc */}
              <div className="form-group">
                <label className="form-label">
                  Người kho nhận việc <span className="required-star">*</span>
                  <span className="form-help-text">Chọn từ danh bạ nhân sự kho</span>
                </label>
                <select
                  className={`form-select ${orderErrors.warehouseAssigneeId ? 'has-error' : ''}`}
                  value={orderForm.warehouseAssigneeId}
                  onChange={e => {
                    setOrderForm(prev => ({ ...prev, warehouseAssigneeId: e.target.value }));
                    if (orderErrors.warehouseAssigneeId) setOrderErrors(prev => ({ ...prev, warehouseAssigneeId: undefined }));
                  }}
                >
                  <option value="">-- Chọn nhân viên kho phụ trách --</option>
                  {MOCK_WAREHOUSE_STAFF.map(staff => (
                    <option key={staff.id} value={staff.id}>
                      {staff.name} — {staff.warehouseLocation} ({staff.department})
                    </option>
                  ))}
                </select>
                {orderErrors.warehouseAssigneeId && (
                  <span className="form-error-msg">⚠️ {orderErrors.warehouseAssigneeId}</span>
                )}
              </div>

              {/* Ghi chú */}
              <div className="form-group">
                <label className="form-label">Ghi chú bảo quản / vận chuyển</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Ví dụ: Hàng dễ vỡ, cần bảo quản nơi khô ráo"
                  value={orderForm.note || ''}
                  onChange={e => setOrderForm(prev => ({ ...prev, note: e.target.value }))}
                />
              </div>

              {/* Tệp đính kèm ClamAV */}
              <div className="form-group">
                <label className="form-label">
                  Tài liệu đính kèm (Biên bản / Hóa đơn / Đặc tả)
                  <span className="form-help-text">Tối đa 1 MiB · Quét ClamAV</span>
                </label>

                <label className="file-upload-zone">
                  <input
                    type="file"
                    style={{ display: 'none' }}
                    onChange={handleFileUpload}
                    accept=".pdf,.docx,.xlsx,.png,.jpg,.txt,.doc"
                  />
                  <span className="upload-icon">📁</span>
                  <span className="upload-prompt">Nhấn để chọn tệp hoặc kéo thả vào đây</span>
                  <span className="upload-sub">Hỗ trợ PDF, DOCX, XLSX, TXT, Ảnh (Dung lượng ≤ 1 MiB)</span>
                </label>

                {/* Quick test buttons for demonstration */}
                <div style={{ display: 'flex', gap: '8px', marginTop: '6px', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', color: '#64748B' }}>Thử nghiệm nhanh:</span>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    style={{ fontSize: '11px', padding: '2px 8px' }}
                    onClick={handleAddCleanSampleFile}
                  >
                    + Đính kèm mẫu hợp lệ (750 KB)
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    style={{ fontSize: '11px', padding: '2px 8px', color: '#DC2626', borderColor: '#FECACA' }}
                    onClick={handleAddEicarTestFile}
                  >
                    ☣️ Thử nghiệm tệp mã độc (EICAR)
                  </button>
                </div>

                {orderErrors.attachments && (
                  <span className="form-error-msg" style={{ marginTop: '6px' }}>
                    ⚠️ {orderErrors.attachments}
                  </span>
                )}

                {/* Danh sách tệp đính kèm */}
                {orderForm.attachments && orderForm.attachments.length > 0 && (
                  <div className="attachment-list">
                    {orderForm.attachments.map(att => {
                      const badge = getScanStatusBadge(att.scanStatus);
                      return (
                        <div key={att.id} className="attachment-item-card">
                          <div className="attachment-item-left">
                            <span className="attachment-file-icon">📄</span>
                            <div className="attachment-details">
                              <span className="attachment-name" title={att.name}>{att.name}</span>
                              <div className="attachment-meta">
                                <span>{(att.size / 1024).toFixed(1)} KB</span>
                                <span>•</span>
                                <span
                                  className="scan-status-badge"
                                  style={{ background: badge.bg, color: badge.color, border: `1px solid ${badge.border}` }}
                                >
                                  <span>{badge.icon}</span>
                                  <span>{badge.label}</span>
                                </span>
                              </div>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="btn-remove-attachment"
                            onClick={() => handleRemoveAttachment(att.id)}
                            title="Xóa tệp này"
                          >
                            ✕
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setIsOrderModalOpen(false)}
                disabled={isSavingOrder}
              >
                Hủy
              </button>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '12px', color: '#64748B' }}>
                  Trạng thái sau khi tạo: <strong>Bản nháp</strong>
                </span>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSaveOrderDraft}
                  disabled={isSavingOrder}
                >
                  {isSavingOrder ? (
                    <>
                      <span className="spinner-icon">🔄</span>
                      <span>Đang lưu...</span>
                    </>
                  ) : (
                    'Lưu đơn nháp'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Tiếp nhận xử lý đơn hàng (Nhận việc) */}
      {receivingTask && (
        <div className="modal-overlay" onClick={() => setReceivingTask(null)}>
          <div className="modal-container modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">📦 Tiếp nhận xử lý đơn hàng</div>
                <div className="modal-subtitle">{receivingTask.businessCode} · {receivingTask.title}</div>
              </div>
              <button className="btn btn-outline btn-sm" onClick={() => setReceivingTask(null)}>✕</button>
            </div>

            <div className="modal-body">
              <div style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', padding: '12px', borderRadius: '6px', fontSize: '12px', color: '#1E40AF', lineHeight: '1.5' }}>
                <strong>Lưu ý:</strong> Thao tác này xác nhận kho tiếp nhận nhiệm vụ xử lý đơn, <strong>không phải</strong> đã nhận hàng, xuất kho hoặc giao hàng.
              </div>

              <div className="form-group">
                <label className="form-label">
                  Ghi chú tiếp nhận <span className="required-star">*</span>
                </label>
                <textarea
                  className={`form-textarea ${receiptError ? 'has-error' : ''}`}
                  rows={3}
                  placeholder="Nhập ghi chú tiếp nhận công việc..."
                  value={receiptNote}
                  onChange={e => {
                    setReceiptNote(e.target.value);
                    if (receiptError) setReceiptError(null);
                  }}
                />
                {receiptError && <span className="form-error-msg">⚠️ {receiptError}</span>}
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setReceivingTask(null)}>Hủy</button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  const val = validateTaskDecisionInput('receive_work', { receiptNote });
                  if (!val.isValid) {
                    setReceiptError(val.error || 'Vui lòng nhập ghi chú tiếp nhận');
                    return;
                  }
                  handleTaskAction(receivingTask, 'receive_work');
                  setReceivingTask(null);
                }}
              >
                Xác nhận nhận việc
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Từ chối yêu cầu (cần lý do) */}
      {rejectingTask && (
        <div className="modal-overlay" onClick={() => setRejectingTask(null)}>
          <div className="modal-container modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">🚫 Từ chối yêu cầu</div>
                <div className="modal-subtitle">{rejectingTask.businessCode} · {rejectingTask.title}</div>
              </div>
              <button className="btn btn-outline btn-sm" onClick={() => setRejectingTask(null)}>✕</button>
            </div>

            <div className="modal-body">
              <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', padding: '12px', borderRadius: '6px', fontSize: '12px', color: '#991B1B', lineHeight: '1.5' }}>
                Theo quy trình Mua sắm nội bộ, từ chối yêu cầu bắt buộc phải cung cấp lý do cụ thể để lưu vết audit trail.
              </div>

              <div className="form-group">
                <label className="form-label">
                  Lý do từ chối <span className="required-star">*</span>
                </label>
                <textarea
                  className={`form-textarea ${rejectError ? 'has-error' : ''}`}
                  rows={3}
                  placeholder="Nhập lý do từ chối yêu cầu mua sắm..."
                  value={rejectReason}
                  onChange={e => {
                    setRejectReason(e.target.value);
                    if (rejectError) setRejectError(null);
                  }}
                />
                {rejectError && <span className="form-error-msg">⚠️ {rejectError}</span>}
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setRejectingTask(null)}>Hủy</button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  const val = validateTaskDecisionInput('reject', { reason: rejectReason });
                  if (!val.isValid) {
                    setRejectError(val.error || 'Vui lòng nhập lý do từ chối');
                    return;
                  }
                  setToastMessage(`Đã từ chối yêu cầu ${rejectingTask.businessCode}: "${rejectReason}"`);
                  setTasks(prev => prev.filter(t => t.id !== rejectingTask.id));
                  setRejectingTask(null);
                  setTimeout(() => setToastMessage(null), 4000);
                }}
              >
                Xác nhận từ chối
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast thông báo */}
      {toastMessage && (
        <div className="toast-banner success">
          <span>✓</span>
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  );
}
