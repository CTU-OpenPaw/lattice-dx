// SPDX-License-Identifier: Apache-2.0
'use strict';

function manualInterface(name,title,actions,collection) {
  const buttons=Object.fromEntries(actions.map(action=>[action.key,{type:'void',title:action.title,'x-component':'Action','x-decorator':'ManualActionStatusProvider','x-decorator-props':{value:action.status},'x-component-props':{type:action.key==='reject'?'default':'primary',useAction:'{{ useSubmit }}'},'x-designer':'ManualActionDesigner','x-action-settings':{assignedValues:{values:action.values}}}]));
  const actionBar={type:'void','x-decorator':'ActionBarProvider','x-component':'ActionBar','x-component-props':{layout:'one-column'},'x-initializer':'workflowManual:form:configureActions',properties:buttons};
  const form={type:'void','x-component':'FormV2','x-use-component-props':'useFormBlockProps',properties:{actions:actionBar}};
  const formBlock={type:'void','x-decorator':'CustomFormBlockProvider','x-decorator-props':{collection:{name,fields:[]}},'x-component':'CardItem','x-component-props':{title},'x-designer':'SimpleDesigner','x-designer-props':{type:'customForm'},properties:{[name]:form}};
  const column={type:'void','x-component':'Grid.Col',properties:{formBlock}};
  const row={type:'void','x-component':'Grid.Row',properties:{column}};
  const detailFields=Object.fromEntries(['code','name','description','category'].map(field=>[field,{type:'string','x-component':'CollectionField','x-decorator':'FormItem','x-collection-field':collection+'.'+field,'x-read-pretty':true}]));
  const details={type:'void','x-decorator':'DetailsBlockProvider','x-decorator-props':{collection,dataPath:'$context.data'},'x-component':'CardItem','x-component-props':{title:'Thông tin yêu cầu'},'x-settings':'blockSettings:singleDataDetails',properties:{form:{type:'void','x-component':'FormV2','x-use-component-props':'useDetailsBlockProps','x-read-pretty':true,properties:detailFields}}};
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
module.exports={documentProcessTemplate};
