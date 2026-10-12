// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { OutboxJob, WorkflowJobs } from './types.js';

export function workflowJobDatabase(pool: Pool): WorkflowJobs {
  return {
    async claim() {
      // A crash on the fifth delivery must not leave an unclaimable processing row.
      await pool.query(`UPDATE workflow_jobs SET status='failed', lease_until=NULL, lease_token=NULL,
        last_error='Workflow event delivery lease expired'
        WHERE status='processing' AND attempts>=5 AND lease_until<=now()`);
      const result = await pool.query<OutboxJob>(`WITH candidate AS (
        SELECT id FROM workflow_jobs
        WHERE attempts<5 AND ((status='pending' AND available_at<=now())
          OR (status='processing' AND lease_until<=now()))
        ORDER BY available_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE workflow_jobs AS job SET status='processing', attempts=job.attempts+1,
        lease_until=now()+interval '60 seconds', lease_token=$1
        FROM candidate WHERE job.id=candidate.id
        RETURNING job.id, job.run_id AS "runId", job.organization_id AS "organizationId",
          job.payload, job.attempts, job.lease_token AS "leaseToken"`, [randomUUID()]);
      return result.rows[0];
    },
    async succeed(job) {
      await pool.query(`UPDATE workflow_jobs SET status='succeeded', lease_until=NULL, lease_token=NULL, last_error=NULL
        WHERE id=$1 AND status='processing' AND lease_token=$2`, [job.id, job.leaseToken]);
    },
    async fail(job, _error) {
      // Never persist arbitrary exception text: it may contain credentials or event data.
      await pool.query(`UPDATE workflow_jobs SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,
        available_at=now()+make_interval(secs => LEAST(300, 5*power(2, attempts-1))::int),
        lease_until=NULL, lease_token=NULL, last_error=$3
        WHERE id=$1 AND status='processing' AND lease_token=$2`,
      [job.id, job.leaseToken, 'Workflow event delivery failed']);
    },
  };
}
