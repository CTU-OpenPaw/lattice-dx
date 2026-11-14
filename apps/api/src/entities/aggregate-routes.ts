/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {FastifyRequest} from 'fastify';
import {EntityError} from './policy.js';
import {parseAggregateQuery} from './aggregate-policy.js';
import type {EntityRepository,Scope} from './types.js';
export async function aggregateRoute(request:FastifyRequest,repository:EntityRepository,scope:Scope) {
 const query=parseAggregateQuery(request.body);
 if(!repository.aggregate)throw new EntityError(503,'Entity aggregate is unavailable.');
 return repository.aggregate(scope,query);
}
