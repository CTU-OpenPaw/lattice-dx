/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';
const {createHash}=require('node:crypto');
const table='lattice_native_request_uploads';

// Call prepare and execute in separate committed withRequest UPDATE-lock
// transactions. A timed-out remote write must leave its durable intent behind.
function createSharedUploadReceipts(query){
  const digest=input=>createHash('sha256').update(input.content).digest('hex');
  function matches(ctx,row,scope,input){
    if(String(row.uploader_id)!==String(scope.actor.userId)||row.filename!==input.filename||row.content_digest!==digest(input)){
      ctx.throw(409,'Có lượt tải chưa hoàn tất. Hãy chọn lại đúng tệp bằng tài khoản đã tải.');
    }
  }
  async function prepare(ctx,scope,input,opts={}){
    const {id,actor,transaction}=scope,key=input.key.toLowerCase();
    const stalePendingMs=Number(opts?.stalePendingMs)||0;
    if(stalePendingMs>0){
      const cutoff=new Date(Date.now()-stalePendingMs).toISOString();
      await query(`UPDATE ${table} SET state='failed',result=$4::jsonb,updated_at=NOW()
        WHERE request_id=$1 AND organization_id=$2 AND state='pending' AND COALESCE(updated_at,created_at)<$3`,
        [id,actor.organizationId,cutoff,JSON.stringify({status:503,message:'STALE_UPLOAD_EXPIRED'})],transaction);
    }
    const rows=await query(`SELECT * FROM ${table} WHERE request_id=$1 AND organization_id=$2
      AND ((uploader_id=$3 AND upload_key=$4) OR state='pending')`,[id,actor.organizationId,actor.userId,key],transaction);
    const existing=rows.find(row=>String(row.uploader_id)===String(actor.userId)&&row.upload_key===key);
    const row=existing??rows.find(row=>row.state==='pending');
    if(row){
      matches(ctx,row,scope,input);
      if(row.state==='pending')await query(`UPDATE ${table} SET attempts = attempts + 1
        WHERE request_id=$1 AND organization_id=$2 AND upload_key=$3 AND uploader_id=$4`,[id,actor.organizationId,row.upload_key,actor.userId],transaction);
      return {...input,key:row.upload_key};
    }
    await query(`INSERT INTO ${table}(request_id,organization_id,uploader_id,upload_key,filename,content_digest)
      VALUES($1,$2,$3,$4,$5,$6)`,[id,actor.organizationId,actor.userId,key,input.filename,digest(input)],transaction);
    return {...input,key};
  }
  async function beginExecute(ctx,scope,input){
    const {id,actor,transaction}=scope;
    const [row]=await query(`SELECT * FROM ${table} WHERE request_id=$1 AND organization_id=$2 AND uploader_id=$3 AND upload_key=$4`,
      [id,actor.organizationId,actor.userId,input.key],transaction);
    if(!row)ctx.throw(409,'Không tìm thấy lượt tải để đối soát.');
    matches(ctx,row,scope,input);
    if(row.state==='complete')return {phase:'done',response:{status:200,data:row.result.data}};
    if(row.state==='failed')return {phase:'done',response:{error:row.result}};
    return {phase:'execute',canonical:input,attempts:Number(row.attempts)};
  }
  async function finalizeExecute(ctx,scope,input,uploadResult,uploadError,attempts=1){
    const {id,actor,transaction}=scope;
    let result=uploadResult,state='complete';
    if(uploadError){
      const status=Number(uploadError.status??uploadError.statusCode);
      const failure={status:[400,409,413].includes(status)?status:503,message:typeof uploadError.message==='string'?uploadError.message.slice(0,1000):'Dịch vụ tệp chưa sẵn sàng.'};
      if(Number(attempts)!==1||![400,409,413].includes(status))return {error:failure};
      result=failure;state='failed';
    }
    await query(`UPDATE ${table} SET state=$4,result=$5::jsonb
      WHERE request_id=$1 AND organization_id=$2 AND upload_key=$3 AND uploader_id=$6`,
    [id,actor.organizationId,input.key,state,JSON.stringify(result),actor.userId],transaction);
    return state==='complete'?result:{error:result};
  }
  async function execute(ctx,scope,input,upload){
    const prep=await beginExecute(ctx,scope,input);
    if(prep.phase==='done')return prep.response;
    let result,err=null;
    try{result=await upload(prep.canonical);}
    catch(error){err=error;}
    return finalizeExecute(ctx,scope,prep.canonical,result,err,prep.attempts);
  }
  async function assertSettled(ctx,{id,actor,transaction}){
    const pending=await query(`SELECT 1 FROM ${table} WHERE request_id=$1 AND organization_id=$2 AND state='pending' LIMIT 1`,[id,actor.organizationId],transaction);
    if(pending.length)ctx.throw(409,'Có lượt tải chưa xác định kết quả. Hãy chọn lại đúng tệp để thử lại trước khi gửi duyệt.');
  }
  return {prepare,beginExecute,finalizeExecute,execute,assertSettled};
}
module.exports={createSharedUploadReceipts};
