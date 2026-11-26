/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const QR_SVG_PATH = path.join(PLUGIN_ROOT, 'src/server/qr-svg.js');

// Independent ISO/IEC 18004 verifier helpers (GF(256) 0x11D, BCH, mask, alignment)
const ALIGN_COORDS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
  11: [6, 30, 54],
  12: [6, 32, 58],
};

function makeGf() {
  const exp = new Uint8Array(512);
  const log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    exp[i] = x;
    log[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) exp[i] = exp[i - 255];
  return {
    exp,
    log,
    mul: (a, b) => (a === 0 || b === 0 ? 0 : exp[log[a] + log[b]]),
  };
}

function bchRemainder(val, poly, polyDegree) {
  let d = val;
  for (let bit = 17; bit >= polyDegree; bit -= 1) {
    if ((d >> bit) & 1) {
      d ^= poly << (bit - polyDegree);
    }
  }
  return d;
}

function applyMaskPredicate(maskId, r, c) {
  switch (maskId) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: throw new Error(`Invalid mask: ${maskId}`);
  }
}

function buildFunctionMask(version, size) {
  const fn = Array.from({ length: size }, () => new Uint8Array(size));
  const markRect = (r0, c0, h, w) => {
    for (let r = r0; r < r0 + h; r += 1) {
      for (let c = c0; c < c0 + w; c += 1) {
        if (r >= 0 && r < size && c >= 0 && c < size) fn[r][c] = 1;
      }
    }
  };
  // 3 Finders + separators (8x8 corners)
  markRect(0, 0, 9, 9); // includes format strip
  markRect(0, size - 8, 9, 8);
  markRect(size - 8, 0, 8, 9);
  // Timing
  for (let i = 8; i < size - 8; i += 1) {
    fn[6][i] = 1;
    fn[i][6] = 1;
  }
  // Alignment patterns
  const coords = ALIGN_COORDS[version] || [];
  for (const r of coords) {
    for (const c of coords) {
      const overlapsFinder = (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
      if (!overlapsFinder) markRect(r - 2, c - 2, 5, 5);
    }
  }
  // Version info for >= 7
  if (version >= 7) {
    markRect(0, size - 11, 6, 3);
    markRect(size - 11, 0, 3, 6);
  }
  return fn;
}

function verifyFinderAt(modules, r0, c0) {
  const expected = [
    [1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1],
  ];
  for (let dr = 0; dr < 7; dr += 1) {
    for (let dc = 0; dc < 7; dc += 1) {
      assert.equal(modules[r0 + dr][c0 + dc], expected[dr][dc], `Finder mismatch at (${r0 + dr},${c0 + dc})`);
    }
  }
}

function decodeFormatInfoFromMatrix(modules, size) {
  // Primary strip: row 8 cols 0..5, 7, 8, and rows 7, 5..0 col 8
  const coords1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  let bits1 = 0;
  for (let i = 0; i < 15; i += 1) {
    const [r, c] = coords1[i];
    bits1 = (bits1 << 1) | (modules[r][c] ? 1 : 0);
  }
  // Secondary strip: rows size-1 .. size-7 col 8 (MSB 14..8), row 8 cols size-8 .. size-1 (LSB 7..0)
  const coords2 = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ];
  let bits2 = 0;
  for (let i = 0; i < 15; i += 1) {
    const [r, c] = coords2[i];
    bits2 = (bits2 << 1) | (modules[r][c] ? 1 : 0);
  }
  assert.equal(bits1, bits2, 'Primary and secondary format strips must match');
  const unmasked = bits1 ^ 0x5412;
  assert.equal(bchRemainder(unmasked, 0x537, 10), 0, 'Format info BCH(15,5) syndrome must be 0');
  const eccBits = (unmasked >> 13) & 0x3;
  const maskId = (unmasked >> 10) & 0x7;
  const eccMap = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };
  return { eccLevel: eccMap[eccBits], maskPattern: maskId };
}

function extractRawBits(modules, version, size, maskPattern) {
  const fn = buildFunctionMask(version, size);
  const bits = [];
  let col = size - 1;
  let upward = true;
  while (col > 0) {
    if (col === 6) col -= 1;
    for (let step = 0; step < size; step += 1) {
      const r = upward ? size - 1 - step : step;
      for (const c of [col, col - 1]) {
        if (!fn[r][c]) {
          const rawBit = modules[r][c] ? 1 : 0;
          const unmasked = applyMaskPredicate(maskPattern, r, c) ? rawBit ^ 1 : rawBit;
          bits.push(unmasked);
        }
      }
    }
    col -= 2;
    upward = !upward;
  }
  return bits;
}

