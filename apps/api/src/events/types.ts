/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {WorkflowActor} from '@dx/contracts';
import type {Page,PageQuery} from '../pagination.js';

export type InboundEvent={eventId:string;eventType:string;occurredAt:string;data:Record<string,string>};
export type EventBinding={source:'event';field:string}|{source:'envelope';field:'eventId'}|{source:'literal';value:string};
export type SubscriptionInput={id:string;eventType:string;sourceSubject:string;definitionId:string;definitionVersion:number;title:EventBinding;input:Record<string,EventBinding>;enabled:boolean};
export type SubscriptionUpdate=SubscriptionInput&{expectedRevision:number};
export type EventSubscription=SubscriptionInput&{revision:number};
export type EventReceipt={eventId:string;status:'accepted';runs:{subscriptionId:string;runId:string}[]};
export interface EventRepository {
 receive(value:InboundEvent,actor:WorkflowActor):Promise<EventReceipt>;
 get(eventId:string,actor:WorkflowActor):Promise<EventReceipt>;
 listSubscriptions(actor:WorkflowActor,page:PageQuery):Promise<Page<EventSubscription>>;
 createSubscription(value:SubscriptionInput,actor:WorkflowActor,key:string):Promise<EventSubscription>;
 updateSubscription(id:string,value:SubscriptionUpdate,actor:WorkflowActor,key:string):Promise<EventSubscription>;
}
