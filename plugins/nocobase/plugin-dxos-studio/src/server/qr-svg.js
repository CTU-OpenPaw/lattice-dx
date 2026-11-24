/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

// ISO/IEC 18004 Pure-JS QR Code Encoder & SVG Renderer (Versions 1-12, Byte mode)

const ECC_INDICATOR = Object.freeze({
  L: 0b01,
  M: 0b00,
  Q: 0b11,
  H: 0b10,
});

const ALIGNMENT_POSITIONS = Object.freeze({
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
});

const REMAINDER_BITS = Object.freeze({
  1: 0,
  2: 7,
  3: 7,
  4: 7,
  5: 7,
  6: 7,
  7: 0,
  8: 0,
  9: 0,
  10: 0,
  11: 0,
  12: 0,
});

// [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data]
const EC_TABLE = Object.freeze({
  1: { L: [7, 1, 19, 0, 0], M: [10, 1, 16, 0, 0], Q: [13, 1, 13, 0, 0], H: [17, 1, 9, 0, 0] },
  2: { L: [10, 1, 34, 0, 0], M: [16, 1, 28, 0, 0], Q: [22, 1, 22, 0, 0], H: [28, 1, 16, 0, 0] },
  3: { L: [15, 1, 55, 0, 0], M: [26, 1, 44, 0, 0], Q: [18, 2, 17, 0, 0], H: [22, 2, 13, 0, 0] },
  4: { L: [20, 1, 80, 0, 0], M: [18, 2, 32, 0, 0], Q: [26, 2, 24, 0, 0], H: [16, 4, 9, 0, 0] },
  5: { L: [26, 1, 108, 0, 0], M: [24, 2, 43, 0, 0], Q: [18, 2, 15, 2, 16], H: [22, 2, 11, 2, 12] },
  6: { L: [18, 2, 68, 0, 0], M: [16, 4, 27, 0, 0], Q: [24, 4, 19, 0, 0], H: [28, 4, 15, 0, 0] },
  7: { L: [20, 2, 78, 0, 0], M: [18, 4, 31, 0, 0], Q: [18, 2, 14, 4, 15], H: [26, 4, 13, 1, 14] },
  8: { L: [24, 2, 97, 0, 0], M: [22, 2, 38, 2, 39], Q: [22, 4, 18, 2, 19], H: [26, 4, 14, 2, 15] },
  9: { L: [30, 2, 116, 0, 0], M: [22, 3, 36, 2, 37], Q: [20, 4, 16, 4, 17], H: [24, 4, 12, 4, 13] },
  10: { L: [18, 2, 68, 2, 69], M: [26, 4, 43, 1, 44], Q: [24, 6, 19, 2, 20], H: [28, 6, 15, 2, 16] },
  11: { L: [20, 4, 81, 0, 0], M: [30, 1, 50, 4, 51], Q: [28, 4, 22, 4, 23], H: [24, 3, 12, 8, 13] },
  12: { L: [24, 2, 92, 2, 93], M: [22, 6, 36, 2, 37], Q: [26, 4, 20, 6, 21], H: [28, 7, 14, 4, 15] },
});

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function buildRsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function computeRsEcc(dataBytes, ecCount) {
  const gen = buildRsGeneratorPoly(ecCount);
  const rem = new Uint8Array(ecCount);
  for (let i = 0; i < dataBytes.length; i += 1) {
    const factor = dataBytes[i] ^ rem[0];
    for (let j = 0; j < ecCount - 1; j += 1) {
      rem[j] = rem[j + 1] ^ gfMul(gen[j + 1], factor);
    }
    rem[ecCount - 1] = gfMul(gen[ecCount], factor);
  }
  return rem;
}

function getVersionEcSpec(version, eccLevel = 'M') {
  const level = String(eccLevel || 'M').toUpperCase();
  const row = EC_TABLE[version]?.[level];
  if (!row) {
    throw new RangeError(`Unsupported QR version (${version}) or ECC level (${level})`);
  }
  const [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = row;
  return {
    version,
    eccLevel: level,
    ecPerBlock,
    g1Blocks,
    g1Data,
    g2Blocks,
    g2Data,
    totalDataCodewords: g1Blocks * g1Data + g2Blocks * g2Data,
  };
}

function selectVersionForBytes(byteLength, eccLevel) {
  for (let v = 1; v <= 12; v += 1) {
    const spec = getVersionEcSpec(v, eccLevel);
    const headerBits = 4 + (v <= 9 ? 8 : 16);
    const maxBytes = Math.floor((spec.totalDataCodewords * 8 - headerBits) / 8);
    if (byteLength <= maxBytes) return spec;
  }
  throw new RangeError(`QR payload exceeds Version 12 (${eccLevel}) capacity (${byteLength} bytes)`);
}

function utf8Bytes(text) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text);
  }
  return Uint8Array.from(Buffer.from(text, 'utf8'));
}

