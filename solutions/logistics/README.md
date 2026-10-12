# Logistics — integration contract

This solution exercises reusable platform blocks across sales, warehouse, dispatch, drivers and finance. `contract.ts` defines a typed demo fixture, allowed states and proposed role/action transitions. It does **not** install collections, provision roles, execute transitions or expose a logistics API.

| Object | Relationship and source |
| --- | --- |
| Warehouse | belongs to an organization; `locationId` references the future shared location registry |
| Vehicle | belongs to an organization; `assetId` references the future asset/context registry |
| Order | one warehouse; one initial backing platform `recordId`; `requestedBy` is an identity subject |
| Shipment | one order; optional vehicle while planned, required thereafter; several shipments may fulfill one order |

For this fixture a shipment is one delivery lot/trip for one order. Multiple lots/orders on one trip need separate Lot, Trip and TripItem models later; the current one-to-many relation must not be presented as that richer model. Employee, Department, Location and Asset are shared registries planned for the next phase; their IDs are opaque references, not validated by this fixture. Identity subjects must be supplied from Keycloak, never display names.

`validateLogistics` checks duplicate IDs, local references, organization boundaries, record UUID syntax and states. It validates typed fixtures, not untrusted HTTP input. The example record UUID is a placeholder; replace it with an actual `/v1/records` response before runtime linking.

Proposed roles: `logistics:sales`, `logistics:manager`, `logistics:warehouse`, `logistics:dispatch`, `logistics:driver`, `logistics:finance`. These are **not** configured in the local realm yet. Existing API permissions remain `records:*`, `tasks:*`, `files:*`; cross-department access and state guards are next-phase business policy.

Order: draft → submitted → approved/rejected; approved → preparing → ready → fulfilled → reconciled. Fulfilled requires every shipment delivered; reconciliation requires finance evidence. Shipment: planned → assigned → in_transit → delivered/exception; exception → assigned after dispatch review. `contract.ts` records proposed transition ownership; enforcing guards, audit and duplicate/retry handling is subsequent implementation.

Broker contribution: Vehicle/Warehouse/Shipment context can share current location, availability, temperature and delivery status with dashboards, rules and agents. Connectors map existing IDs to NGSI-LD entity IDs. Order approval and accounting remain in transactional business storage; broker events propose business actions through authorized APIs rather than overriding their state.

Hưng builds collections, screens and actions against this contract. Nhi maps external events/context through broker/n8n. Duy owns API permissions, action execution and later transactional workflow guards. See [phase-one handoff](../../docs/phase-one-integration-handoff.md).

Original solution code: Apache-2.0, covered by the repository root LICENSE.
