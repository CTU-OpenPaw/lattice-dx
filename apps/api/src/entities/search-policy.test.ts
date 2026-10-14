// SPDX-License-Identifier: Apache-2.0
import {expect,test} from 'vitest';
import {parseEntitySearch} from './search-policy.js';
test('normalizes bounded plain text and paired schema pins',()=>{
 expect(parseEntitySearch({q:'  invoice ',limit:100,offset:10000})).toEqual({q:'invoice',limit:100,offset:10000});
 expect(parseEntitySearch({q:'x | y'})).toEqual({q:'x | y',limit:50,offset:0});
 expect(parseEntitySearch({q:'😀'.repeat(200),schemaId:'invoice',schemaVersion:2147483647}).q).toHaveLength(400);
});
test('rejects malformed, control, oversized and extended search inputs',()=>{
 for(const input of [null,[],{q:''},{q:'  '},{q:'a',schemaId:'invoice'},{q:'a',schemaVersion:1},{q:'a',rawSql:'1=1'},
 {q:'a',schemaId:'Bad',schemaVersion:1},{q:'a',schemaId:'invoice',schemaVersion:2147483648},
 ...['\0','\n','\t','\u007f','\u0085'].map(control=>({q:`a${control}b`})),
 {q:'a'.repeat(201)},{q:'😀'.repeat(201)},{q:'a'.repeat(4097)},
 ...[0,-1,1.5,101,'50',null].map(limit=>({q:'a',limit})),
 ...[-1,1.5,10001,'0',null].map(offset=>({q:'a',offset}))]) expect(()=>parseEntitySearch(input)).toThrow();
});
