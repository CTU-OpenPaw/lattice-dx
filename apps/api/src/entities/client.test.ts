import { expect, test } from 'vitest';
import type { PoolClient } from 'pg';
import { createEntityAtPublication } from './client.js';
import { runEntityCommandInTransaction } from './commands.js';
const scope={actorId:'alice',organizationId:'org-a'};
test('caller client pinned create and command use no connection or transaction lifecycle',async()=>{
 const statements:string[]=[];
 const client={async query(sql:string,values:unknown[]=[]){statements.push(sql);if(sql.includes('FROM enterprise_schema_versions')){expect(values).toEqual(['org-a','invoice',1]);return {rows:[{definition:{id:'invoice',title:'Invoice',fields:{},relations:{}},version:1}]};}if(sql.startsWith('INSERT INTO enterprise_entities'))return {rows:[{id:values[0],organizationId:'org-a',ownerId:'alice',schemaId:'invoice',schemaVersion:1,title:'A',attributes:{},version:1,archivedAt:null,createdAt:new Date(),updatedAt:new Date()}]};return {rows:[]};}} as unknown as PoolClient;
 const result=await runEntityCommandInTransaction(client,scope,'batch','key',{value:1},async()=>{},db=>createEntityAtPublication(db,scope,{schemaId:'invoice',schemaVersion:1,title:'A',attributes:{}}));
 expect(result.schemaVersion).toBe(1);expect(statements.some(sql=>['BEGIN','COMMIT','ROLLBACK'].includes(sql))).toBe(false);expect(statements.filter(sql=>sql.startsWith('INSERT INTO enterprise_audit'))).toHaveLength(1);
});
