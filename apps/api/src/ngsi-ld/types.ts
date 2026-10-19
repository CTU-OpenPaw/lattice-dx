// SPDX-License-Identifier: Apache-2.0
export type AssetObservation = { entityId: string; businessId: string; status: string; observedAt: string };
export type AssetContext = AssetObservation & { organizationId: string; subscriptionId: string; notificationId: string; receivedAt: string };
export type Notification = { id: string; subscriptionId: string; observations: AssetObservation[] };
export type NotificationResult = { applied: number; ignored: number };
export interface ContextRepository {
  apply(organizationId: string, notification: Notification): Promise<NotificationResult>;
  find(organizationId: string, entityId: string): Promise<AssetContext | undefined>;
}
export type NgsiLdOptions = { ngsiLd?: { token: string; tenant: string; subscriptionId: string; repository?: ContextRepository } };
export class NotificationError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
