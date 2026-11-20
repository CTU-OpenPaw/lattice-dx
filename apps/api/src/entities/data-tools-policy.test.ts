/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, test } from 'vitest';
import { prepareImport, exportContent, parseImportInput } from './data-tools-policy.js';
import type { SchemaPublication } from './types.js';
const schema:SchemaPublication={id:'invoice',version:1,title:'Invoice',fields:{label:{type:'text'},count:{type:'integer'},enabled:{type:'boolean'},amount:{type:'decimal'},day:{type:'date'},state:{type:'enum',choices:['A','B']}},relations:{}};
const input=(content:string,format:'csv'|'json'='csv')=>({schemaId:'invoice',schemaVersion:1,format,content});
test('bounded RFC CSV preserves quotes and typed exact scalar values',()=>{
 const result=prepareImport(schema,input('title,label,count,enabled,amount,day,state\r\n"A, B","line\n""quoted""",-2,false,0.0100,2026-10-14,A\r\n'));
 expect(result.valid).toBe(true);expect(result.rows[0]).toEqual({title:'A, B',attributes:{label:'line\n"quoted"',count:-2,enabled:false,amount:'0.0100',day:'2026-10-14',state:'A'}});expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
});
test.each(['title,title\na,b','title,__proto__\na,b','title,unknown\na,b','title,label\na,"bad','title,label\na,"ok"tail'])('malformed/duplicate/unsafe CSV rejects',content=>{expect(()=>prepareImport(schema,input(content))).toThrow();});
test.each(['01','-0','9007199254740992','1.0'])('integer is canonical and safe (%s)',count=>{expect(prepareImport(schema,input(`title,count\na,${count}`))).toMatchObject({valid:false});});
test('optional blank omitted; required blank and unknown JSON attribute yield bounded no-digest errors',()=>{
 expect(prepareImport(schema,input('title,label\na,')).rows).toEqual([{title:'a',attributes:{}}]);
 const required={...schema,fields:{label:{type:'text' as const,required:true}}};expect(prepareImport(required,input('title,label\na,'))).toMatchObject({valid:false,errors:[{row:1,error:expect.any(String)}]});
 expect(prepareImport(schema,input('[{"title":"A","attributes":{"unknown":1}}]','json')).digest).toBeUndefined();
});
test('normalized JSON digest canonicalizes attributes and title but preserves row order and pin',()=>{
 const a=prepareImport(schema,input('[{"title":" A ","attributes":{"label":"x","count":1}}]','json'));
 const b=prepareImport(schema,input('[{"attributes":{"count":1,"label":"x"},"title":"A"}]','json'));
 expect(a.digest).toBe(b.digest);expect(prepareImport({...schema,version:2},{...input('[{"title":"A","attributes":{"count":1,"label":"x"}}]','json'),schemaVersion:2}).digest).not.toBe(a.digest);
});
test('content and rows are bounded and strict payload rejects identity overrides',()=>{
 expect(()=>parseImportInput({...input('[]','json'),ownerId:'bob'})).toThrow();expect(()=>parseImportInput(input('x'.repeat(262145),'json'))).toThrow();
 expect(()=>prepareImport(schema,input(JSON.stringify(Array.from({length:101},()=>({title:'A',attributes:{}}))),'json'))).toThrow();
});
test('CSV export protects formula text including whitespace, preserves negative numerics and JSON exactness',()=>{
 const rows=[{title:' =SUM(1)',attributes:{label:'@evil',count:-2,amount:'-0.0100'}}];
 expect(exportContent(schema,rows,'csv')).toContain("' =SUM(1)");expect(exportContent(schema,rows,'csv')).toContain("'@evil,-2,,-0.0100");expect(JSON.parse(exportContent(schema,rows,'json'))).toEqual(rows);
});
