import {expect,test} from 'vitest';
import {parseRuntimeConfig} from './runtime-config.js';

const flags=['ENTITY_AUTOMATION_WORKER','WORKFLOW_TIMER_WORKER','WORKFLOW_WAIT_TIMEOUT_WORKER','WORKFLOW_OUTBOX_WORKER','FILE_STORAGE_WORKER'] as const;
const enabled={DATABASE_URL:'postgres://localhost/test',FILE_STORAGE_PROVIDER:'filesystem',FILE_STORAGE_ROOT:process.cwd(),WORKFLOW_EVENT_URL:'https://example.com/events',WORKFLOW_EVENT_TOKEN:'secret'};
test('outbox routing scope requires both event type and an exact UTC cutoff',()=>{
 const scope={WORKFLOW_OUTBOX_EVENT_TYPE:'asset.handed_over',WORKFLOW_OUTBOX_CREATED_AFTER:'2026-10-21T00:00:00.000Z',WORKFLOW_OUTBOX_ORGANIZATION_ID:'org-a'};
 expect(parseRuntimeConfig({...enabled,...scope}).connector?.selection).toEqual({eventType:scope.WORKFLOW_OUTBOX_EVENT_TYPE,createdAfter:scope.WORKFLOW_OUTBOX_CREATED_AFTER,organizationId:'org-a'});
 for(const patch of [{WORKFLOW_OUTBOX_EVENT_TYPE:'asset.handed_over'},{WORKFLOW_OUTBOX_CREATED_AFTER:scope.WORKFLOW_OUTBOX_CREATED_AFTER},{...scope,WORKFLOW_OUTBOX_CREATED_AFTER:'bad'},{...scope,WORKFLOW_OUTBOX_EVENT_TYPE:'bad sql;'}])expect(()=>parseRuntimeConfig({...enabled,...patch})).toThrow();
 expect(parseRuntimeConfig({...enabled,WORKFLOW_OUTBOX_EVENT_TYPE:'',WORKFLOW_OUTBOX_CREATED_AFTER:''}).connector?.selection).toBeUndefined();
});
test('all workers require explicit true',()=>{
 expect(Object.values(parseRuntimeConfig({}).workers)).toEqual([false,false,false,false,false]);
 for(const flag of flags){expect(Object.values(parseRuntimeConfig({...enabled,[flag]:'false'}).workers).every(v=>!v)).toBe(true);expect(Object.values(parseRuntimeConfig({...enabled,[flag]:'true'}).workers).filter(Boolean)).toHaveLength(1);}
});
test('core compose empty connector defaults are unconfigured and cannot enable outbox',()=>{
 const compose={DATABASE_URL:'postgresql://engine:secret@engine-postgres:5432/engine',API_HOST:'0.0.0.0',API_PORT:'4000',WORKER_URL:'http://agent-worker:4001',CLAMD_HOST:'clamav',CLAMD_PORT:'3310',FILE_STORAGE_PROVIDER:'postgres',FILE_STORAGE_ROOT:process.cwd(),WORKFLOW_EVENT_URL:'',WORKFLOW_EVENT_TOKEN:'',...Object.fromEntries(flags.map(flag=>[flag,'false']))};
 expect(parseRuntimeConfig(compose).connector).toBeUndefined();
 expect(()=>parseRuntimeConfig({...compose,WORKFLOW_OUTBOX_WORKER:'true'})).toThrow();
 expect(()=>parseRuntimeConfig({...compose,WORKFLOW_EVENT_URL:'https://example.com'})).toThrow();
});
test('every invalid boolean and missing database is rejected',()=>{
 for(const flag of flags){for(const value of ['','yes','TRUE','1',' true'])expect(()=>parseRuntimeConfig({...enabled,[flag]:value})).toThrow();expect(()=>parseRuntimeConfig({[flag]:'true'})).toThrow();}
});
test('validates storage prerequisites and canonical root without IO',()=>{
 expect(parseRuntimeConfig({FILE_STORAGE_ROOT:process.cwd()}).storage.provider).toBe('postgres');
 for(const env of [{FILE_STORAGE_PROVIDER:'s3'},{FILE_STORAGE_PROVIDER:'filesystem'},{FILE_STORAGE_ROOT:'relative'}, {...enabled,FILE_STORAGE_WORKER:'true',FILE_STORAGE_PROVIDER:'postgres'}])expect(()=>parseRuntimeConfig(env)).toThrow();
});
test('validates all URLs identity pairs connectors and ports with sanitized errors',()=>{
 for(const env of [{DATABASE_URL:'bad-secret'}, {WORKER_URL:'file:///secret'}, {OIDC_ISSUER:'https://example.com'}, {OIDC_JWKS_URL:'https://example.com'}, {OIDC_ISSUER:'bad',OIDC_JWKS_URL:'https://example.com'}, {WORKFLOW_EVENT_URL:'file:///secret',WORKFLOW_EVENT_TOKEN:'secret'}, {WORKFLOW_EVENT_URL:'https://example.com',WORKFLOW_EVENT_TOKEN:'  '}, {WORKFLOW_EVENT_TOKEN:'secret'}, {API_PORT:'0'},{API_PORT:'65536'},{API_PORT:'4e3'},{CLAMD_PORT:'NaN'}, {CLAMD_HOST:' '}]){
  expect(()=>parseRuntimeConfig(env)).toThrow();try{parseRuntimeConfig(env);}catch(error){expect(String(error)).not.toContain('secret');}
 }
 expect(parseRuntimeConfig({API_PORT:'65535',CLAMD_PORT:'1'}).port).toBe(65535);
});
