/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { createConnection } from 'node:net';
export function scanWithClamd(content:Buffer,host:string,port=3310):Promise<'clean'|'rejected'>{
  return new Promise((resolve,reject)=>{
    const socket=createConnection({host,port}); let response='';
    const fail=(error:Error)=>{socket.destroy();reject(error);};
    socket.setTimeout(15000,()=>fail(new Error('Scanner timeout')));
    socket.on('error',fail);
    socket.on('connect',()=>{
      const size=Buffer.alloc(4);size.writeUInt32BE(content.length);
      socket.write(Buffer.concat([Buffer.from('zINSTREAM\0'),size,content,Buffer.alloc(4)]));
    });
    socket.on('data',chunk=>{
      response+=chunk.toString();
      if(response.length>4096)return fail(new Error('Invalid scanner response'));
      if(!response.includes('\0'))return;
      socket.destroy();const line=response.split('\0')[0];
      if(line==='stream: OK')resolve('clean');
      else if(/^stream: .+ FOUND$/.test(line))resolve('rejected');
      else reject(new Error('Scanner failed'));
    });
    socket.on('end',()=>{if(!response.includes('\0'))fail(new Error('Incomplete scanner response'));});
  });
}
