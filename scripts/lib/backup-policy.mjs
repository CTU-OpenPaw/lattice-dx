// SPDX-License-Identifier: Apache-2.0
import {createHash} from 'node:crypto';
import {resolve,relative,basename,isAbsolute,dirname} from 'node:path';
import {lstatSync,realpathSync} from 'node:fs';
export const maxBackupBytes=256*1024*1024;
export function assertRestoreTarget(name){
 if(typeof name!=='string'||!/^dx_restore_[a-f0-9]{32}$/.test(name))throw new Error('Only a generated recovery fixture database is allowed.');
 return name;
}
export function assertBackupPath(file,root){
 const path=resolve(file),within=relative(resolve(root),path);
 if(within.startsWith('..')||isAbsolute(within)||dirname(path)!==resolve(root)||!/^core-[a-f0-9]{32}\.dump$/.test(basename(path)))throw new Error('Backup must be an approved artifact inside output/backups.');
 return path;
}
export function assertRegularBackup(file,root){
 const path=assertBackupPath(file,root),stat=lstatSync(path);
 if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Backup must be a regular file.');
 const normalize=value=>process.platform==='win32'?value.toLowerCase():value;
 if(normalize(realpathSync(root))!==normalize(resolve(root))||normalize(realpathSync(path))!==normalize(path))throw new Error('Backup path links are not allowed.');
 if(stat.size>maxBackupBytes)throw new Error('Backup exceeds 256 MiB.');
 return path;
}
export function verifyBackup(bytes,manifest){
 if(manifest?.format!=='latticedx.pg-backup'||manifest.version!==1||typeof manifest.sha256!=='string'||!/^[a-f0-9]{64}$/.test(manifest.sha256))throw new Error('Unsupported backup manifest.');
 if(!Number.isSafeInteger(manifest.bytes)||manifest.bytes<1||manifest.bytes>maxBackupBytes||manifest.bytes!==bytes.length)throw new Error('Backup byte length invalid.');
 if(createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)throw new Error('Backup checksum mismatch.');
}
export function runRestoreFixture(database,create,work,drop){
 assertRestoreTarget(database);let failure;
 try{create();return work();}catch(error){failure=error;throw error;}
 finally{try{drop();}catch(cleanup){if(failure)throw new AggregateError([failure,cleanup],'Restore failed and fixture cleanup failed.');throw cleanup;}}
}
