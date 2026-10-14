// SPDX-License-Identifier: Apache-2.0
// Contracts for the installed examples. New applications register adapters here
// or in a trusted plugin, without changing Workspace, Form/List or validators.
function registerApplicationContracts(registry) {
  registry.registerResource('records',{url:'dxActions:list',method:'get',resource:'records'});
  registry.registerResource('tasks',{url:'dxActions:list',method:'get',resource:'tasks'});
  registry.registerResource('orders',{url:'dxActions:logistics',method:'post',operation:'orders'});
  registry.registerReference('records',{mode:'suggestion',resource:'records',value:'id',label:'title'});
  registry.registerReference('warehousePeople',{mode:'select',url:'dxActions:logistics',operation:'people',query:{role:'logistics:warehouse'},value:'subject',label:'displayName',placeholder:'Chọn người kho…'});
  const title={required:true,maxLength:200,trim:true};
  registry.registerAction('records.create',{version:1,resource:'records',role:'records:write',fields:{title},lengthMode:'utf16',attachments:{phase:'after'},transport:{kind:'catalog'}});
  registry.registerAction('tasks.create',{version:1,resource:'tasks',role:'tasks:assign',lengthMode:'utf16',fields:{title,assigneeId:{required:true,maxLength:100},recordId:{maxLength:36,pattern:'uuid',reference:'records'}},transport:{kind:'catalog'}});
  registry.registerAction('logistics.create',{version:1,resource:'orders',role:'logistics:sales',lengthMode:'codepoints',
    fields:{title,customerName:{required:true,maxLength:2000},deliveryAddress:{required:true,maxLength:2000},sku:{required:true,maxLength:2000},quantity:{required:true,maxLength:7,type:'positiveInteger',maximum:1000000},warehouseAssigneeId:{required:true,maxLength:100,reference:'warehousePeople'},attachmentId:{maxLength:36,pattern:'uuid'}},
    attachments:{phase:'before',field:'attachmentId'},availabilityReference:'warehousePeople',
    transport:{kind:'command',url:'dxActions:logistics',operation:'create',definitionId:'logistics_order'}});
}
module.exports={registerApplicationContracts};
