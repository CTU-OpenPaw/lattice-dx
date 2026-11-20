/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, test } from 'vitest';
import type { Pool } from 'pg';
import { organizationDatabase } from './database.js';
const actor={
  subject:'alice',organizationId:'org',roles:['directory:manage']
};
test('foreign parent is hidden with 404 rather than accepted in tenant hierarchy',async()=>{
  const client={
    async query(sql:string){
      return {
        rows:sql.includes('organization_id<>$1')?[{
          id:'foreign'
        }
        ]:[]
      };
    },release(){
    }
  };
  const pool={
    async query(){
      return {
        rows:[]
      };
    },async connect(){
      return client;
    }
  } as unknown as Pool;
  const repo=await organizationDatabase(pool);
  await expect(repo.createDepartment(actor,{
    id:'child',name:'Child',parentId:'foreign',managerId:null
  },'foreign')).rejects.toMatchObject({
    statusCode:404
  });
});
test('snapshot locks organization before directory writes and commits receipt audit and revision on same client',async()=>{
  const statements:string[]=[];
  const client={
    async query(sql:string){
      statements.push(sql);
      return {
        rows:sql.includes('SELECT revision')?[{
          revision:0,updatedAt:null
        }
        ]:sql.includes('RETURNING revision')?[{
          revision:1,updatedAt:new Date(0)
        }
        ]:[],rowCount:sql.includes('UPDATE directory_people')?2:0
      };
    },release(){
      statements.push('release');
    }
  };
  const pool={
    async query(){
      return {
        rows:[]
      };
    },async connect(){
      return client;
    }
  } as unknown as Pool;
  const repo=await organizationDatabase(pool);
  expect(await repo.replaceSnapshot(actor,{
    expectedRevision:0,people:[]
  },'key')).toMatchObject({
    revision:1,changeCount:2
  });
  expect(statements.indexOf('BEGIN')).toBeLessThan(statements.findIndex(s=>s.includes('pg_advisory_xact_lock')));
  expect(statements.findIndex(s=>s.includes('pg_advisory_xact_lock'))).toBeLessThan(statements.findIndex(s=>s.includes('UPDATE directory_people')));
  const directoryGate=statements.indexOf('LOCK TABLE directory_people IN EXCLUSIVE MODE');
  expect(directoryGate).toBeGreaterThan(statements.indexOf('BEGIN'));
  expect(directoryGate).toBeLessThan(statements.findIndex(s=>s.includes('SELECT revision')));
  expect(statements.some(s=>s.includes('INSERT INTO organization_snapshot_audit'))).toBe(true);
  expect(statements.at(-2)).toBe('COMMIT');
});
test('repository rejects current management role before reading stored receipt',async()=>{
  let connected=false;
  const pool={
    async query(){
      return {
        rows:[]
      };
    },async connect(){
      connected=true;
      throw Error('unexpected');
    }
  } as unknown as Pool;
  const repo=await organizationDatabase(pool);
  await expect(repo.replaceSnapshot({
    ...actor,roles:[]
  },{
    expectedRevision:0,people:[]
  },'key')).rejects.toMatchObject({
    statusCode:403
  });
  expect(connected).toBe(false);
});
test('cycle and subtree depth validation roll back before department mutation',async()=>{
  for (const hierarchy of [[{
    id:'a',parentId:null
  },{
    id:'b',parentId:'a'
  }
  ],Array.from({
    length:20
  },(_,i)=>({
    id:`d${i}`,parentId:i?`d${i-1}`:null
  }))]){
    const statements:string[]=[];
    const client={
      async query(sql:string){
        statements.push(sql);
        return {
          rows:sql.startsWith('SELECT version')?[{
            version:1
          }
          ]:sql.startsWith('SELECT id,parent_id')?hierarchy:[]
        };
      },release(){
      }
    };
    const pool={
      async query(){
        return {
          rows:[]
        };
      },async connect(){
        return client;
      }
    } as unknown as Pool;
    const repo=await organizationDatabase(pool);
    const cycle=hierarchy.length===2;
    await expect(cycle?repo.updateDepartment(actor,'a',{
      expectedVersion:1,name:'A',parentId:'b',managerId:null
    },'cycle'):repo.createDepartment(actor,{
      id:'deep',name:'Deep',parentId:'d19',managerId:null
    },'deep')).rejects.toMatchObject({
      statusCode:409
    });
    expect(statements).toContain('ROLLBACK');
    expect(statements.some(s=>s.startsWith('UPDATE organization_departments')||s.startsWith('INSERT INTO organization_departments'))).toBe(false);
  }
});
test('manager must be current tenant enabled and stale version cannot mutate',async()=>{
  const statements:string[]=[];
  const client={
    async query(sql:string){
      statements.push(sql);
      return {
        rows:sql.startsWith('SELECT version')?[{
          version:2
        }
        ]:[]
      };
    },release(){
    }
  };
  const pool={
    async query(){
      return {
        rows:[]
      };
    },async connect(){
      return client;
    }
  } as unknown as Pool;
  const repo=await organizationDatabase(pool);
  await expect(repo.createDepartment(actor,{
    id:'a',name:'A',parentId:null,managerId:'foreign'
  },'manager')).rejects.toMatchObject({
    statusCode:400
  });
  expect(statements.find(s=>s.includes('SELECT subject'))).toContain('organization_id=$1 AND subject=$2 AND enabled=true FOR SHARE');
  await expect(repo.updateDepartment(actor,'a',{
    expectedVersion:1,name:'A',parentId:null,managerId:null
  },'stale')).rejects.toMatchObject({
    statusCode:409
  });
});
test('canonical snapshot replay is scoped and immutable and conflicting keys roll back',async()=>{
  let receipt:any;
  let writes=0;
  const statements:string[]=[];
  const client={
    async query(sql:string,params:unknown[]=[]){
      statements.push(sql);
      if (sql.startsWith('SELECT fingerprint'))return {
        rows:receipt?[receipt]:[]
      };
      if (sql.startsWith('INSERT INTO organization_commands'))receipt={
        fingerprint:params[4],result:JSON.parse(params[5] as string)
      };
      if (sql.startsWith('UPDATE organization_directory_state')){
        writes++;
        return {
          rows:[{
            revision:1,updatedAt:new Date(0)
          }
          ]
        };
      }
      return {
        rows:sql.startsWith('SELECT revision')?[{
          revision:0
        }
        ]:[],rowCount:0
      };
    },release(){
    }
  };
  const pool={
    async query(){
      return {
        rows:[]
      };
    },async connect(){
      return client;
    }
  } as unknown as Pool;
  const repo=await organizationDatabase(pool);
  const person={
    subject:'alice',displayName:'Alice',enabled:true,roles:['b','a']
  };
  const input={
    expectedRevision:0,people:[person]
  };
  const first=await repo.replaceSnapshot(actor,input,'replay');
  expect(await repo.replaceSnapshot(actor,{
    ...input,people:[{
      ...person,roles:['a','b']
    }
    ]
  },'replay')).toEqual(first);
  expect(writes).toBe(1);
  await expect(repo.replaceSnapshot(actor,{
    ...input,people:[]
  },'replay')).rejects.toMatchObject({
    statusCode:409
  });
  expect(statements.at(-1)).toBe('ROLLBACK');
});
test('receipt insertion failure rolls back revision and audit transaction',async()=>{
  const statements:string[]=[];
  const client={
    async query(sql:string){
      statements.push(sql);
      if (sql.startsWith('INSERT INTO organization_commands'))throw Error('forced receipt failure');
      return {
        rows:sql.startsWith('SELECT revision')?[{
          revision:0
        }
        ]:sql.includes('RETURNING revision')?[{
          revision:1,updatedAt:new Date(0)
        }
        ]:[],rowCount:0
      };
    },release(){
    }
  };
  const pool={
    async query(){
      return {
        rows:[]
      };
    },async connect(){
      return client;
    }
  } as unknown as Pool;
  const repo=await organizationDatabase(pool);
  await expect(repo.replaceSnapshot(actor,{
    expectedRevision:0,people:[]
  },'rollback')).rejects.toThrow('forced receipt');
  expect(statements.at(-1)).toBe('ROLLBACK');
  expect(statements).not.toContain('COMMIT');
});
