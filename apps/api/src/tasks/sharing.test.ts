/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {expect,test,vi} from 'vitest';
import type {Pool} from 'pg';
import {foundationDatabase} from '../foundation-database.js';
import {recordDatabase} from '../database.js';
test('task evidence shares exclude cancelled while preserving other terminal states',async()=>{
 const sql:string[]=[];
 const query=async(s:string)=>{sql.push(s);return {rows:[]};};
 const release=vi.fn(),connect=vi.fn(async()=>({query,release}));
 const pool={query,connect} as unknown as Pool;
 const foundation=await foundationDatabase(pool),records=await recordDatabase(pool);
 await foundation.readTaskFile!('11111111-1111-4111-8111-111111111111',{subject:'bob',organizationId:'a'});
 await records.findReadable!('11111111-1111-4111-8111-111111111111','bob','a');
 await records.listPage!('bob','a',{limit:5,offset:0,q:''});
 const sharing=sql.filter(s=>s.includes('t.assignee_id='));expect(sharing).toHaveLength(3);
 for(const query of sharing)expect(query).toContain("t.status<>'cancelled'");
 expect(connect).toHaveBeenCalledTimes(1);expect(release).toHaveBeenCalledTimes(1);
 expect(sql).toContain('BEGIN');expect(sql).toContain('COMMIT');
});