function buildDataCodewords(bytes, spec) {
  const bits = [];
  const pushBits = (val, count) => {
    for (let i = count - 1; i >= 0; i -= 1) {
      bits.push((val >> i) & 1);
    }
  };

  // Byte mode indicator (0100) + character count
  pushBits(0b0100, 4);
  pushBits(bytes.length, spec.version <= 9 ? 8 : 16);
  for (let i = 0; i < bytes.length; i += 1) {
    pushBits(bytes[i], 8);
  }

  const totalDataBits = spec.totalDataCodewords * 8;
  const terminatorLen = Math.min(4, totalDataBits - bits.length);
  pushBits(0, terminatorLen);
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j += 1) b = (b << 1) | bits[i + j];
    codewords.push(b);
  }

  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (codewords.length < spec.totalDataCodewords) {
    codewords.push(padBytes[padIdx % 2]);
    padIdx += 1;
  }
  return codewords;
}

function interleaveBlocks(dataCodewords, spec) {
  const blocks = [];
  let offset = 0;
  for (let b = 0; b < spec.g1Blocks; b += 1) {
    const slice = dataCodewords.slice(offset, offset + spec.g1Data);
    offset += spec.g1Data;
    blocks.push({ data: slice, ecc: computeRsEcc(slice, spec.ecPerBlock) });
  }
  for (let b = 0; b < spec.g2Blocks; b += 1) {
    const slice = dataCodewords.slice(offset, offset + spec.g2Data);
    offset += spec.g2Data;
    blocks.push({ data: slice, ecc: computeRsEcc(slice, spec.ecPerBlock) });
  }

  const out = [];
  const maxData = Math.max(spec.g1Data, spec.g2Data);
  for (let col = 0; col < maxData; col += 1) {
    for (const blk of blocks) {
      if (col < blk.data.length) out.push(blk.data[col]);
    }
  }
  for (let col = 0; col < spec.ecPerBlock; col += 1) {
    for (const blk of blocks) {
      out.push(blk.ecc[col]);
    }
  }
  return out;
}

function encodeBch15(data5) {
  let d = data5 << 10;
  const poly = 0x537;
  for (let bit = 14; bit >= 10; bit -= 1) {
    if ((d >> bit) & 1) d ^= poly << (bit - 10);
  }
  return ((data5 << 10) | d) ^ 0x5412;
}

function encodeBch18(version6) {
  let d = version6 << 12;
  const poly = 0x1f25;
  for (let bit = 17; bit >= 12; bit -= 1) {
    if ((d >> bit) & 1) d ^= poly << (bit - 12);
  }
  return (version6 << 12) | d;
}

function createEmptyGrid(size, fill = 0) {
  return Array.from({ length: size }, () => new Array(size).fill(fill));
}

