/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Page, PageQuery } from '../pagination.js';
import type { Attributes, Entity, EntityQuery, Scope } from './types.js';
export type Attachment = {fileId:string;filename:string;size:number;scanStatus:string;createdBy:string;createdAt:string};
export type AttachmentInput = {fileId:string;expectedVersion:number};
export type ImportInput={schemaId:string;schemaVersion:number;format:'json'|'csv';content:string};
export type ImportRow={title:string;attributes:Attributes};
export type ImportPreparation={schemaId:string;schemaVersion:number;digest?:string;rowCount:number;valid:boolean;errors:{row:number;error:string}[];rows:ImportRow[]};
export type ImportDryRun=Omit<ImportPreparation,'rows'>;
export type ImportResult={schemaId:string;schemaVersion:number;entityIds:string[]};
export type MigrationInput={expectedVersion:number;targetSchemaVersion:number;attributes:Attributes};
export type MigrationDryRun={valid:boolean;digest?:string;targetSchemaVersion:number;expectedVersion:number;errors:string[]};
export type ExportResult={format:'json'|'csv';content:string;page:Page<Entity>['page']};
export interface EntityDataToolsRepository {
 importDryRun(scope:Scope,input:ImportInput):Promise<ImportDryRun>;
 importCommit(scope:Scope,input:ImportInput & {expectedDigest:string},key:string):Promise<ImportResult>;
 export(scope:Scope,input:{query:EntityQuery;format:'json'|'csv'}):Promise<ExportResult>;
 migrationDryRun(scope:Scope,id:string,input:MigrationInput):Promise<MigrationDryRun>;
 migrationCommit(scope:Scope,id:string,input:MigrationInput & {expectedDigest:string},key:string):Promise<Entity>;

 attach(scope:Scope,id:string,input:AttachmentInput,key:string):Promise<Entity>;
 detach(scope:Scope,id:string,input:AttachmentInput,key:string):Promise<Entity>;
 attachments(scope:Scope,id:string,page:PageQuery):Promise<Page<Attachment>>;
 attachmentContent(scope:Scope,id:string,fileId:string):Promise<{filename:string;content:Buffer}>;
}
