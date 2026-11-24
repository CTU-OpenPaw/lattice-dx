/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const TRACK_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TRACK_TOKEN_RE = /^[A-Za-z0-9._-]{1,128}$/;

function sanitizeTrackCode(raw) {
  let val = String(raw || '').trim();
  if (!val) return '';
  try {
    val = decodeURIComponent(val);
  } catch {
    return '';
  }
  if (!val || val.includes('..') || val.includes('/') || val.includes('\\')) return '';
  return TRACK_CODE_RE.test(val) ? val : '';
}

function sanitizeTrackToken(raw) {
  let val = String(raw || '').trim();
  if (!val) return '';
  try {
    val = decodeURIComponent(val);
  } catch {
    return '';
  }
  return TRACK_TOKEN_RE.test(val) ? val : '';
}

function parseQueryString(searchStr) {
  const out = {};
  const raw = String(searchStr || '').replace(/^\?/, '');
  if (!raw) return out;
  for (const part of raw.split('&')) {
    if (!part) continue;
    const eqIdx = part.indexOf('=');
    const k = eqIdx >= 0 ? part.slice(0, eqIdx) : part;
    const v = eqIdx >= 0 ? part.slice(eqIdx + 1) : '';
    try {
      const key = decodeURIComponent(k.replace(/\+/g, ' '));
      out[key] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      // Ignore malformed query pair
    }
  }
  return out;
}

