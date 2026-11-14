/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { WorkflowActor } from '@dx/contracts';
import { actionDescriptors } from '../actions.js';
import { blockCatalog } from '../blocks/registry.js';
import { entityFieldTypes } from '../entities/policy.js';
import { entityQueryOperators } from '../entities/query.js';
import { workflowBlockCatalog } from '../workflows/entity-block-catalog.js';
import { sourceRegistry, workflowFieldTypes } from '../workflows/registry.js';
import { bundlePreview } from '../workflows/bundles.js';
import { availability, type StudioOptions } from './policy.js';

export async function studioCatalog(actor: WorkflowActor, options: StudioOptions) {
  const dataDesigner = actor.roles.includes('data:design');
  const workflowDesigner = actor.roles.includes('workflow:design');
  const actions = actionDescriptors.filter(item => actor.roles.includes(item.requiredRole)).map(item => ({
    ...item, availability: availability(actor, [item.requiredRole], item.id === 'records.create' ? !!options.records : !!(options.foundation && options.directory)),
  }));
  const blocks = blockCatalog.filter(item => actor.roles.includes(item.requiredRole)).map(item => ({
    ...item, availability: availability(actor, [item.requiredRole], !!options.entities && (item.id !== 'entities.query' || !!options.entities.query)),
  }));
  // Builtin workflow steps execute through the workflow repository's transaction,
  // independently of the optional standalone action and entity repositories.
  const workflowBlocks = workflowDesigner ? workflowBlockCatalog.filter(item => actor.roles.includes(item.requiredRole)).map(item => ({
    ...item, availability: availability(actor, [item.requiredRole], !!options.workflows),
  })) : [];
  // Registry definitions contain declarative identifiers. Project only IDs, never runtime configuration.
  const connectors = workflowDesigner && options.workflows && actor.roles.includes('workflow:integrate')
    ? [...new Set(bundlePreview({format:'latticedx.workflow-bundle',formatVersion:1,definitions:await (options.definitionRegistry ?? sourceRegistry).list(actor.organizationId)}).definitions.flatMap(item => item.connectors))]
      .sort().map(id => ({id, version:1 as const})) : [];
  const services = workflowDesigner && actor.roles.includes('workflow:schedule') && options.workflows?.listServices
    ? (await options.workflows.listServices(actor)).map(item => ({id:item.id,version:1 as const,enabled:item.enabled})) : [];
  return {
    version:1 as const,
    entities:{fieldTypes:dataDesigner ? entityFieldTypes : [],queryOperators:dataDesigner ? entityQueryOperators : []},
    workflow:{fieldTypes:workflowDesigner ? workflowFieldTypes : [],blocks:workflowBlocks},
    actions, blocks, connectors, services,
  };
}
