/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

async function fetchPageSurfaceState(api, { portalSlug = '', pageTitle = '' } = {}) {
  if (!api?.request || !portalSlug) return null;
  try {
    const res = await api.request({
      url: 'dxosAi:pageSurfaceState',
      method: 'get',
      params: { portalSlug, ...(pageTitle ? { pageTitle } : {}) },
    });
    return res?.data?.data || res?.data || null;
  } catch {
    return null;
  }
}

async function fetchInspectPageBlocks(api, { portalSlug = '', pageTitle = '' } = {}) {
  if (!api?.request || !portalSlug) return { blocks: [] };
  try {
    const res = await api.request({
      url: 'dxosAi:inspectPageBlocks',
      method: 'get',
      params: { portalSlug, ...(pageTitle ? { pageTitle } : {}) },
    });
    const data = res?.data?.data || res?.data || {};
    return { ...data, blocks: Array.isArray(data.blocks) ? data.blocks : [] };
  } catch {
    return { blocks: [] };
  }
}

async function requestPageRollback(api, { portalSlug = '', pageTitle = '', snapshotUid = '' } = {}) {
  if (!api?.request || !portalSlug) return { rolledBack: false };
  const res = await api.request({
    url: 'dxosAi:rollbackPageSnapshot',
    method: 'post',
    data: { portalSlug, ...(pageTitle ? { pageTitle } : {}), ...(snapshotUid ? { snapshotUid } : {}) },
  });
  return res?.data?.data || res?.data || { rolledBack: false };
}

function formatTargetBlockPrompt(blockMeta = {}, portalSlug = '') {
  const uid = String(blockMeta.uid || '').trim();
  const use = String(blockMeta.use || 'BlockModel').trim();
  const title = String(blockMeta.title || use).trim();
  const slug = String(portalSlug || '').trim() || 'services';
  return [
    `[Target Portal: /p/${slug} · Block UID: ${uid} (${use} — ${title})]`,
    'Hãy kiểm tra hoặc nâng cấp trực tiếp block này (hoặc gợi ý & gắn thêm block sáng tạo cạnh block này) trên trang hiện tại.',
  ].join('\n');
}

function createAdminArchitectBarElement(React, {
  isAdmin = false,
  picking = false,
  rollingBack = false,
  syncMessage = '',
  inspectedBlocks = [],
  onTogglePicker,
  onPickBlock,
  onRollback,
} = {}) {
  if (!React?.createElement || (!isAdmin && !syncMessage)) return null;
  const h = React.createElement;

  return h('div', {
    'data-testid': 'dxos-admin-architect-bar',
    style: {
      marginTop: 10,
      paddingTop: 10,
      borderTop: '1px dashed #cbd5e1',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    },
  },
    syncMessage ? h('div', {
      'data-testid': 'dxos-live-canvas-sync-banner',
      style: {
        padding: '6px 10px',
        borderRadius: 8,
        background: '#ecfdf5',
        border: '1px solid #34d399',
        color: '#065f46',
        fontSize: 12,
        fontWeight: 700,
      },
    }, `✨ ${syncMessage}`) : null,
    isAdmin ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
      h('span', { style: { fontSize: 11, fontWeight: 700, color: '#475569' } }, 'Studio Kiến trúc Sống:'),
      h('button', {
        type: 'button',
        'data-testid': 'dxos-picker-toggle-btn',
        onClick: () => typeof onTogglePicker === 'function' && onTogglePicker(),
        style: {
          padding: '4px 10px',
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 700,
          cursor: 'pointer',
          border: '1px solid #6366f1',
          background: picking ? '#4f46e5' : '#eef2ff',
          color: picking ? '#ffffff' : '#3730a3',
        },
      }, picking ? '✕ Đóng chọn Block' : '🎯 Chọn Block sửa với AI'),
      h('button', {
        type: 'button',
        'data-testid': 'dxos-rollback-page-btn',
        disabled: rollingBack,
        onClick: () => typeof onRollback === 'function' && onRollback(),
        style: {
          padding: '4px 10px',
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 700,
          cursor: rollingBack ? 'wait' : 'pointer',
          border: '1px solid #f59e0b',
          background: '#fffbeb',
          color: '#92400e',
        },
      }, rollingBack ? 'Đang hoàn tác…' : '⏪ Hoàn tác trang'),
    ) : null,
    isAdmin && picking ? h('div', {
      'data-testid': 'dxos-block-picker-panel',
      style: {
        padding: 8,
        borderRadius: 8,
        background: '#f8fafc',
        border: '1px solid #cbd5e1',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
      },
    },
      !inspectedBlocks.length
        ? h('span', { style: { fontSize: 12, color: '#64748b' } }, 'Chưa đọc được danh sách block trên trang.')
        : inspectedBlocks.map((blk) => h('button', {
          key: blk.uid,
          type: 'button',
          onClick: () => typeof onPickBlock === 'function' && onPickBlock(blk),
          style: {
            padding: '4px 9px',
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            border: '1px solid #818cf8',
            background: '#ffffff',
            color: '#1e1b4b',
          },
        }, `${blk.title || blk.use} [${String(blk.uid).slice(0, 14)}]`)),
    ) : null,
  );
}

module.exports = {
  fetchPageSurfaceState,
  fetchInspectPageBlocks,
  requestPageRollback,
  formatTargetBlockPrompt,
  createAdminArchitectBarElement,
};
