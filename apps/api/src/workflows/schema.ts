// SPDX-License-Identifier: Apache-2.0
import type { Pool } from 'pg';
export async function createWorkflowTables(pool:Pool) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS workflow_runs (
      id uuid PRIMARY KEY REFERENCES records(id), definition_id text NOT NULL, definition_version integer NOT NULL,
      title text NOT NULL, owner_id text NOT NULL, organization_id text NOT NULL, state text NOT NULL,
      version integer NOT NULL DEFAULT 1, data jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
    "ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled'))",
    'ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS cancellation jsonb',
    'ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS binding jsonb',
    'CREATE INDEX IF NOT EXISTS workflow_runs_scope ON workflow_runs(organization_id,updated_at)',
    `CREATE TABLE IF NOT EXISTS workflow_entity_contexts (
      run_id uuid PRIMARY KEY REFERENCES workflow_runs(id),organization_id text NOT NULL,entity_id uuid NOT NULL,
      schema_id text NOT NULL,schema_version integer NOT NULL,entity_version integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now())`,
    'CREATE INDEX IF NOT EXISTS workflow_entity_contexts_entity ON workflow_entity_contexts(organization_id,entity_id,created_at,run_id)',
    `CREATE TABLE IF NOT EXISTS workflow_starts (
      organization_id text NOT NULL, actor_id text NOT NULL, key text NOT NULL, fingerprint text NOT NULL,
      run_id uuid NOT NULL REFERENCES workflow_runs(id), result jsonb NOT NULL,
      PRIMARY KEY(organization_id,actor_id,key))`,
    `CREATE TABLE IF NOT EXISTS workflow_commands (
      run_id uuid NOT NULL REFERENCES workflow_runs(id), key text NOT NULL, actor_id text NOT NULL,
      fingerprint text NOT NULL, result jsonb NOT NULL, PRIMARY KEY(run_id,key))`,
    `CREATE TABLE IF NOT EXISTS workflow_audit (
      id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES workflow_runs(id), actor_id text NOT NULL,
      action text NOT NULL, from_state text, to_state text NOT NULL, version integer NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id,version))`,
    'ALTER TABLE workflow_audit ADD COLUMN IF NOT EXISTS metadata jsonb',
    `CREATE TABLE IF NOT EXISTS workflow_files (
      run_id uuid NOT NULL REFERENCES workflow_runs(id), file_id uuid NOT NULL REFERENCES foundation_files(id),
      PRIMARY KEY(run_id,file_id))`,
    `CREATE TABLE IF NOT EXISTS workflow_task_links (
      run_id uuid PRIMARY KEY REFERENCES workflow_runs(id), task_id uuid NOT NULL UNIQUE REFERENCES foundation_tasks(id))`,
    `CREATE TABLE IF NOT EXISTS workflow_members (
      organization_id text NOT NULL, subject text NOT NULL, PRIMARY KEY(organization_id,subject))`,
    `CREATE TABLE IF NOT EXISTS workflow_references (
      organization_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('department','location')),
      id text NOT NULL, name text NOT NULL, PRIMARY KEY(organization_id,kind,id))`,
    `CREATE TABLE IF NOT EXISTS workflow_jobs (
      id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES workflow_runs(id), organization_id text NOT NULL,
      payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, lease_token uuid,
      last_error text, created_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS workflow_action_results (
      run_id uuid NOT NULL REFERENCES workflow_runs(id), version integer NOT NULL, step_id text NOT NULL, step_index integer NOT NULL DEFAULT 0,
      actor_id text NOT NULL, action text NOT NULL, input jsonb NOT NULL, result jsonb NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_id,version,step_id))`,
    'ALTER TABLE workflow_action_results ADD COLUMN IF NOT EXISTS step_index integer NOT NULL DEFAULT 0',
    'CREATE INDEX IF NOT EXISTS workflow_jobs_ready ON workflow_jobs(status,available_at)',
    `CREATE TABLE IF NOT EXISTS workflow_waits (
      id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES workflow_runs(id), organization_id text NOT NULL,
      version integer NOT NULL, kind text NOT NULL CHECK(kind IN ('task','connector')), assignee_id text, connector_id text,
      config jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','failed','timed_out','cancelled')),
      deadline timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
      completion_key text, completion_fingerprint text, completion_actor text, receipt jsonb, evidence jsonb)`,
    "CREATE UNIQUE INDEX IF NOT EXISTS workflow_waits_pending_run ON workflow_waits(run_id) WHERE status='pending'",
    "CREATE INDEX IF NOT EXISTS workflow_waits_deadline ON workflow_waits(deadline) WHERE status='pending'",
    `CREATE TABLE IF NOT EXISTS workflow_services (
      organization_id text NOT NULL,id text NOT NULL,subject text NOT NULL,enabled boolean NOT NULL DEFAULT true,
      revision integer NOT NULL DEFAULT 1,PRIMARY KEY(organization_id,id))`,
    `CREATE TABLE IF NOT EXISTS workflow_timers (
      id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES workflow_runs(id),organization_id text NOT NULL,
      definition_id text NOT NULL,definition_version integer NOT NULL,run_version integer NOT NULL,
      step_id text NOT NULL,service_id text NOT NULL,transition_id text NOT NULL,input jsonb NOT NULL,
      due_at timestamptz NOT NULL,available_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','failed','cancelled')),
      attempts integer NOT NULL DEFAULT 0,last_error_code text,receipt jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
      UNIQUE(run_id,run_version,step_id))`,
    "CREATE UNIQUE INDEX IF NOT EXISTS workflow_timers_pending_run ON workflow_timers(run_id) WHERE status='pending'",
    "CREATE INDEX IF NOT EXISTS workflow_timers_ready ON workflow_timers(available_at,id) WHERE status='pending'",
    `CREATE TABLE IF NOT EXISTS workflow_timer_commands (
      organization_id text NOT NULL,actor_id text NOT NULL,operation text NOT NULL,key text NOT NULL,
      fingerprint text NOT NULL,result jsonb NOT NULL,PRIMARY KEY(organization_id,actor_id,operation,key))`,
  ];
  // Replace the old status constraint atomically so concurrent writes never see an unconstrained status.
  statements.push(`DO $$ BEGIN
    ALTER TABLE workflow_waits DROP CONSTRAINT IF EXISTS workflow_waits_status_check;
    ALTER TABLE workflow_waits ADD CONSTRAINT workflow_waits_status_check CHECK(status IN ('pending','succeeded','failed','timed_out','cancelled'));
  END $$`);
  for(const statement of statements) await pool.query(statement);
}
