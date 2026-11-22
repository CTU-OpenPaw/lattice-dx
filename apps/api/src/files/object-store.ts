/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
export const MAX_FILE_BYTES=1048576;
export type StoragePointer =
 | {provider:'postgres';objectKey:null;sha256:null;size:number}
 | {provider:'filesystem';objectKey:string;sha256:string;size:number};
export interface ObjectStore {
 writeVerified(content:Buffer):Promise<{objectKey:string;size:number;sha256:string}>;
 readVerified(pointer:Extract<StoragePointer,{provider:'filesystem'}>):Promise<Buffer>;
}
