import {describe,it,expect,vi} from 'vitest';
import {loadFileContentWithClient,readFileMetadataWithClient} from './content.js';
const id='11111111-1111-4111-8111-111111111111';
const actor={subject:'reader',organizationId:'org',roles:['files:read','data:read']};
const pointer={id,filename:'safe',ownerId:'reader',organizationId:'org',size:1,scanStatus:'pending',storage_provider:'filesystem',object_key:id,content_sha256:'0'.repeat(64)};
function fixture(allowed:boolean,scan='pending',entity=false){const queries:string[]=[];const client={query:vi.fn(async(sql:string)=>{queries.push(sql);if(sql.includes('SELECT id,owner_id'))return {rows:allowed?[{id,owner_id:'reader'}]:[]};if(sql.includes('FROM workflow_runs')||sql.includes('FROM records'))return {rows:[]};if(sql.includes('FROM enterprise_entities'))return {rows:allowed?[{id,ownerId:'reader',organizationId:'org',archivedAt:null}]:[]};if(sql.includes('FROM enterprise_entity_attachments'))return {rows:allowed?[{file_id:id}]:[]};if(sql.includes('FROM foundation_files'))return {rows:allowed?[{...pointer,scanStatus:scan}]:[]};return {rows:[]};})};return {client:client as any,queries};}
describe('authorized file content',()=>{
 for(const kind of ['foundation','entity'])it(`${kind} denial never touches the store`,async()=>{const {client}=fixture(false);const readVerified=vi.fn();expect(await loadFileContentWithClient(client,actor,id,kind==='entity'?{kind:'entityAttachment',entityId:id}:{kind:'foundation'},{readVerified,writeVerified:vi.fn()})).toBeUndefined();expect(readVerified).not.toHaveBeenCalled();});
 for(const scan of ['pending','rejected'])it(`${scan} metadata stays byte free`,async()=>{const {client,queries}=fixture(true,scan);expect(await readFileMetadataWithClient(client,actor,id,{kind:'foundation'})).toMatchObject({scanStatus:scan});expect(queries.every(sql=>!sql.includes(',content'))).toBe(true);const readVerified=vi.fn();await expect(loadFileContentWithClient(client,actor,id,{kind:'foundation'},{readVerified,writeVerified:vi.fn()})).rejects.toMatchObject({statusCode:409});expect(readVerified).not.toHaveBeenCalled();});
});

// Distinct authority fixtures exercise the policy gates before pending/rejected content.
for(const path of ['task','workflow','entity'] as const)it(`${path} current authorization precedes scan and storage`,async()=>{
 const queries:string[]=[];const readVerified=vi.fn();
 const client={query:vi.fn(async(sql:string)=>{queries.push(sql);
  if(sql.startsWith('SELECT id,owner_id FROM foundation_files'))return {rows:[]};
  if(sql.startsWith('SELECT r.id,r.owner_id'))return {rows:[]};
  if(sql.includes('FROM records'))return {rows:path==='task'?[{id,task_id:id}]:[]};
  if(sql.includes('FROM enterprise_entities'))return {rows:[{id,ownerId:actor.subject,organizationId:'org',archivedAt:null}]};
  if(sql.includes('FROM enterprise_entity_attachments'))return {rows:[{file_id:id}]};
  if(sql.includes('FROM foundation_files'))return {rows:[pointer]};
  return {rows:[]};})} as any;
 const result=loadFileContentWithClient(client,actor,id,path==='entity'?{kind:'entityAttachment',entityId:id}:{kind:'foundation'},{readVerified,writeVerified:vi.fn()});
 if(path==='workflow')expect(await result).toBeUndefined();else await expect(result).rejects.toMatchObject({statusCode:409});
 expect(readVerified).not.toHaveBeenCalled();
 if(path==='task')expect(queries.find(sql=>sql.includes('FROM records'))).toContain("t.status<>'cancelled'");
 if(path==='entity')expect(queries.findIndex(sql=>sql.includes('FROM enterprise_entity_attachments'))).toBeLessThan(queries.findIndex(sql=>sql.includes('SELECT id,filename')));
});
