/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WorkflowActor } from "@dx/contracts";
import { verifyIdentity, type IdentityConfig } from "../identity.js";
import { parseCreateKey, CreateCommandError } from "../create-command.js";
import { parsePage, PageError } from "../pagination.js";
import { parseCreate, WorkflowError } from "../workflows/policy.js";
import {
  EntityError,
  slug,
  version as revision,
} from "../entities/policy.js";
import { bundleKeys } from "../workflows/bundles.js";
import { requireModuleAdmin, requireModuleDesigner, semver } from "./policy.js";
import type { ModuleRepository } from "./types.js";
export type ModuleOptions = {
  identity?: IdentityConfig;
  modules?: ModuleRepository;
};
function key(request: FastifyRequest): string {
  const value = parseCreateKey(
    request.headers["idempotency-key"],
    request.raw.rawHeaders,
  );
  if (!value) throw new WorkflowError(400, "Idempotency-Key required.");
  return value;
}
export function registerModules(
  app: FastifyInstance,
  options: ModuleOptions,
): void {
  app.register(async (routes) => {
    const actors = new WeakMap<object, WorkflowActor>();
    routes.setErrorHandler((error, _request, reply) => {
      if (
        error instanceof WorkflowError ||
        error instanceof EntityError ||
        error instanceof PageError ||
        error instanceof CreateCommandError
      )
        return reply.code(error.statusCode).send({ error: error.message });
      return reply.send(error);
    });
    routes.addHook("preHandler", async (request, reply) => {
      if (!options.identity || !options.modules)
        return reply
          .code(503)
          .send({ error: "Module service is not configured." });
      let identity;
      try {
        identity = await verifyIdentity(
          request.headers.authorization,
          options.identity,
        );
      } catch {
        return reply.code(401).send({ error: "Invalid token." });
      }
      if (!identity.organizationId)
        return reply.code(403).send({ error: "Organization scope required." });
      actors.set(request, {
        ...identity,
        organizationId: identity.organizationId,
      });
      const query = request.query as Record<string, unknown>;
      if (
        Object.keys(query).some((k) =>
          request.method === "GET" && ["limit", "offset", "q"].includes(k)
            ? false
            : true,
        )
      )
        throw new WorkflowError(400, "Unexpected query.");
    });
    for (const operation of ["preview", "install"] as const)
      routes.post(
        "/v1/enterprise-modules/" + operation,
        { bodyLimit: 128 * 1024 },
        async (request, reply) => {
          const actor = actors.get(request)!;
          requireModuleAdmin(actor);
          bundleKeys(request.body, ["manifest"]);
          if (operation === "preview")
            return options.modules!.preview(request.body.manifest, actor);
          return reply
            .code(201)
            .send(
              await options.modules!.install(
                request.body.manifest,
                actor,
                key(request),
              ),
            );
        },
      );
    routes.get("/v1/enterprise-modules", async (request) => {
      const actor = actors.get(request)!;
      requireModuleDesigner(actor);
      return options.modules!.list(
        actor,
        parsePage(request.query as Record<string, unknown>),
      );
    });
    type Params = { id: string; version: string };
    routes.get<{ Params: Params }>(
      "/v1/enterprise-modules/:id/versions/:version",
      async (request) => {
        const actor = actors.get(request)!;
        requireModuleDesigner(actor);
        return options.modules!.get(
          slug(request.params.id),
          semver(request.params.version),
          actor,
        );
      },
    );
    routes.get<{ Params: Params }>(
      "/v1/enterprise-modules/:id/versions/:version/audit",
      async (request) => {
        const actor = actors.get(request)!;
        requireModuleDesigner(actor);
        return options.modules!.audit(
          slug(request.params.id),
          semver(request.params.version),
          actor,
          parsePage(request.query as Record<string, unknown>),
        );
      },
    );
    routes.post<{ Params: Params }>(
      "/v1/enterprise-modules/:id/versions/:version/enabled",
      async (request) => {
        const actor = actors.get(request)!;
        requireModuleAdmin(actor);
        bundleKeys(request.body, ["expectedRevision", "enabled"]);
        if (typeof request.body.enabled !== "boolean")
          throw new WorkflowError(400, "Invalid enabled state.");
        return options.modules!.setEnabled(
          slug(request.params.id),
          semver(request.params.version),
          {
            expectedRevision: revision(request.body.expectedRevision),
            enabled: request.body.enabled,
          },
          actor,
          key(request),
        );
      },
    );
    routes.post<{Params: Params & {bindingId: string}}>(
      "/v1/enterprise-modules/:id/versions/:version/bindings/:bindingId/start",
      async (request, reply) => {
        const actor = actors.get(request)!;
        if (!actor.roles.includes("workflow:start"))
          throw new WorkflowError(403, "workflow:start required.");
        bundleKeys(request.body, ["entityId", "title", "input"]);
        const value = parseCreate({
          definitionId: "binding",
          title: request.body.title,
          input: request.body.input,
          entityContext: {entityId: request.body.entityId},
        });
        if (!value) throw new WorkflowError(400, "Invalid binding start body.");
        return reply.code(201).send(await options.modules!.startBinding(
          slug(request.params.id),
          semver(request.params.version),
          slug(request.params.bindingId),
          {entityId: value.entityContext!.entityId, title: value.title, input: value.input},
          actor,
          key(request),
        ));
      },
    );
    routes.post<{ Params: Params }>(
      "/v1/enterprise-modules/:id/versions/:version/start",
      async (request, reply) => {
        const actor = actors.get(request)!;
        if (!actor.roles.includes("workflow:start"))
          throw new WorkflowError(403, "workflow:start required.");
        const value = parseCreate(request.body);
        if (!value) throw new WorkflowError(400,"Invalid workflow start body.");
        return reply
          .code(201)
          .send(
            await options.modules!.start(
              slug(request.params.id),
              semver(request.params.version),
              value,
              actor,
              key(request),
            ),
          );
      },
    );
  });
}
