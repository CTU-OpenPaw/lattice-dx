// SPDX-License-Identifier: Apache-2.0
import type {WorkflowActor} from '@dx/contracts';
import type {EntityEventOperation} from '../entities/events.js';
import type {Page,PageQuery} from '../pagination.js';
export type EventField='entityId'|'schemaId'|'schemaVersion'|'entityVersion'|'eventId'|'operation';
export type AutomationBinding={source:'literal';value:string}|{source:'event';field:EventField};
export type AutomationRuleInput={id:string;schemaId:string;schemaVersion:number;operations:EntityEventOperation[];serviceId:string;definitionId:string;definitionVersion:number;title:{source:'literal';value:string}|{source:'event';field:'entityId'|'operation'};input:Record<string,AutomationBinding>;transitionId?:string;enabled:boolean};
export type AutomationRule=AutomationRuleInput&{revision:number;createdAt:string;updatedAt:string};
export type AutomationDelivery={id:string;eventId:string;ruleId:string;ruleRevision:number;status:'pending'|'succeeded'|'failed'|'cancelled';version:number;attempts:number;lastErrorCode:string|null;availableAt:string;createdAt:string;completedAt:string|null;receipt:{runId:string;definitionId:string;definitionVersion:number}|null};
export interface AutomationRepository{
 create(value:AutomationRuleInput,actor:WorkflowActor,key:string):Promise<AutomationRule>;
 update(id:string,value:AutomationRuleInput&{expectedRevision:number},actor:WorkflowActor,key:string):Promise<AutomationRule>;
 list(actor:WorkflowActor,page:PageQuery):Promise<Page<AutomationRule>>;
 deliveries(id:string,actor:WorkflowActor,page:PageQuery):Promise<Page<AutomationDelivery>>;
 retry(id:string,deliveryId:string,expectedVersion:number,actor:WorkflowActor,key:string):Promise<AutomationDelivery>;
 tickOne():Promise<{deliveryId:string;status:AutomationDelivery['status']}|undefined>;
}
