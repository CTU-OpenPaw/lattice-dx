/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
function filterPage(items,columns,query,page,pageSize) {
  const normalized = value => String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').toLowerCase();
  const needle=normalized(query).trim();
  const filtered=items.filter(row=>!needle||columns.some(column=>normalized(row[column]).includes(needle)));
  const totalPages=Math.max(1,Math.ceil(filtered.length/pageSize));
  const current=Math.max(1,Math.min(page,totalPages));
  return {items:filtered.slice((current-1)*pageSize,current*pageSize),total:filtered.length,totalPages,page:current};
}
module.exports={filterPage};
