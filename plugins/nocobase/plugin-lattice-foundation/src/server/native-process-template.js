/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

function manualInterface(name,title,actions,collection,fields=['code','name','description','category'],detailTitle='Thông tin yêu cầu',note) {
  const buttons=Object.fromEntries(actions.map(action=>[action.key,{type:'void',title:action.title,'x-component':'Action','x-decorator':'ManualActionStatusProvider','x-decorator-props':{value:action.status},'x-component-props':{type:action.key==='reject'?'default':'primary',useAction:'{{ useSubmit }}'},'x-designer':'ManualActionDesigner','x-action-settings':{assignedValues:{values:action.values}}}]));
  const actionBar={type:'void','x-decorator':'ActionBarProvider','x-component':'ActionBar','x-component-props':{layout:'one-column'},'x-initializer':'workflowManual:form:configureActions',properties:buttons};
  const properties=note?{[note.key]:{type:'string',title:note.title,required:true,'x-decorator':'FormItem','x-component':'Input.TextArea','x-component-props':{maxLength:1000}},actions:actionBar}:{actions:actionBar};
  const form={type:'void','x-component':'FormV2','x-use-component-props':'useFormBlockProps',properties};
  const formBlock={type:'void','x-decorator':'CustomFormBlockProvider','x-decorator-props':{collection:{name,fields:[]}},'x-component':'CardItem','x-component-props':{title},'x-designer':'SimpleDesigner','x-designer-props':{type:'customForm'},properties:{[name]:form}};
  const column={type:'void','x-component':'Grid.Col',properties:{formBlock}};
  const row={type:'void','x-component':'Grid.Row',properties:{column}};
  const detailFields=Object.fromEntries(fields.map(field=>[field,{type:'string','x-component':'CollectionField','x-decorator':'FormItem','x-collection-field':collection+'.'+field,'x-read-pretty':true}]));
  if(collection==='latticeIncidentCases'&&name==='review')detailFields.aiEvidence={type:'void','x-component':'LatticeIncidentEvidence'};
  const details={type:'void','x-decorator':'DetailsBlockProvider','x-decorator-props':{collection,dataPath:'$context.data'},'x-component':'CardItem','x-component-props':{title:detailTitle},'x-settings':'blockSettings:singleDataDetails',properties:{form:{type:'void','x-component':'FormV2','x-use-component-props':'useDetailsBlockProps','x-read-pretty':true,properties:detailFields}}};
  const detailRow={type:'void','x-component':'Grid.Row',properties:{column:{type:'void','x-component':'Grid.Col',properties:{details}}}};
  const grid={type:'void','x-component':'Grid','x-initializer':'workflowManual:popup:configureUserInterface:addBlock',properties:{detailRow,row}};
  return {tab1:{type:'void',title,'x-component':'Tabs.TabPane','x-designer':'Tabs.Designer',properties:{grid}}};
}

