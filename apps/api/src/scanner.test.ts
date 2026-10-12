// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:net';
import { test, expect } from 'vitest';
import { scanWithClamd } from './scanner';

test.each([
  ['stream: OK\0','clean'],
  ['stream: Test-Signature FOUND\0','rejected'],
  ['stream: INSTREAM size limit exceeded. ERROR\0','error'],
  ['stream: OK','error'],
])('scanner parses response %j and validates streamed framing',async(response,result)=>{
  let received=Buffer.alloc(0);
  const server=createServer(socket=>{
    socket.on('data',chunk=>{
      received=Buffer.concat([received,typeof chunk==='string'?Buffer.from(chunk):chunk]);
      if(received.length===22){socket.write(response.slice(0,5));socket.end(response.slice(5));}
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const address=server.address();if(!address||typeof address==='string')throw new Error('Missing test server port');
    const run=scanWithClamd(Buffer.from('test'),'127.0.0.1',address.port);
    if(result==='error')await expect(run).rejects.toThrow();else await expect(run).resolves.toBe(result);
    expect(received.subarray(0,10).toString()).toBe('zINSTREAM\0');
    expect(received.readUInt32BE(10)).toBe(4);
    expect(received.subarray(14,18).toString()).toBe('test');
    expect(received.readUInt32BE(18)).toBe(0);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
