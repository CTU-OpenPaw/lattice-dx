/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {runIncidentJob,IncidentWorkerError} from '../apps/agent-worker/src/incident.ts';
try{
 if(process.argv.length!==3)throw new IncidentWorkerError('usage: pnpm agent:incident <job-uuid>');
 const result=await runIncidentJob({
  apiUrl:process.env.AGENT_ENGINE_URL??'',workerToken:process.env.AGENT_WORKER_TOKEN??'',
  baseUrl:process.env.AGENT_BASE_URL??'',apiKey:process.env.AGENT_API_KEY??'',model:process.env.AGENT_MODEL??'',
 },process.argv[2]);
 console.log(JSON.stringify(result));
}catch(error){
 console.error(error instanceof IncidentWorkerError?error.code:'worker_configuration_or_provider_error');process.exitCode=1;
}