function parseTrackParams(locationLike) {
  const loc = locationLike || (typeof window !== 'undefined' ? window.location : null);
  if (!loc) return { trackingCode: '', token: '' };
  const pathname = String(loc.pathname || '');
  const match = pathname.match(/^\/(?:v\/)?track\/([^/?#]+)\/?$/i);
  const trackingCode = match ? sanitizeTrackCode(match[1]) : '';
  const query = parseQueryString(loc.search || '');
  const token = sanitizeTrackToken(query.token || query.trackingToken || '');
  return { trackingCode, token };
}

function resolveLegacyTrackRedirect(winLike) {
  if (!winLike || winLike.__nocobase_app_client_entry_mode__ !== 'legacy-default') return null;
  const loc = winLike.location;
  if (!loc) return null;
  const pathname = String(loc.pathname || '');
  if (!pathname || pathname === '/mobile' || pathname.startsWith('/mobile/') || pathname.startsWith('/v/')) {
    return null;
  }
  if (pathname === '/track' || pathname.startsWith('/track/')) {
    return `/v${pathname}${loc.search || ''}${loc.hash || ''}`;
  }
  return null;
}

function projectZeroPiiPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const temp = raw.tempSummary && typeof raw.tempSummary === 'object'
    ? {
      ...(raw.tempSummary.mktCelsius !== undefined ? { mktCelsius: raw.tempSummary.mktCelsius } : {}),
      ...(raw.tempSummary.inRange !== undefined ? { inRange: Boolean(raw.tempSummary.inRange) } : {}),
      ...(raw.tempSummary.evidencePhotoCount !== undefined ? { evidencePhotoCount: Number(raw.tempSummary.evidencePhotoCount) || 0 } : {}),
    }
    : null;
  const ledger = raw.ledgerVerification && typeof raw.ledgerVerification === 'object'
    ? {
      seq: raw.ledgerVerification.seq ?? null,
      keyId: String(raw.ledgerVerification.keyId || ''),
      verifiedFormat: Boolean(raw.ledgerVerification.verifiedFormat),
      ...(raw.ledgerVerification.signatureBase64 ? { signatureBase64: String(raw.ledgerVerification.signatureBase64) } : {}),
    }
    : null;
  return {
    trackingCode: String(raw.trackingCode || ''),
    status: String(raw.status || ''),
    deliveredAt: raw.deliveredAt ? String(raw.deliveredAt) : '',
    orderCode: raw.orderCode ? String(raw.orderCode) : '',
    tempSummary: temp,
    ledgerVerification: ledger,
  };
}

function extractApiError(err, fallbackMsg) {
  const serverMsg = err?.response?.data?.errors?.[0]?.message || err?.response?.data?.message;
  const status = err?.response?.status || err?.status;
  if (serverMsg) return { message: String(serverMsg), status };
  if (err?.message) return { message: String(err.message), status };
  return { message: fallbackMsg, status };
}

function createPublicTrackPage(client, React, app) {
  return function PublicTrackPage(props = {}) {
    const h = React.createElement;
    const useAPIClient = client?.useAPIClient;
    let hookApiClient = null;
    if (typeof useAPIClient === 'function') {
      try {
        hookApiClient = useAPIClient();
      } catch {
        hookApiClient = null;
      }
    }
    const apiClient = props?.apiClient || hookApiClient || app?.apiClient || null;

    const initialParams = parseTrackParams(props?.location);
    const propCode = props?.trackingCode ? sanitizeTrackCode(props.trackingCode) : '';
    const propToken = props?.token ? sanitizeTrackToken(props.token) : '';
    const effectiveCode = propCode || initialParams.trackingCode;
    const effectiveToken = propToken || initialParams.token;

    const [loading, setLoading] = React.useState(false);
    const [errorMsg, setErrorMsg] = React.useState('');
    const [trackData, setTrackData] = React.useState(null);
    const [verifying, setVerifying] = React.useState(false);
    const [verifyResult, setVerifyResult] = React.useState(null);
    const [verifyError, setVerifyError] = React.useState('');

    async function callEndpoint(actionUrl, opts = {}) {
      if (apiClient && typeof apiClient.request === 'function') {
        const res = await apiClient.request({
          url: actionUrl,
          method: opts.method || 'GET',
          ...(opts.params ? { params: opts.params } : {}),
          ...(opts.data ? { data: opts.data } : {}),
        });
        return res?.data?.data ?? res?.data ?? res;
      }
      if (typeof fetch !== 'function') {
        throw new Error('Không tìm thấy API client khả dụng.');
      }
      const query = opts.params ? `?${new URLSearchParams(opts.params).toString()}` : '';
      const resp = await fetch(`/api/${actionUrl}${query}`, {
        method: opts.method || 'GET',
        headers: opts.data ? { 'Content-Type': 'application/json' } : undefined,
        body: opts.data ? JSON.stringify(opts.data) : undefined,
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const err = new Error(json?.errors?.[0]?.message || json?.message || `HTTP ${resp.status}`);
        err.response = { status: resp.status, data: json };
        throw err;
      }
      return json?.data ?? json;
    }

    React.useEffect(() => {
      let active = true;
      if (!effectiveCode || !effectiveToken) {
        setTrackData(null);
        setErrorMsg('Thiếu mã vận đơn hợp lệ hoặc mã xác thực (?token=...) để tra cứu công khai.');
        setLoading(false);
        return () => { active = false; };
      }
      setLoading(true);
      setErrorMsg('');
      setVerifyResult(null);
      setVerifyError('');
      callEndpoint('dxosWms:publicTrack', {
        method: 'GET',
        params: { trackingCode: effectiveCode, token: effectiveToken },
      })
        .then((payload) => {
          if (!active) return;
          setTrackData(projectZeroPiiPayload(payload));
          setLoading(false);
        })
        .catch((err) => {
          if (!active) return;
          const info = extractApiError(err, 'Không thể tải trạng thái vận đơn công khai.');
          setTrackData(null);
          setErrorMsg(info.message);
          setLoading(false);
        });
      return () => { active = false; };
    }, [effectiveCode, effectiveToken]);

    async function handleVerifySignature() {
      if (!trackData?.ledgerVerification?.keyId) {
        setVerifyError('Chứng từ chưa có thông tin khóa Ed25519 để kiểm định.');
        return;
      }
      setVerifying(true);
      setVerifyError('');
      setVerifyResult(null);
      try {
        const res = await callEndpoint('dxosLedger:verifySignature', {
          method: 'POST',
          data: {
            keyId: trackData.ledgerVerification.keyId,
            signatureBase64: trackData.ledgerVerification.signatureBase64 || 'verify-public-track',
            payload: {
              trackingCode: trackData.trackingCode,
              status: trackData.status,
              deliveredAt: trackData.deliveredAt,
              seq: trackData.ledgerVerification.seq,
            },
          },
        });
        setVerifyResult({
          valid: Boolean(res?.valid),
          keyId: String(res?.keyId || trackData.ledgerVerification.keyId),
          fingerprintSha256: String(res?.fingerprintSha256 || ''),
        });
      } catch (err) {
        const info = extractApiError(err, 'Không thể kiểm định chữ ký Ed25519.');
        if (info.status === 401 || info.status === 403) {
          setVerifyError('Kiểm định trực tuyến yêu cầu phiên đăng nhập nội bộ; định dạng chữ ký Ed25519 trên vận đơn đã được ghi nhận.');
        } else {
          setVerifyError(info.message);
        }
      } finally {
        setVerifying(false);
      }
    }

    const ledger = trackData?.ledgerVerification;
    const temp = trackData?.tempSummary;

    return h(
      'div',
      {
        'data-testid': 'public-track-page',
        style: {
          maxWidth: 720,
          margin: '32px auto',
          padding: 24,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          background: '#f8fafc',
          borderRadius: 12,
          border: '1px solid #e2e8f0',
          color: '#0f172a',
        },
      },
      h(
        'header',
        { style: { marginBottom: 20, borderBottom: '1px solid #cbd5e1', paddingBottom: 12 } },
        h('div', { style: { fontSize: 12, fontWeight: 700, color: '#0284c7', textTransform: 'uppercase' } }, 'LatticeDX Cold-Chain Trust · Zero-PII'),
        h('h1', { style: { margin: '4px 0 0', fontSize: 22, fontWeight: 700 } }, 'Tra cứu Vận đơn & Xác thực Chuỗi ký số Ed25519'),
      ),
      loading
        ? h('div', { 'data-testid': 'public-track-loading', role: 'status', style: { padding: 16, background: '#e0f2fe', borderRadius: 8 } }, 'Đang tải thông tin vận đơn...')
        : null,
      errorMsg
        ? h('div', { 'data-testid': 'public-track-error', role: 'alert', style: { padding: 16, background: '#fee2e2', color: '#991b1b', borderRadius: 8, marginBottom: 16 } }, errorMsg)
        : null,
      trackData
        ? h(
          'section',
          {
            'data-testid': 'public-track-status-card',
            style: { background: '#ffffff', padding: 20, borderRadius: 10, border: '1px solid #cbd5e1' },
          },
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 16 } },
            h('div', null, h('div', { style: { fontSize: 12, color: '#64748b' } }, 'Mã theo dõi (Tracking Code)'), h('strong', null, trackData.trackingCode)),
            h('div', null, h('div', { style: { fontSize: 12, color: '#64748b' } }, 'Mã đơn hàng (Order)'), h('strong', null, trackData.orderCode || '—')),
            h('div', null, h('div', { style: { fontSize: 12, color: '#64748b' } }, 'Trạng thái giao nhận'), h('strong', null, trackData.status || '—')),
            h('div', null, h('div', { style: { fontSize: 12, color: '#64748b' } }, 'Thời điểm giao'), h('strong', null, trackData.deliveredAt || '—')),
          ),
          temp
            ? h('div', { style: { padding: 12, borderRadius: 8, background: temp.inRange === false ? '#fef2f2' : '#f0fdf4', marginBottom: 16 } },
              h('span', { style: { fontWeight: 600 } }, 'Chuỗi lạnh (MKT): '),
              temp.mktCelsius !== undefined ? `${temp.mktCelsius} °C` : 'Chưa ghi nhận',
              ' · ',
              temp.inRange === false ? 'Cảnh báo vượt ngưỡng' : 'Đạt chuẩn 2–8 °C',
            )
            : null,
          ledger
            ? h('div', { style: { padding: 12, borderRadius: 8, background: '#f1f5f9', marginBottom: 16 } },
              h('div', null, `Sổ cái bất biến #${ledger.seq ?? '—'} · Khóa: ${ledger.keyId || '—'}`),
              h('div', { style: { fontSize: 13, color: '#475569', marginTop: 4 } },
                ledger.verifiedFormat ? 'Định dạng chữ ký Ed25519 hợp lệ' : 'Chưa có chữ ký Ed25519',
              ),
            )
            : null,
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
            h(
              'button',
              {
                type: 'button',
                'data-testid': 'public-track-verify-btn',
                disabled: verifying,
                onClick: handleVerifySignature,
                style: {
                  padding: '8px 14px',
                  borderRadius: 6,
                  border: '1px solid #0284c7',
                  background: '#0284c7',
                  color: '#ffffff',
                  fontWeight: 600,
                  cursor: verifying ? 'not-allowed' : 'pointer',
                },
              },
              verifying ? 'Đang kiểm định chữ ký...' : 'Xác thực chữ ký Ed25519 trực tuyến',
            ),
          ),
          verifyResult
            ? h('div', {
              'data-testid': 'public-track-verify-result',
              style: {
                marginTop: 12,
                padding: 12,
                borderRadius: 8,
                background: verifyResult.valid ? '#dcfce7' : '#fee2e2',
                color: verifyResult.valid ? '#166534' : '#991b1b',
              },
            },
            `${verifyResult.valid ? 'Chữ ký Ed25519 hợp lệ' : 'Chữ ký không khớp'} · Key: ${verifyResult.keyId}${verifyResult.fingerprintSha256 ? ` · SHA-256: ${verifyResult.fingerprintSha256}` : ''}`,
            )
            : null,
          verifyError
            ? h('div', {
              'data-testid': 'public-track-verify-error',
              style: { marginTop: 12, padding: 12, borderRadius: 8, background: '#fef3c7', color: '#92400e' },
            }, verifyError)
            : null,
        )
        : null,
    );
  };
}

module.exports = {
  parseTrackParams,
  resolveLegacyTrackRedirect,
  createPublicTrackPage,
};
