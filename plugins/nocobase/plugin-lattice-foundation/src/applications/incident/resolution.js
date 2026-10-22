// SPDX-License-Identifier: Apache-2.0
function createCaseResolutionComponent(React) {
  const h = React.createElement;

  return function CaseResolution({
    api,
    connection,
    caseItem,
    runId,
    onTransition,
    onReload
  }) {
    const connected = connection?.connected !== false;
    const currentId = runId || caseItem?.id || caseItem?.runId;
    const status = caseItem?.status || 'approved';

    const [resolutionNote, setResolutionNote] = React.useState(caseItem?.resolutionNote || '');
    const [closeNote, setCloseNote] = React.useState(caseItem?.closeNote || '');
    const [checklist, setChecklist] = React.useState({
      hardwareChecked: true,
      sensorCalibrated: false,
      fluidReplaced: false,
      testRunPassed: true
    });
    const [confirmCloseModal, setConfirmCloseModal] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const [successMessage, setSuccessMessage] = React.useState('');

    // Handle Record Resolution (for Handler when status === 'approved')
    const handleRecordResolution = async (e) => {
      e?.preventDefault?.();
      if (!currentId) return;
      if (!resolutionNote.trim()) {
        setError('Vui lòng nhập chi tiết biên bản khắc phục sự cố.');
        return;
      }
      setBusy(true);
      setError('');
      try {
        const key = 'res-' + Date.now();
        const note = resolutionNote.trim();

        if (api.workflow) {
          await api.workflow('transition', {
            id: currentId,
            key,
            body: {
              action: 'record_resolution',
              expectedVersion: caseItem?.version || 1,
              input: { resolutionNote: note }
            }
          });
        }

        if (api.request) {
          try {
            await api.request({
              url: 'latticeIncidentCases:update',
              method: 'post',
              params: { filterByTk: caseItem?.runId || caseItem?.code || currentId },
              data: {
                status: 'resolved',
                resolutionNote: note
              }
            });
          } catch {
            // ignore
          }
        }

        setSuccessMessage('Đã ghi nhận kết quả khắc phục sự cố thành công! Hồ sơ chuyển sang trạng thái chờ Quản lý nghiệm thu và đóng.');
        onTransition?.('record_resolution');
        onReload?.();
      } catch (err) {
        setError(err.status === 403 || err.response?.status === 403
          ? 'Chỉ Kỹ thuật viên phụ trách (incident:handler) mới có thẩm quyền ghi nhận kết quả khắc phục.'
          : (err.message || 'Không thể ghi nhận khắc phục sự cố.'));
      } finally {
        setBusy(false);
      }
    };

    // Handle Close Case (for Manager when status === 'resolved')
    const handleCloseCase = async () => {
      if (!currentId) return;
      if (!closeNote.trim()) {
        setError('Vui lòng nhập nhận xét nghiệm thu và ghi chú đóng sự cố.');
        return;
      }
      setBusy(true);
      setError('');
      try {
        const key = 'close-' + Date.now();
        const note = closeNote.trim();

        if (api.workflow) {
          await api.workflow('transition', {
            id: currentId,
            key,
            body: {
              action: 'close',
              expectedVersion: caseItem?.version || 1,
              input: { closeNote: note }
            }
          });
        }

        if (api.request) {
          try {
            await api.request({
              url: 'latticeIncidentCases:update',
              method: 'post',
              params: { filterByTk: caseItem?.runId || caseItem?.code || currentId },
              data: {
                status: 'closed',
                closeNote: note
              }
            });
          } catch {
            // ignore
          }
        }

        if (caseItem?.assetEntityId && api.entity) {
          try {
            const suggestedStatus = caseItem?.proposal?.suggestedStatus || 'repair';
            await api.entity('update', {
              id: caseItem.assetEntityId,
              attributes: { status: suggestedStatus }
            });
          } catch {
            // ignore
          }
        }

        setSuccessMessage('Đã đóng sự cố và cập nhật trạng thái tài sản thành công! Hồ sơ đã được lưu trữ an toàn.');
        setConfirmCloseModal(false);
        onTransition?.('close');
        onReload?.();
      } catch (err) {
        setError(err.status === 403 || err.response?.status === 403
          ? 'Chỉ Quản lý (incident:manager) mới có thẩm quyền phê duyệt đóng sự cố.'
          : (err.message || 'Không thể đóng sự cố.'));
      } finally {
        setBusy(false);
      }
    };

    return h('div', {
      'data-testid': 'lattice-case-resolution-container',
      style: {
        padding: 16,
        background: '#ffffff',
        borderRadius: 8,
        border: '1px solid #dce3ed',
        marginTop: 16
      }
    },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 } },
        h('div', null,
          h('h4', { style: { margin: '0 0 4px 0', fontSize: 16, fontWeight: 700, color: '#172b4d' } },
            '🛠️ Kết quả Khắc phục Hiện trường & Đóng Sự cố'
          ),
          h('p', { style: { margin: 0, fontSize: 12, color: '#5e6c84' } },
            'Quy trình ghi nhận hoàn tất sửa chữa của Kỹ thuật viên và nghiệm thu đóng hồ sơ của Quản lý.'
          )
        ),
        h('span', {
          'data-testid': 'lattice-resolution-status-badge',
          style: {
            padding: '4px 10px',
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 700,
            background: status === 'closed' ? '#f5f5f5' : status === 'resolved' ? '#e6f4ff' : '#f6ffed',
            color: status === 'closed' ? '#595959' : status === 'resolved' ? '#0958d9' : '#389e0d',
            border: `1px solid ${status === 'closed' ? '#d9d9d9' : status === 'resolved' ? '#91caff' : '#b7eb8f'}`
          }
        }, status === 'closed' ? '📁 Đã đóng hồ sơ' : status === 'resolved' ? '⏱️ Chờ quản lý đóng' : '🛠️ Đang khắc phục')
      ),

      error && h('div', { role: 'alert', 'data-testid': 'lattice-resolution-error', style: { padding: '8px 12px', background: '#fff1f0', color: '#cf1322', border: '1px solid #ffa39e', borderRadius: 6, fontSize: 13, marginBottom: 14 } }, error),
      successMessage && h('div', { role: 'status', style: { padding: '8px 12px', background: '#f6ffed', color: '#389e0d', border: '1px solid #b7eb8f', borderRadius: 6, fontSize: 13, marginBottom: 14 } }, successMessage),

      // 1. SECTION: FORM KẾT QUẢ KHẮC PHỤC (RECORD RESOLUTION)
      (status === 'approved' || status === 'resolved' || status === 'closed') && h('div', {
        'data-testid': 'lattice-record-resolution-section',
        style: {
          padding: 14,
          background: '#f8fafc',
          borderRadius: 6,
          border: '1px solid #e2e8f0',
          marginBottom: 16
        }
      },
        h('h5', { style: { margin: '0 0 10px 0', fontSize: 14, color: '#0958d9', display: 'flex', alignItems: 'center', gap: 6 } },
          '🔧 1. Biên bản khắc phục hiện trường (Kỹ thuật viên phụ trách):'
        ),

        status === 'approved' ? h('form', { onSubmit: handleRecordResolution },
          h('div', { style: { marginBottom: 12 } },
            h('label', { style: { display: 'block', fontSize: 12, fontWeight: 600, color: '#344563', marginBottom: 4 } },
              'Các hạng mục đã kiểm tra & xử lý thực tế:'
            ),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 12, color: '#172b4d', margin: '6px 0 10px 0' } },
              h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' } },
                h('input', {
                  type: 'checkbox',
                  checked: checklist.hardwareChecked,
                  onChange: e => setChecklist(prev => ({ ...prev, hardwareChecked: e.target.checked }))
                }),
                'Kiểm tra cơ khí / đấu nối dây'
              ),
              h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' } },
                h('input', {
                  type: 'checkbox',
                  checked: checklist.fluidReplaced,
                  onChange: e => setChecklist(prev => ({ ...prev, fluidReplaced: e.target.checked }))
                }),
                'Thay van / Vệ sinh màng lọc'
              ),
              h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' } },
                h('input', {
                  type: 'checkbox',
                  checked: checklist.sensorCalibrated,
                  onChange: e => setChecklist(prev => ({ ...prev, sensorCalibrated: e.target.checked }))
                }),
                'Hiệu chuẩn cảm biến đo PT100'
              ),
              h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' } },
                h('input', {
                  type: 'checkbox',
                  checked: checklist.testRunPassed,
                  onChange: e => setChecklist(prev => ({ ...prev, testRunPassed: e.target.checked }))
                }),
                'Chạy thử không tải 15 phút (Đạt)'
              )
            )
          ),

          h('div', { style: { marginBottom: 12 } },
            h('label', { style: { display: 'block', fontSize: 12, fontWeight: 600, color: '#344563', marginBottom: 4 } },
              'Mô tả chi tiết kết quả xử lý (resolutionNote) *'
            ),
            h('textarea', {
              'data-testid': 'lattice-resolution-note-input',
              required: true,
              rows: 3,
              placeholder: 'Ví dụ: Đã thay thế van làm mát số 2, thông rửa đường ống tản nhiệt và bổ sung dung dịch làm mát. Sau 15 phút kiểm tra số đo nhiệt độ ổn định ở 48°C dưới ngưỡng cho phép 60°C.',
              value: resolutionNote,
              onChange: e => setResolutionNote(e.target.value),
              style: { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13 }
            })
          ),

          h('button', {
            type: 'submit',
            'data-testid': 'lattice-submit-resolution-btn',
            disabled: busy,
            style: {
              padding: '8px 18px',
              borderRadius: 6,
              background: '#0958d9',
              color: '#fff',
              border: 'none',
              fontWeight: 600,
              fontSize: 13,
              cursor: 'pointer'
            }
          }, busy ? 'Đang lưu…' : '💾 Ghi nhận hoàn tất khắc phục')
        ) : h('div', null,
          h('div', { style: { fontSize: 13, color: '#172b4d', background: '#fff', padding: 10, borderRadius: 6, border: '1px solid #e2e8f0', lineHeight: 1.5 } },
            h('strong', { style: { color: '#0958d9', display: 'block', marginBottom: 4 } }, 'Nội dung biên bản:'),
            caseItem?.resolutionNote || resolutionNote || 'Đã khắc phục hoàn tất và nghiệm thu chạy thử.'
          )
        )
      ),

      // 2. SECTION: NÚT ĐÓNG CASE & NGHIỆM THU (CLOSE CASE)
      (status === 'resolved' || status === 'closed') && h('div', {
        'data-testid': 'lattice-close-case-section',
        style: {
          padding: 14,
          background: status === 'closed' ? '#f5f5f5' : '#fffbe6',
          borderRadius: 6,
          border: `1px solid ${status === 'closed' ? '#d9d9d9' : '#ffe58f'}`,
          marginBottom: 12
        }
      },
        h('h5', { style: { margin: '0 0 10px 0', fontSize: 14, color: status === 'closed' ? '#595959' : '#ad6800', display: 'flex', alignItems: 'center', gap: 6 } },
          status === 'closed' ? '📁 2. Hồ sơ nghiệm thu & Đóng sự cố:' : '🔒 2. Nghiệm thu & Xác nhận đóng sự cố (Quản lý):'
        ),

        status === 'resolved' ? h('div', null,
          h('div', { style: { fontSize: 13, color: '#172b4d', marginBottom: 12 } },
            'Kỹ thuật viên đã gửi biên bản xử lý hoàn tất. Quản lý kiểm tra kết quả và ghi chú nghiệm thu trước khi đóng sự cố.'
          ),
          h('div', { style: { marginBottom: 12 } },
            h('label', { style: { display: 'block', fontSize: 12, fontWeight: 600, color: '#344563', marginBottom: 4 } },
              'Nhận xét nghiệm thu & Ghi chú đóng sự cố (closeNote) *'
            ),
            h('textarea', {
              'data-testid': 'lattice-close-note-input',
              required: true,
              rows: 2,
              placeholder: 'Ví dụ: Đã nghiệm thu thiết bị hoạt động ổn định, các thông số cảm biến đạt tiêu chuẩn an toàn. Chấp thuận kết thúc quy trình và đóng hồ sơ sự cố.',
              value: closeNote,
              onChange: e => setCloseNote(e.target.value),
              style: { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13 }
            })
          ),
          h('button', {
            type: 'button',
            'data-testid': 'lattice-open-close-modal-btn',
            disabled: busy,
            onClick: () => {
              if (!closeNote.trim()) {
                setError('Vui lòng nhập ghi chú nghiệm thu đóng sự cố.');
                return;
              }
              setError('');
              setConfirmCloseModal(true);
            },
            style: {
              padding: '8px 18px',
              borderRadius: 6,
              background: '#237804',
              color: '#fff',
              border: 'none',
              fontWeight: 600,
              fontSize: 13,
              cursor: 'pointer'
            }
          }, '🔒 Xác nhận đóng sự cố')
        ) : h('div', null,
          h('div', { style: { padding: 10, background: '#fff', borderRadius: 6, border: '1px solid #d9d9d9', fontSize: 13, color: '#595959' } },
            h('strong', { style: { display: 'block', marginBottom: 4, color: '#262626' } }, 'Ghi chú đóng sự cố từ Quản lý:'),
            caseItem?.closeNote || closeNote || 'Đã đóng sự cố sau khi nghiệm thu.'
          ),
          h('div', { style: { marginTop: 10, padding: 8, background: '#e6f7ff', borderRadius: 4, fontSize: 12, color: '#0050b3' } },
            '✅ Hồ sơ sự cố đã được lưu trữ vĩnh viễn trong nhật ký hoạt động. Trạng thái tài sản đã được cập nhật thành công.'
          )
        )
      ),

      // 3. CONFIRMATION MODAL BEFORE CLOSING
      confirmCloseModal && h('div', {
        'data-testid': 'lattice-confirm-close-modal',
        style: {
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(9, 30, 66, 0.54)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1100,
          padding: 16
        }
      },
        h('div', {
          style: {
            background: '#fff',
            borderRadius: 8,
            width: '100%',
            maxWidth: 480,
            padding: 24,
            boxShadow: '0 8px 30px rgba(0,0,0,0.16)'
          }
        },
          h('h4', { style: { margin: '0 0 12px 0', fontSize: 16, color: '#cf1322' } },
            '⚠️ Xác nhận đóng hồ sơ sự cố'
          ),
          h('p', { style: { fontSize: 13, color: '#172b4d', lineHeight: 1.5, margin: '0 0 16px 0' } },
            'Bạn có chắc chắn muốn đóng hồ sơ sự cố này? Hệ thống sẽ cập nhật trạng thái tài sản theo đề xuất của AI và đóng băng toàn bộ dữ liệu quy trình.'
          ),
          h('div', { style: { padding: 10, background: '#f8fafc', borderRadius: 6, fontSize: 12, color: '#5e6c84', marginBottom: 16 } },
            'Ghi chú đóng: ', h('strong', { style: { color: '#172b4d' } }, closeNote)
          ),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 10 } },
            h('button', {
              type: 'button',
              disabled: busy,
              onClick: () => setConfirmCloseModal(false),
              style: { padding: '8px 16px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', fontSize: 13, cursor: 'pointer' }
            }, 'Hủy bỏ'),
            h('button', {
              type: 'button',
              'data-testid': 'lattice-confirm-close-btn',
              disabled: busy,
              onClick: handleCloseCase,
              style: { padding: '8px 18px', borderRadius: 6, border: 'none', background: '#cf1322', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }
            }, busy ? 'Đang đóng…' : 'Đồng ý đóng sự cố')
          )
        )
      )
    );
  };
}

module.exports = { createCaseResolutionComponent };
