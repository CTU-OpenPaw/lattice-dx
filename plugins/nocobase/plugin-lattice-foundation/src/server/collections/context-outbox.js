// SPDX-License-Identifier: Apache-2.0
// Private integration journal, deliberately absent from Collection Manager/UI roles.
module.exports=require('@nocobase/database').defineCollection({
 name:'latticeContextOutbox',migrationRules:['schema-only'],createdAt:true,updatedAt:true,
 fields:[
  {name:'eventId',type:'string',allowNull:false,unique:true},
  {name:'entityId',type:'string',allowNull:false},
  {name:'organizationId',type:'string',allowNull:false},
  {name:'collectionName',type:'string',allowNull:false},
  {name:'recordId',type:'bigInt',allowNull:false},
  {name:'payload',type:'json',allowNull:false},
  {name:'state',type:'string',allowNull:false,defaultValue:'pending'},
  {name:'attempts',type:'integer',allowNull:false,defaultValue:0},
  {name:'nextAttemptAt',type:'date'},
  {name:'deliveredAt',type:'date'},
  {name:'errorCode',type:'string'},
 ],
 indexes:[{fields:['entityId','id']},{fields:['state','nextAttemptAt','id']}],
});
