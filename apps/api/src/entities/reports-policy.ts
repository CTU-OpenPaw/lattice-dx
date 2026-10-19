// SPDX-License-Identifier: Apache-2.0
import {exact,title} from './policy.js';
import {parseAggregateQuery} from './aggregate-policy.js';
export function parseReportInput(value:unknown){const body=exact(value,['title','query']);return {title:title(body.title),query:parseAggregateQuery(body.query)};}
