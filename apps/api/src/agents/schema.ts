/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {Pool,PoolClient} from 'pg';
export async function createAgentTables(pool:Pool|PoolClient){
  await pool.query(`CREATE TABLE IF NOT EXISTS agent_jobs (
 id uuid PRIMARY KEY REFERENCES workflow_waits(id),organization_id text NOT NULL,run_id uuid NOT NULL REFERENCES workflow_runs(id),
 requester_id text NOT NULL,asset_id uuid NOT NULL,asset_version integer NOT NULL,
 notification_id text NOT NULL,attachment_id uuid,run_version integer NOT NULL,deadline timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','failed','completed')),version integer NOT NULL DEFAULT 1,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),worker_id text,lease_token uuid,lease_until timestamptz,
 proposal_id uuid UNIQUE,proposal jsonb,result_hash text,error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz);
 CREATE TABLE IF NOT EXISTS agent_attempts(job_id uuid NOT NULL REFERENCES agent_jobs(id),attempt integer NOT NULL,worker_id text NOT NULL,lease_token uuid NOT NULL,started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,outcome text,PRIMARY KEY(job_id,attempt));
 CREATE TABLE IF NOT EXISTS agent_commands(organization_id text NOT NULL,actor_id text NOT NULL,key text NOT NULL,input jsonb NOT NULL,result jsonb NOT NULL,PRIMARY KEY(organization_id,actor_id,key));
 CREATE TABLE IF NOT EXISTS incident_agent_decisions(run_id uuid NOT NULL REFERENCES workflow_runs(id),job_id uuid NOT NULL REFERENCES agent_jobs(id),proposal_id uuid NOT NULL,decision text NOT NULL CHECK(decision IN ('approve','reject')),actor_id text NOT NULL,run_version integer NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(run_id,job_id));
 CREATE OR REPLACE FUNCTION protect_completed_agent_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  IF OLD.status='completed' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id OR NEW.proposal IS DISTINCT FROM OLD.proposal OR NEW.result_hash IS DISTINCT FROM OLD.result_hash OR NEW.worker_id IS DISTINCT FROM OLD.worker_id OR NEW.lease_token IS DISTINCT FROM OLD.lease_token OR NEW.asset_id IS DISTINCT FROM OLD.asset_id OR NEW.asset_version IS DISTINCT FROM OLD.asset_version) THEN
   RAISE EXCEPTION 'Completed agent proposal is immutable';
  END IF;
  RETURN NEW;
 END $$;
 DROP TRIGGER IF EXISTS agent_proposal_immutable ON agent_jobs;
 CREATE TRIGGER agent_proposal_immutable BEFORE UPDATE ON agent_jobs FOR EACH ROW EXECUTE FUNCTION protect_completed_agent_proposal();`);
}
