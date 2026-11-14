/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
// Run inside the API container for explicit local acceptance; do not publish a host port.
if(process.env.N8N_FAILURE_FIXTURE!=='true')throw Error('Set N8N_FAILURE_FIXTURE=true for this local test server.');
require('node:http').createServer((request,response)=>{
 if(request.method!=='POST'||request.url!=='/orders'){response.writeHead(404);return response.end();}
 let body='';request.on('data',chunk=>{body+=chunk;if(body.length>16384)request.destroy();});
 request.on('end',()=>{
  let sku;try{sku=JSON.parse(body).sku;}catch{response.writeHead(400);return response.end();}
  if(sku==='DROP')return request.socket.destroy();
  if(sku==='NONJSON'){response.writeHead(200,{'content-type':'text/plain'});return response.end('not-json');}
  if(sku==='TIMEOUT')return setTimeout(()=>{response.writeHead(200,{'content-type':'application/json'});response.end('{}');},20000);
  response.writeHead(sku==='HTTP401'?401:201,{'content-type':'application/json'});
  response.end(JSON.stringify(sku==='HTTP401'?{error:'fixture_denied'}:{id:'fixture-order',state:'draft',version:1}));
 });
}).listen(4107,'0.0.0.0',()=>console.log('LOCAL TEST upstream listening on container-only port 4107.'));
