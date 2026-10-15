// SPDX-License-Identifier: Apache-2.0
export type BlockDescriptor={id:string;version:1;title:string;requiredRole:'data:read'|'data:write';inputSchema:Record<string,unknown>;outputSchema:Record<string,unknown>;mutation:boolean};
