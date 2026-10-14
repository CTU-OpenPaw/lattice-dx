// SPDX-License-Identifier: Apache-2.0
import {test,expect} from 'vitest';
import {mkdtemp,writeFile,symlink,mkdir,readFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createFilesystemStore} from './filesystem-store.js';
async function fixture(){const base=join(process.cwd(),'output');await mkdir(base,{recursive:true});return mkdtemp(join(base,'dx-store-'));}

test('immutable bounded objects verify size, digest, and key grammar',async()=>{
 const root=await fixture();
 const store=await createFilesystemStore(root);
 const bytes=Buffer.from('verified');const object=await store.writeVerified(bytes);
 expect(await store.readVerified({provider:'filesystem',...object})).toEqual(bytes);
 for(const objectKey of ['../escape','/absolute',object.objectKey.toUpperCase()])
  await expect(store.readVerified({provider:'filesystem',...object,objectKey})).rejects.toThrow();
 await expect(store.readVerified({provider:'filesystem',...object,size:1})).rejects.toThrow();
 await expect(store.readVerified({provider:'filesystem',...object,sha256:'0'.repeat(64)})).rejects.toThrow();
 await expect(store.writeVerified(Buffer.alloc(1048577))).rejects.toThrow();
 await writeFile(join(root,object.objectKey),'corrupt');
 await expect(store.readVerified({provider:'filesystem',...object})).rejects.toThrow();
});
test('rejects relative roots, directories as objects and symlink roots',async()=>{
 await expect(createFilesystemStore('.')).rejects.toThrow();
 const root=await fixture();
 const store=await createFilesystemStore(root);const key='12345678-1234-4234-8234-123456789abc';
 await mkdir(join(root,key));
 await expect(store.readVerified({provider:'filesystem',objectKey:key,size:0,sha256:'0'.repeat(64)})).rejects.toThrow();
 await symlink(root,join(root,'link'),'junction');
 await expect(createFilesystemStore(join(root,'link'))).rejects.toThrow();
});
test('exclusive collision retains original and failed writes retain unpublished objects',async()=>{
 const root=await fixture();const objectKey='12345678-1234-4234-8234-123456789abc';
 const store=await createFilesystemStore(root,{objectKey:()=>objectKey});
 await store.writeVerified(Buffer.from('original'));
 await expect(store.writeVerified(Buffer.from('replacement'))).rejects.toThrow();
 expect(await readFile(join(root,objectKey),'utf8')).toBe('original');
 const failedRoot=await fixture();
 const failed=await createFilesystemStore(failedRoot,{objectKey:()=>objectKey,write:async(handle)=>{await handle.writeFile(Buffer.from('partial'));throw new Error('injected failure');}});
 await expect(failed.writeVerified(Buffer.from('complete'))).rejects.toThrow('injected failure');
 expect(await readFile(join(failedRoot,objectKey),'utf8')).toBe('partial');
 const unverifiedRoot=await fixture();
 const unverified=await createFilesystemStore(unverifiedRoot,{objectKey:()=>objectKey,write:async(handle)=>{await handle.writeFile(Buffer.from('wrong'));}});
 await expect(unverified.writeVerified(Buffer.from('right'))).rejects.toThrow();
 expect(await readFile(join(unverifiedRoot,objectKey),'utf8')).toBe('wrong');
});
test('empty and maximum-size bytes verify; changed root and object symlinks fail closed',async()=>{
 const root=await fixture();const store=await createFilesystemStore(root);
 for(const bytes of [Buffer.alloc(0),Buffer.alloc(1048576,7)]){
  const object=await store.writeVerified(bytes);expect(await store.readVerified({provider:'filesystem',...object})).toEqual(bytes);
 }
 const object=await store.writeVerified(Buffer.from('original'));
 await rename(join(root,object.objectKey),join(root,'retained-original'));
 await symlink(join(root,'retained-original'),join(root,object.objectKey),'file');
 await expect(store.readVerified({provider:'filesystem',...object})).rejects.toThrow();
 await rename(root,root+'-retained');await mkdir(root);
 await expect(store.writeVerified(Buffer.from('new'))).rejects.toThrow('root changed');
});
