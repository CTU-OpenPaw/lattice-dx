/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import {exact,title} from './policy.js';
import {parseAggregateQuery} from './aggregate-policy.js';
export function parseReportInput(value:unknown){const body=exact(value,['title','query']);return {title:title(body.title),query:parseAggregateQuery(body.query)};}