function placeFunctionPatterns(version) {
  const size = 17 + 4 * version;
  const grid = createEmptyGrid(size, 0);
  const isFn = createEmptyGrid(size, false);

  const setFn = (r, c, val) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      grid[r][c] = val ? 1 : 0;
      isFn[r][c] = true;
    }
  };

  // Finder pattern (7x7) + 1-module light separator
  const drawFinder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        if (dr === -1 || dr === 7 || dc === -1 || dc === 7) {
          setFn(r, c, 0);
        } else {
          const isOuter = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          const isInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          setFn(r, c, isOuter || isInner ? 1 : 0);
        }
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i += 1) {
    const bit = i % 2 === 0 ? 1 : 0;
    setFn(6, i, bit);
    setFn(i, 6, bit);
  }

  // Alignment patterns (5x5)
  const coords = ALIGNMENT_POSITIONS[version] || [];
  for (const rCenter of coords) {
    for (const cCenter of coords) {
      const overlapsFinder =
        (rCenter <= 8 && cCenter <= 8) ||
        (rCenter <= 8 && cCenter >= size - 9) ||
        (rCenter >= size - 9 && cCenter <= 8);
      if (overlapsFinder) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFn(rCenter + dr, cCenter + dc, dark ? 1 : 0);
        }
      }
    }
  }

  // Reserve Format Information slots
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      setFn(8, i, 0);
      setFn(i, 8, 0);
    }
  }
  for (let i = size - 8; i < size; i += 1) {
    setFn(8, i, 0);
  }
  for (let i = size - 7; i < size; i += 1) {
    setFn(i, 8, 0);
  }

  // Dark module at (4*version + 9, 8)
  setFn(4 * version + 9, 8, 1);

  // Version Information (6x3 and 3x6) for Version >= 7
  if (version >= 7) {
    const vBits = encodeBch18(version);
    for (let k = 0; k < 18; k += 1) {
      const bit = (vBits >> k) & 1;
      const a = Math.floor(k / 3);
      const b = size - 11 + (k % 3);
      setFn(a, b, bit);
      setFn(b, a, bit);
    }
  }

  return { size, grid, isFn };
}

function writeFormatInfo(grid, size, eccLevel, maskId) {
  const data5 = (ECC_INDICATOR[eccLevel] << 3) | maskId;
  const fmtBits = encodeBch15(data5);

  const primary = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  const secondary = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ];

  for (let i = 0; i < 15; i += 1) {
    const bit = (fmtBits >> (14 - i)) & 1;
    const [r1, c1] = primary[i];
    const [r2, c2] = secondary[i];
    grid[r1][c1] = bit;
    grid[r2][c2] = bit;
  }
}

function maskCondition(maskId, r, c) {
  switch (maskId) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

function placeDataBits(grid, isFn, size, allCodewords, remainderCount) {
  const bits = [];
  for (let i = 0; i < allCodewords.length; i += 1) {
    const byte = allCodewords[i];
    for (let b = 7; b >= 0; b -= 1) bits.push((byte >> b) & 1);
  }
  for (let r = 0; r < remainderCount; r += 1) bits.push(0);

  let bitIdx = 0;
  let col = size - 1;
  let upward = true;
  while (col > 0) {
    if (col === 6) col -= 1;
    for (let step = 0; step < size; step += 1) {
      const r = upward ? size - 1 - step : step;
      for (const c of [col, col - 1]) {
        if (!isFn[r][c]) {
          grid[r][c] = bitIdx < bits.length ? bits[bitIdx++] : 0;
        }
      }
    }
    col -= 2;
    upward = !upward;
  }
}

function computePenalty(grid, size) {
  let penalty = 0;

  // N1: 5+ consecutive same-color modules in row or column
  const scoreRuns = (getBit) => {
    let p = 0;
    for (let i = 0; i < size; i += 1) {
      let runVal = getBit(i, 0);
      let runLen = 1;
      for (let j = 1; j < size; j += 1) {
        const cur = getBit(i, j);
        if (cur === runVal) {
          runLen += 1;
        } else {
          if (runLen >= 5) p += 3 + (runLen - 5);
          runVal = cur;
          runLen = 1;
        }
      }
      if (runLen >= 5) p += 3 + (runLen - 5);
    }
    return p;
  };
  penalty += scoreRuns((r, c) => grid[r][c]);
  penalty += scoreRuns((c, r) => grid[r][c]);

  // N2: 2x2 same-color blocks
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) {
        penalty += 3;
      }
    }
  }

  // N3: 1:1:3:1:1 finder-like pattern preceded or followed by 4 light modules
  const countFinderLike = (getBit) => {
    let p = 0;
    for (let i = 0; i < size; i += 1) {
      for (let j = 0; j <= size - 11; j += 1) {
        const b0 = getBit(i, j);
        const b1 = getBit(i, j + 1);
        const b2 = getBit(i, j + 2);
        const b3 = getBit(i, j + 3);
        const b4 = getBit(i, j + 4);
        const b5 = getBit(i, j + 5);
        const b6 = getBit(i, j + 6);
        const b7 = getBit(i, j + 7);
        const b8 = getBit(i, j + 8);
        const b9 = getBit(i, j + 9);
        const b10 = getBit(i, j + 10);
        // 1,0,1,1,1,0,1,0,0,0,0 OR 0,0,0,0,1,0,1,1,1,0,1
        if (
          (b0 === 1 && b1 === 0 && b2 === 1 && b3 === 1 && b4 === 1 && b5 === 0 && b6 === 1 && b7 === 0 && b8 === 0 && b9 === 0 && b10 === 0) ||
          (b0 === 0 && b1 === 0 && b2 === 0 && b3 === 0 && b4 === 1 && b5 === 0 && b6 === 1 && b7 === 1 && b8 === 1 && b9 === 0 && b10 === 1)
        ) {
          p += 40;
        }
      }
    }
    return p;
  };
  penalty += countFinderLike((r, c) => grid[r][c]);
  penalty += countFinderLike((c, r) => grid[r][c]);

  // N4: Dark module ratio deviation from 50%
  let darkCount = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (grid[r][c]) darkCount += 1;
    }
  }
  const pct = (darkCount * 100) / (size * size);
  const prev5 = Math.abs(Math.floor(pct / 5) * 5 - 50) / 5;
  const next5 = Math.abs(Math.ceil(pct / 5) * 5 - 50) / 5;
  penalty += Math.min(prev5, next5) * 10;

  return penalty;
}

