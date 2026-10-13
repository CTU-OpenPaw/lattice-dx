// SPDX-License-Identifier: Apache-2.0
import type { Pool } from 'pg';
export async function createWorkflowTables(pool:Pool) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS workflow_runs (
      id uuid PRIMARY KEY REFERENCES records(id), definition_id text NOT NULL, definition_version integer NOT NULL,
      title text NOT NULL, owner_id text NOT NULL, organization_id text NOT NULL, state text NOT NULL,
      version integer NOT NULL DEFAULT 1, data jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
    'CREATE INDEX IF NOT EXISTS workflow_runs_scope ON workflow_runs(organization_id,updated_at)',
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
    'CREATE INDEX IF NOT EXISTS workflow_jobs_ready ON workflow_jobs(status,available_at)',
  ];
  for(const statement of statements) await pool.query(statement);
}
