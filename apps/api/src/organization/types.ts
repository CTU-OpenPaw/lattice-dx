/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Page, PageQuery } from '../pagination.js';
export type OrganizationActor={
  subject:string;
  organizationId:string;
  roles:string[]
};
export type DepartmentInput={
  name:string;
  parentId:string|null;
  managerId:string|null
};
export type DepartmentCreate=DepartmentInput&{
  id:string
};
export type DepartmentUpdate=DepartmentInput&{
  expectedVersion:number
};
export type Department=DepartmentCreate&{
  version:number;
  createdAt:string;
  updatedAt:string
};
export type DepartmentHistory=Department&{
  actorId:string;
  operation:'create'|'update'
};
export type SnapshotPerson={
  subject:string;
  displayName:string;
  departmentId?:string;
  roles:string[];
  enabled:boolean
};
export type SnapshotInput={
  expectedRevision:number;
  people:SnapshotPerson[]
};
export type DirectoryState={
  revision:number;
  updatedAt:string|null
};
export interface OrganizationRepository {
  createDepartment(actor:OrganizationActor,input:DepartmentCreate,key:string):Promise<Department>;
  updateDepartment(actor:OrganizationActor,id:string,input:DepartmentUpdate,key:string):Promise<Department>;
  listDepartments(organizationId:string,query:PageQuery):Promise<Page<Department>>;
  departmentHistory(organizationId:string,id:string,query:PageQuery):Promise<Page<DepartmentHistory>>;
  directoryState(organizationId:string):Promise<DirectoryState>;
  replaceSnapshot(actor:OrganizationActor,input:SnapshotInput,key:string):Promise<DirectoryState&{
    changeCount:number
  }
  >;
}
