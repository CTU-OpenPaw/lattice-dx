/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type {FastifyRequest} from 'fastify';
import {parseEntitySearch} from './search-policy.js';
import {SearchUnavailableError} from './search-client.js';
import type {EntityRepository,Scope} from './types.js';
export async function searchRoute(request:FastifyRequest,repository:EntityRepository,scope:Scope) {
 const query=parseEntitySearch(request.body);
 if(!repository.search)throw new SearchUnavailableError();
 return repository.search(scope,query);
}
