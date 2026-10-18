// SPDX-License-Identifier: Apache-2.0
import type {Proposal} from './policy.js';
export type StoredAgentJob={
  id:string;
  organization_id:string;
  run_id:string;
  requester_id:string;
  asset_id:string;
  asset_version:number;
  notification_id:string;
  attachment_id:string|null;
  run_version:number;
  deadline:Date|string;
  status:'queued'|'running'|'failed'|'completed';
  version:number;
  attempts:number;
  worker_id:string|null;
  lease_token:string|null;
  lease_until:Date|string|null;
  lease_live:boolean;
  proposal_id:string|null;
  proposal:Proposal|null;
  result_hash:string|null;
  error_code:string|null;
};
export type StoredIncidentRun={
  id:string;
  definition_id:string;
  definition_version:number;
  organization_id:string;
  owner_id:string;
  state:string;
  version:number;
  status:'active'|'cancelled';
  title:string;
  created_at:Date|string;
  updated_at:Date|string;
  data:Record<string,string>
};