// Bootstrap data for the host designer. These are native node configurations,
// not an executor, state machine or task store. The administrator can edit them.
function documentProcessTemplate({collection,organizationId,reviewerEmployeeId,assigneeEmployeeId,startOnSubmit=false}) {
  if(!['latticeRequests','latticeOrders'].includes(collection)||!/^[-a-zA-Z0-9_]{1,80}$/.test(organizationId??'')||![reviewerEmployeeId,assigneeEmployeeId].every(id=>/^[1-9]\d*$/.test(String(id))))throw new Error('Invalid native process template configuration');
  const nodes=[];
  const context=field=>'{{$context.data.'+field+'}}';
  const result=(key,path)=>'{{$jobsMapByNodeKey.'+key+'.'+path+'}}';
  const node=(key,type,title,config)=>{nodes.push({key,type,title,config,upstreamKey:nodes.at(-1)?.key});};
  const query=(key,id,extra={})=>node(key,'query','Kiểm tra '+key,{collection:'latticeEmployees',multiple:false,failOnEmpty:true,params:{filter:{id,organizationId,active:true,userId:{$ne:null},...extra}}});
  const condition=(key,left,right,calculator='equal')=>node(key,'condition','Kiểm tra '+key,{rejectOnFalse:true,calculation:{calculator,operands:[left,right]}});
  const update=(key,values,status)=>node(key,'update','Cập nhật '+key,{collection,params:{individualHooks:true,filter:{id:context('id'),organizationId,...(status?{status}:{})},values}});
  const form=(actions)=>({type:'custom',actions:actions.map(([key,title,values])=>({key,title,status:1,values}))});
  const manual=(key,title,userId,actions)=>{
    const config=form(actions);
    node(key,'manual',title,{mode:0,assignees:[userId],forms:{[key]:config},schema:manualInterface(key,title,config.actions,collection)});
  };
  query('requester',context('requesterId'));
  query('reviewer',reviewerEmployeeId,{'user.roles.name':{$in:['ldx_manager','ldx_admin']}});
  condition('separation',result('reviewer','userId'),result('requester','userId'),'notEqual');
  if (!startOnSubmit) update('submitted',{status:'submitted'},'draft');
  manual('review','Duyệt yêu cầu',result('reviewer','userId'),[['approve','Duyệt',{decision:'approved'}],['reject','Từ chối',{decision:'rejected'}]]);
  query('reviewerCurrent',reviewerEmployeeId,{userId:result('reviewer','userId'),'user.roles.name':{$in:['ldx_manager','ldx_admin']}});
  update('decision',{status:result('review','review.decision')},'submitted');
  node('approved','condition','Kết quả phê duyệt',{rejectOnFalse:false,calculation:{calculator:'equal',operands:[result('review','review.decision'),'approved']}});
  query('assignee',assigneeEmployeeId);
  update('assigned',{status:'assigned',assigneeId:result('assignee','id')},'approved');
  manual('work','Thực hiện công việc',result('assignee','userId'),[['complete','Hoàn thành',{}]]);
  query('assigneeCurrent',assigneeEmployeeId,{userId:result('assignee','userId')});
  update('completed',{status:'completed'},'assigned');
  nodes.push({key:'rejected',type:'end',title:'Kết thúc nhánh từ chối',config:{endStatus:1},upstreamKey:'approved',branchIndex:0});
  const trigger = startOnSubmit
    ? {mode:2,changed:['status'],condition:{organizationId,status:'submitted'}}
    : {mode:1,condition:{organizationId}};
  return {workflow:{title:'Lattice native — '+collection+' — '+organizationId,type:'collection',enabled:false,sync:false,config:{collection,...trigger}},nodes};
}
function proposalReviewTemplate({organizationId,reviewerEmployeeId}) {
  if(!/^[-a-zA-Z0-9_]{1,80}$/.test(organizationId??'')||! /^[1-9]\d*$/.test(String(reviewerEmployeeId)))throw new Error('Invalid native review configuration');
  const collection='latticeAgentProposals';
  const reviewer={id:reviewerEmployeeId,organizationId,active:true,userId:{$ne:null},'user.roles.name':{$in:['ldx_manager','ldx_admin']}};
  const userId='{{$jobsMapByNodeKey.reviewer.userId}}';
  const actions=[{key:'reviewed',title:'Xác nhận đã xem',status:1,values:{decision:'reviewed'}}];
  return {workflow:{title:'UC2 — Xem xét đề xuất — '+organizationId,type:'collection',enabled:false,sync:false,config:{collection,mode:1,condition:{organizationId,targetCollection:'latticeAssets',state:'proposed'}}},nodes:[
    {key:'reviewer',type:'query',title:'Kiểm tra người duyệt',config:{collection:'latticeEmployees',multiple:false,failOnEmpty:true,params:{filter:reviewer}}},
    {key:'separation',type:'condition',title:'Tách người gửi và người duyệt',upstreamKey:'reviewer',config:{rejectOnFalse:true,calculation:{calculator:'notEqual',operands:[userId,'{{$context.data.sourceUserId}}']}}},
    {key:'review',type:'manual',title:'Xem xét đề xuất UC2',upstreamKey:'separation',config:{mode:0,assignees:[userId],forms:{review:{type:'custom',actions}},schema:manualInterface('review','Xem xét đề xuất UC2',actions,collection,['targetRecordId'],'Đề xuất UC2')}},
    {key:'reviewerCurrent',type:'query',title:'Kiểm tra lại người duyệt',upstreamKey:'review',config:{collection:'latticeEmployees',multiple:false,failOnEmpty:true,params:{filter:{...reviewer,userId}}}},
  ]};
}

