// SPDX-License-Identifier: Apache-2.0
// Explicit trusted unit fixtures; never used by the application runtime.
import type { DirectoryRepository } from './directory.js';
export const unitDirectory:DirectoryRepository={
  async find(subject,organizationId){return ['alice','bob','😀'.repeat(100)].includes(subject)?{subject,organizationId,displayName:subject,roles:[]}:undefined;},
  async list(_organizationId,query){return {items:[],page:{limit:query.limit,offset:query.offset,hasMore:false,nextOffset:null}};}
};
