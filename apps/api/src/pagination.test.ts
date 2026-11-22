/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { test, expect } from 'vitest';
import { parsePage, pageResult } from './pagination';
test('bounded page navigation preserves extra row indication',()=>{
  expect(parsePage({})).toEqual({limit:50,offset:0,q:''});
  expect(pageResult([1,2,3],{limit:2,offset:4,q:''})).toEqual({items:[1,2],page:{limit:2,offset:4,hasMore:true,nextOffset:6}});
  expect(pageResult([1],{limit:2,offset:6,q:''}).page.nextOffset).toBeNull();
});
test.each([{limit:'0'},{limit:'101'},{offset:'-1'},{offset:'1e3'},{limit:['2']},{q:'a'.repeat(201)}])('rejects invalid page %j',query=>{
  expect(()=>parsePage(query)).toThrow();
});
