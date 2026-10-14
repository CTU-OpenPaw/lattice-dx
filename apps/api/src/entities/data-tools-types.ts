// SPDX-License-Identifier: Apache-2.0
import type { Page, PageQuery } from '../pagination.js';
import type { Attributes, Entity, EntityQuery, Scope } from './types.js';
export type Attachment = {fileId:string;filename:string;size:number;scanStatus:string;createdBy:string;createdAt:string};
export type AttachmentInput = {fileId:string;expectedVersion:number};
export interface EntityDataToolsRepository {
 attach(scope:Scope,id:string,input:AttachmentInput,key:string):Promise<Entity>;
 detach(scope:Scope,id:string,input:AttachmentInput,key:string):Promise<Entity>;
 attachments(scope:Scope,id:string,page:PageQuery):Promise<Page<Attachment>>;
 attachmentContent(scope:Scope,id:string,fileId:string):Promise<{filename:string;content:Buffer}>;
}