function incidentProcessTemplate({organizationId,reviewerEmployeeId,assigneeEmployeeId}){
  const ids=[reviewerEmployeeId,assigneeEmployeeId].map(String);
  if(!/^[-a-zA-Z0-9_]{1,80}$/.test(organizationId??'')||!ids.every(id=>/^[1-9]\d{0,18}$/.test(id))||ids[0]===ids[1])throw new Error('Invalid native incident configuration');
  const [reviewerId,handlerId]=ids;
  const collection='latticeIncidentCases',nodes=[];
  const state=(key,path)=>'{{$jobsMapByNodeKey.'+key+'.'+path+'}}';
  const node=(key,type,title,config)=>nodes.push({key,type,title,config,upstreamKey:nodes.at(-1)?.key});
  const employee=(key,id,extra)=>node(key,'query','Kiểm tra người được giao',{collection:'latticeEmployees',multiple:false,failOnEmpty:true,params:{filter:{id,organizationId,active:true,userId:{$ne:null},...extra}}});
  const managerRole={'user.roles.name':{$in:['ldx_manager','ldx_admin']}};
  const condition=(key,left,right,calculator='equal',rejectOnFalse=true)=>node(key,'condition','Kiểm tra '+key,{rejectOnFalse,calculation:{calculator,operands:[left,right]}});
  const update=(key,status,values)=>node(key,'update','Cập nhật sự cố',{collection,params:{individualHooks:true,filter:{id:'{{$context.data.id}}',organizationId,status,handlerId},values}});
  const manual=(key,title,user,actions,note)=>node(key,'manual',title,{mode:0,assignees:[user],forms:{[key]:{type:'custom',actions}},schema:manualInterface(key,title,actions,collection,['code','name','status','resolutionNote'],'Thông tin sự cố',note)});
  const reviewer=state('reviewer','userId'),handler=state('handler','userId');
  employee('reviewer',reviewerId,managerRole);
  employee('handler',handlerId);
  condition('separation',reviewer,handler,'notEqual');
  manual('review','Duyệt sự cố',reviewer,[{key:'approve',title:'Duyệt',status:1,values:{decision:'approved'}},{key:'reject',title:'Từ chối',status:1,values:{decision:'rejected'}}]);
  employee('reviewerCurrent',reviewerId,{...managerRole,userId:reviewer});
  condition('approved',state('review','review.decision'),'approved','equal',false);
  update('markApproved','open',{status:'approved'});
  employee('handlerBeforeWork',handlerId,{userId:handler});
  manual('resolution','Ghi kết quả xử lý',handler,[{key:'resolve',title:'Ghi kết quả',status:1,values:{}}],{key:'note',title:'Kết quả xử lý'});
  employee('handlerCurrent',handlerId,{userId:handler});
  const resolution=state('resolution','resolution.note');
  condition('resolutionPresent',resolution,'','notEqual');
  update('markResolved','approved',{status:'resolved',resolutionNote:resolution});
  employee('reviewerBeforeClose',reviewerId,{...managerRole,userId:reviewer});
  manual('close','Đóng sự cố',reviewer,[{key:'close',title:'Đóng sự cố',status:1,values:{}}],{key:'note',title:'Ghi chú đóng sự cố'});
  employee('reviewerAtClose',reviewerId,{...managerRole,userId:reviewer});
  const close=state('close','close.note');
  condition('closeNotePresent',close,'','notEqual');
  update('markClosed','resolved',{status:'closed',closeNote:close});
  condition('rejected',state('review','review.decision'),'rejected');
  nodes.at(-1).upstreamKey='approved';
  nodes.at(-1).branchIndex=0;
  update('markRejected','open',{status:'rejected'});
  return {workflow:{title:'UC2 — Xử lý sự cố — '+organizationId,type:'collection',enabled:false,sync:false,config:{collection,mode:1,condition:{organizationId,handlerId,status:'open'}}},nodes};
}

module.exports={documentProcessTemplate,proposalReviewTemplate,incidentProcessTemplate};