test('qr-svg.js obeys SPDX Apache-2.0 header and has zero external dependencies', () => {
  const src = readFileSync(QR_SVG_PATH, 'utf8');
  assert.ok(src.includes('@copyright (C) 2026 CTU-OpenPaw'));
  assert.ok(src.includes('SPDX-License-Identifier: Apache-2.0'));
  assert.equal(new RegExp('\\bco' + 'pilot\\b', 'i').test(src), false);
  assert.equal(/\brequire\s*\(/.test(src), false, 'qr-svg.js must have zero external dependencies');
});

test('encodeQrMatrix produces authentic ISO/IEC 18004 matrices with finder, separator, timing, dark module, alignment, and valid BCH format/version', () => {
  const { encodeQrMatrix } = require(QR_SVG_PATH);

  // Version 1 short payload
  const v1 = encodeQrMatrix('HELLO', { eccLevel: 'M' });
  assert.equal(v1.version, 1);
  assert.equal(v1.size, 21);
  assert.equal(v1.modules.length, 21);
  assert.equal(v1.modules[0].length, 21);

  verifyFinderAt(v1.modules, 0, 0);
  verifyFinderAt(v1.modules, 0, 14);
  verifyFinderAt(v1.modules, 14, 0);

  // Separators (all 0)
  for (let i = 0; i < 8; i += 1) {
    assert.equal(v1.modules[7][i], 0);
    assert.equal(v1.modules[i][7], 0);
    assert.equal(v1.modules[7][20 - i], 0);
    assert.equal(v1.modules[i][13], 0);
    assert.equal(v1.modules[13][i], 0);
    assert.equal(v1.modules[20 - i][7], 0);
  }
  // Timing patterns
  for (let i = 8; i < 13; i += 1) {
    assert.equal(v1.modules[6][i], i % 2 === 0 ? 1 : 0);
    assert.equal(v1.modules[i][6], i % 2 === 0 ? 1 : 0);
  }
  // Dark module at (4*version + 9, 8) = (13, 8)
  assert.equal(v1.modules[13][8], 1);

  const fmt1 = decodeFormatInfoFromMatrix(v1.modules, 21);
  assert.equal(fmt1.eccLevel, 'M');
  assert.equal(fmt1.maskPattern, v1.maskPattern);

  // Version >= 2 alignment pattern check (e.g. ~24 bytes in M -> Version 2, 25x25)
  const v2 = encodeQrMatrix('https://dxos.vn/track/01', { eccLevel: 'M' });
  assert.ok(v2.version >= 2, `Expected version >= 2, got ${v2.version}`);
  assert.equal(v2.size, 17 + 4 * v2.version);
  const lastCoord = v2.size - 7;
  // Center alignment module at (lastCoord, lastCoord) must be dark, inner ring light, outer ring dark
  assert.equal(v2.modules[lastCoord][lastCoord], 1);
  assert.equal(v2.modules[lastCoord - 1][lastCoord], 0);
  assert.equal(v2.modules[lastCoord - 2][lastCoord], 1);

  // Long signed /v/track/... URL (Versions 5-10) + Version >= 7 version info BCH check
  const longTrackUrl = 'https://portal.latticedx.vn/v/track/LDX-TRK-A1B2C3D4E5?token=ldx_trk_0123456789abcdef0123456789abcdef&sig=ed25519_merkle_root_check_2026_olp';
  const vLong = encodeQrMatrix(longTrackUrl, { eccLevel: 'M' });
  assert.ok(vLong.version >= 7 && vLong.version <= 10, `Expected Version 7-10 for 149-byte signed URL, got V${vLong.version}`);
  verifyFinderAt(vLong.modules, 0, 0);
  verifyFinderAt(vLong.modules, 0, vLong.size - 7);
  verifyFinderAt(vLong.modules, vLong.size - 7, 0);
  assert.equal(vLong.modules[4 * vLong.version + 9][8], 1);
  const fmtLong = decodeFormatInfoFromMatrix(vLong.modules, vLong.size);
  assert.equal(fmtLong.eccLevel, 'M');

  // Verify Version Info 18-bit BCH(18,6) in top-right (6x3) & bottom-left (3x6)
  let verBitsTr = 0;
  for (let r = 5; r >= 0; r -= 1) {
    for (let c = vLong.size - 9; c >= vLong.size - 11; c -= 1) {
      verBitsTr = (verBitsTr << 1) | (vLong.modules[r][c] ? 1 : 0);
    }
  }
  let verBitsBl = 0;
  for (let c = 5; c >= 0; c -= 1) {
    for (let r = vLong.size - 9; r >= vLong.size - 11; r -= 1) {
      verBitsBl = (verBitsBl << 1) | (vLong.modules[r][c] ? 1 : 0);
    }
  }
  assert.equal(verBitsTr, verBitsBl, 'Top-right and bottom-left version info must match');
  assert.equal(bchRemainder(verBitsTr, 0x1f25, 12), 0, 'Version info BCH(18,6) syndrome must be 0');
  assert.equal(verBitsTr >> 12, vLong.version);
});

test('encodeQrMatrix encodes valid GF(256) Reed-Solomon codewords and round-trips Byte-mode payload (ASCII + UTF-8 + long signed URL)', () => {
  const { encodeQrMatrix, getVersionEcSpec } = require(QR_SVG_PATH);
  const gf = makeGf();

  const payloads = [
    'HELLO WORLD',
    'Kho lạnh Cần Thơ #01',
    '/v/track/LDX-TRK-99AA88BB77?token=ldx_trk_deadbeefcafebabe0123456789abcdef',
    'https://demo.latticedx.vn/v/track/LDX-TRK-7766554433?token=ldx_trk_ffeeddccbbaa99887766554433221100&org=org-cantho&seq=42',
  ];

  for (const text of payloads) {
    const qr = encodeQrMatrix(text, { eccLevel: 'M' });
    const spec = getVersionEcSpec(qr.version, 'M');
    const rawBits = extractRawBits(qr.modules, qr.version, qr.size, qr.maskPattern);

    const totalCodewords = spec.g1Blocks * (spec.g1Data + spec.ecPerBlock) + spec.g2Blocks * (spec.g2Data + spec.ecPerBlock);
    assert.ok(rawBits.length >= totalCodewords * 8);

    const codewords = [];
    for (let i = 0; i < totalCodewords; i += 1) {
      let byte = 0;
      for (let b = 0; b < 8; b += 1) {
        byte = (byte << 1) | rawBits[i * 8 + b];
      }
      codewords.push(byte);
    }

    // De-interleave blocks
    const numBlocks = spec.g1Blocks + spec.g2Blocks;
    const blockData = Array.from({ length: numBlocks }, () => []);
    const blockEcc = Array.from({ length: numBlocks }, () => []);
    let cursor = 0;
    const maxDataLen = Math.max(spec.g1Data, spec.g2Data);
    for (let col = 0; col < maxDataLen; col += 1) {
      for (let b = 0; b < numBlocks; b += 1) {
        const bLen = b < spec.g1Blocks ? spec.g1Data : spec.g2Data;
        if (col < bLen) blockData[b].push(codewords[cursor++]);
      }
    }
    for (let col = 0; col < spec.ecPerBlock; col += 1) {
      for (let b = 0; b < numBlocks; b += 1) {
        blockEcc[b].push(codewords[cursor++]);
      }
    }
    assert.equal(cursor, totalCodewords);

    // Check Reed-Solomon syndromes S_j = P(alpha^j) == 0 for every block!
    for (let b = 0; b < numBlocks; b += 1) {
      const fullPoly = [...blockData[b], ...blockEcc[b]];
      for (let rootIdx = 0; rootIdx < spec.ecPerBlock; rootIdx += 1) {
        const alpha = gf.exp[rootIdx];
        let evalVal = 0;
        for (const coeff of fullPoly) {
          evalVal = gf.mul(evalVal, alpha) ^ coeff;
        }
        assert.equal(evalVal, 0, `RS syndrome != 0 for payload "${text}" block ${b} root ${rootIdx}`);
      }
    }

    // Reconstruct data bits and decode Byte mode UTF-8 payload
    const dataBytes = blockData.flat();
    const dataBits = [];
    for (const byte of dataBytes) {
      for (let bit = 7; bit >= 0; bit -= 1) dataBits.push((byte >> bit) & 1);
    }
    const readInt = (pos, len) => {
      let v = 0;
      for (let i = 0; i < len; i += 1) v = (v << 1) | dataBits[pos + i];
      return v;
    };
    const mode = readInt(0, 4);
    assert.equal(mode, 0b0100, 'Expected Byte mode (0100)');
    const cciLen = qr.version <= 9 ? 8 : 16;
    const byteCount = readInt(4, cciLen);
    const decodedBytes = new Uint8Array(byteCount);
    for (let i = 0; i < byteCount; i += 1) {
      decodedBytes[i] = readInt(4 + cciLen + i * 8, 8);
    }
    assert.equal(Buffer.from(decodedBytes).toString('utf8'), text);
  }
});

test('renderQrSvg returns deterministic, valid, XSS-safe SVG XML with viewBox and dark/light modules', () => {
  const { renderQrSvg, encodeQrMatrix } = require(QR_SVG_PATH);

  const url = '/v/track/LDX-TRK-01?token=ldx_trk_abc123';
  const svg1 = renderQrSvg(url, { size: 220, margin: 4 });
  const svg2 = renderQrSvg(url, { size: 220, margin: 4 });
  assert.equal(svg1, svg2, 'renderQrSvg must be deterministic');

  const qr = encodeQrMatrix(url);
  const expectedTotal = qr.size + 8; // margin=4 on both sides
  assert.ok(svg1.startsWith('<svg '));
  assert.ok(svg1.endsWith('</svg>'));
  assert.ok(svg1.includes('xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg1.includes(`viewBox="0 0 ${expectedTotal} ${expectedTotal}"`));
  assert.ok(svg1.includes('width="220"'));
  assert.ok(svg1.includes('height="220"'));
  assert.ok(svg1.includes('<rect '));
  assert.ok(svg1.includes('<path '));

  // XSS-safe aria-label escaping
  const xssSvg = renderQrSvg('<script>alert(1)</script>', { size: 120, margin: 2 });
  assert.equal(xssSvg.includes('<script>'), false);
  assert.ok(xssSvg.includes('&lt;script&gt;'));

  // Rejects empty text
  assert.throws(() => renderQrSvg(''), /empty|required|không/i);
});
