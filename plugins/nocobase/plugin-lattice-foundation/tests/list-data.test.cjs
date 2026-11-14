/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {filterPage}=require('../src/client/list-data');
test('client filtering preserves source rows and paginates/clamps only the loaded set',()=>{
  const rows=Array.from({length:100},(_,i)=>({id:String(i),title:i<11?'Đơn hàng '+i:'Khác '+i}));
  const page=filterPage(rows,['title'],'don hang',2,5);
  assert.equal(page.total,11);assert.equal(page.totalPages,3);assert.deepEqual(page.items.map(r=>r.id),['5','6','7','8','9']);
  assert.equal(filterPage(rows,['title'],'don hang',100,5).page,3);
  assert.equal(filterPage(rows,['title'],'missing',1,5).total,0);assert.equal(rows.length,100);
});
