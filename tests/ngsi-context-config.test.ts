/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {afterEach,expect,test,vi} from 'vitest';
import {subscriptionConfig,registerSubscription} from '../scripts/lib/ngsi-ld-subscription.mjs';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
test('local broker uses one inline mapping object; NGSI-LD core context is implicit',async()=>{
 vi.stubEnv('NGSI_LD_NOTIFICATION_TOKEN','fixture-context-token-'.repeat(3));
 const config=await subscriptionConfig();
 expect(Array.isArray(config.context)).toBe(false);
 expect(config.context).toMatchObject({Asset:'https://latticedx.example/ns/Asset',businessId:'https://latticedx.example/ns/businessId',organizationId:'https://latticedx.example/ns/organizationId',status:'https://latticedx.example/ns/status'});
});
test('subscription updates reference a hosted context rather than persisting an inline context',async()=>{
 vi.stubEnv('NGSI_LD_NOTIFICATION_TOKEN','fixture-context-token-'.repeat(3));
 const config=await subscriptionConfig();
 const location='http://broker:1026/ngsi-ld/v1/jsonldContexts/fixture-id';
 const transport=vi.fn().mockResolvedValueOnce(Response.json({id:config.id})).mockResolvedValueOnce(new Response(null,{status:201,headers:{location}})).mockResolvedValueOnce(new Response(null,{status:204}));
 vi.stubGlobal('fetch',transport);
 await registerSubscription(config);
 const options=transport.mock.calls[2]?.[1];
 expect(options?.method).toBe('PATCH');expect(options.headers['Content-Type']).toBe('application/ld+json');
 const body=JSON.parse(options.body);
 expect(body['@context']).toBe(location);
 expect(body.entities[0].type).toBe('Asset');
 expect(body.watchedAttributes).toEqual(['status']);
 expect(body.notification.attributes).toEqual(['businessId','organizationId','status']);
 expect(body.notification.endpoint.receiverInfo).toEqual([{key:'X-Lattice-Broker-Token',value:config.token}]);
});