function encodeQrMatrix(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new TypeError('QR text must be a non-empty string');
  }
  const eccLevel = String(options.eccLevel || 'M').toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(ECC_INDICATOR, eccLevel)) {
    throw new RangeError(`Unsupported ECC level: ${eccLevel}`);
  }

  const bytes = utf8Bytes(text);
  const spec = selectVersionForBytes(bytes.length, eccLevel);
  const dataCodewords = buildDataCodewords(bytes, spec);
  const allCodewords = interleaveBlocks(dataCodewords, spec);

  const { size, grid: baseGrid, isFn } = placeFunctionPatterns(spec.version);
  placeDataBits(baseGrid, isFn, size, allCodewords, REMAINDER_BITS[spec.version] || 0);

  let bestMask = 0;
  let bestPenalty = Infinity;
  let bestGrid = null;

  for (let maskId = 0; maskId < 8; maskId += 1) {
    const candidate = baseGrid.map((row) => row.slice());
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (!isFn[r][c] && maskCondition(maskId, r, c)) {
          candidate[r][c] ^= 1;
        }
      }
    }
    writeFormatInfo(candidate, size, eccLevel, maskId);
    const penalty = computePenalty(candidate, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = maskId;
      bestGrid = candidate;
    }
  }

  return {
    version: spec.version,
    size,
    eccLevel,
    maskPattern: bestMask,
    modules: bestGrid,
  };
}

function escapeXmlAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderQrSvg(text, options = {}) {
  const qr = encodeQrMatrix(text, options);
  const sizePx = Number.isFinite(Number(options.size)) && Number(options.size) > 0 ? Math.round(Number(options.size)) : 180;
  const margin = Number.isFinite(Number(options.margin)) && Number(options.margin) >= 0 ? Math.floor(Number(options.margin)) : 4;
  const darkColor = typeof options.darkColor === 'string' && options.darkColor.trim() ? options.darkColor.trim() : '#0f172a';
  const lightColor = typeof options.lightColor === 'string' && options.lightColor.trim() ? options.lightColor.trim() : '#ffffff';

  const total = qr.size + margin * 2;
  const pathParts = [];
  for (let r = 0; r < qr.size; r += 1) {
    let runStart = -1;
    for (let c = 0; c <= qr.size; c += 1) {
      const dark = c < qr.size && qr.modules[r][c] === 1;
      if (dark && runStart === -1) {
        runStart = c;
      } else if (!dark && runStart !== -1) {
        const len = c - runStart;
        pathParts.push(`M${runStart + margin} ${r + margin}h${len}v1h-${len}z`);
        runStart = -1;
      }
    }
  }

  const label = escapeXmlAttr(`QR Code: ${text}`);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${sizePx}" height="${sizePx}" shape-rendering="crispEdges" role="img" aria-label="${label}">`,
    `<rect width="${total}" height="${total}" fill="${escapeXmlAttr(lightColor)}"/>`,
    `<path d="${pathParts.join('')}" fill="${escapeXmlAttr(darkColor)}"/>`,
    '</svg>',
  ].join('');
}

module.exports = {
  ECC_INDICATOR,
  ALIGNMENT_POSITIONS,
  EC_TABLE,
  getVersionEcSpec,
  encodeQrMatrix,
  renderQrSvg,
};
