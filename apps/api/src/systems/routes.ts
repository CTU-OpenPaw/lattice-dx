// SPDX-License-Identifier: Apache-2.0
import type { FastifyInstance } from "fastify";
import { verifyIdentity, type IdentityConfig } from "../identity.js";
import type { WorkflowActor } from "@dx/contracts";
import { requireModuleAdmin, semver } from "../modules/policy.js";
import type { ModuleRepository } from "../modules/types.js";
import { bundleKeys } from "../workflows/bundles.js";
import { WorkflowError } from "../workflows/policy.js";
import { slug, EntityError, version as revision } from "../entities/policy.js";
import { parsePage, PageError } from "../pagination.js";
import { parseCreateKey, CreateCommandError } from "../create-command.js";
import { compileSystem } from "./policy.js";
import type { SystemRepository } from "./database.js";
import type {
  PrincipalType,
  SystemAccessRepository,
  SystemGrantInput,
  SystemGrantRevokeInput,
  SystemGrantUpdateInput,
} from "./access-types.js";

export type SystemOptions = {
  identity?: IdentityConfig;
  systems?: SystemRepository;
  modules?: ModuleRepository;
  systemAccess?: SystemAccessRepository;
};

export function registerSystems(app: FastifyInstance, options: SystemOptions) {
  app.register(async (routes) => {
    const actors = new WeakMap<object, WorkflowActor>();
    routes.setErrorHandler((e, _request, reply) => {
      if (
        e instanceof WorkflowError ||
        e instanceof EntityError ||
        e instanceof PageError ||
        e instanceof CreateCommandError
      )
        return reply.code(e.statusCode).send({ error: e.message });
      return reply.code(500).send({ error: "System operation failed" });
    });
    routes.addHook("preHandler", async (request, reply) => {
      if (!options.identity || !options.systems)
        return reply.code(503).send({ error: "System Studio unavailable" });
      let actor;
      try {
        actor = await verifyIdentity(
          request.headers.authorization,
          options.identity,
        );
      } catch {
        return reply.code(401).send({ error: "Invalid identity" });
      }
      if (!actor.organizationId)
        return reply.code(403).send({ error: "Organization required" });
      actors.set(request, { ...actor, organizationId: actor.organizationId });
      if (!request.url.startsWith("/v1/system-apps"))
        requireModuleAdmin(actors.get(request)!);
      const isMembersHistory = request.url.includes("/members/history");
      const isMembersList = request.url.includes("/members") && !isMembersHistory;
      const isAccessMe = request.url.includes("/access/me");
      const allowedQuery = isMembersHistory
        ? ["limit", "offset", "q", "principalType", "principalId"]
        : isMembersList
          ? ["limit", "offset", "q", "principalType"]
          : isAccessMe
            ? []
            : ["limit", "offset", "q"];
      if (
        Object.keys(request.query as object).some(
          (k) => !allowedQuery.includes(k),
        )
      )
        throw new WorkflowError(400, "Unexpected system query");
    });
    routes.get("/v1/system-drafts", async (request) =>
      options.systems!.list(
        actors.get(request)!,
        parsePage(request.query as Record<string, unknown>),
      ),
    );
    routes.get<{ Params: { id: string } }>(
      "/v1/system-drafts/:id",
      async (request) =>
        options.systems!.get(slug(request.params.id), actors.get(request)!),
    );
    for (const update of [false, true])
      routes.route<{ Params: { id?: string } }>({
        method: update ? "PUT" : "POST",
        url: update ? "/v1/system-drafts/:id" : "/v1/system-drafts",
        bodyLimit: 65536,
        handler: async (request, reply) => {
          bundleKeys(
            request.body,
            update ? ["recipe", "expectedRevision"] : ["recipe"],
          );
          const key = parseCreateKey(
            request.headers["idempotency-key"],
            request.raw.rawHeaders,
          );
          if (!key) throw new WorkflowError(400, "Idempotency-Key required");
          const manifest = compileSystem(request.body.recipe);
          if (update && slug(request.params.id) !== manifest.id)
            throw new WorkflowError(400, "Draft ID is immutable");
          return reply
            .code(update ? 200 : 201)
            .send(
              await options.systems!.save(
                request.body.recipe,
                update ? revision(request.body.expectedRevision) : undefined,
                actors.get(request)!,
                key,
              ),
            );
        },
      });
    routes.post(
      "/v1/studio/system-plan",
      { bodyLimit: 65536 },
      async (request) => {
        bundleKeys(request.body, ["recipe"]);
        const manifest = compileSystem(request.body.recipe);
        if (!options.modules)
          throw new WorkflowError(503, "Module installer unavailable");
        let installed = null;
        try {
          installed = await options.modules.get(
            manifest.id,
            manifest.version,
            actors.get(request)!,
          );
        } catch (error) {
          if (!(error instanceof WorkflowError) || error.statusCode !== 404)
            throw error;
        }
        return {
          manifest,
          installed,
          preview: await options.modules.preview(
            manifest,
            actors.get(request)!,
          ),
        };
      },
    );
    routes.get("/v1/system-apps", async (request) =>
      options.systems!.runtime(
        actors.get(request)!,
        parsePage(request.query as Record<string, unknown>),
      ),
    );
    routes.get<{ Params: { id: string; version: string } }>(
      "/v1/system-apps/:id/versions/:version",
      async (request) => {
        const result = await options.systems!.runtime(
          actors.get(request)!,
          { limit: 1, offset: 0, q: "" },
          slug(request.params.id),
          semver(request.params.version),
        );
        if (!result.items.length)
          throw new WorkflowError(404, "Published system unavailable");
        return result.items[0];
      },
    );

    routes.get<{ Params: { id: string; version: string } }>(
      "/v1/system-apps/:id/versions/:version/access/me",
      async (request) => {
        if (!options.systemAccess)
          throw new WorkflowError(503, "System access service unavailable");
        return options.systemAccess.effectiveAccess(
          slug(request.params.id),
          semver(request.params.version),
          actors.get(request)!,
        );
      },
    );

    routes.get<{
      Params: { id: string; version: string };
      Querystring: Record<string, unknown>;
    }>("/v1/systems/:id/versions/:version/members", async (request) => {
      if (!options.systemAccess)
        throw new WorkflowError(503, "System access service unavailable");
      const principalType = request.query.principalType as PrincipalType | undefined;
      return options.systemAccess.list(
        slug(request.params.id),
        semver(request.params.version),
        actors.get(request)!,
        parsePage(request.query as Record<string, unknown>),
        principalType,
      );
    });

    routes.post<{ Params: { id: string; version: string } }>(
      "/v1/systems/:id/versions/:version/members",
      { bodyLimit: 16384 },
      async (request, reply) => {
        if (!options.systemAccess)
          throw new WorkflowError(503, "System access service unavailable");
        bundleKeys(request.body, ["principalType", "principalId", "roles"]);
        const key = parseCreateKey(
          request.headers["idempotency-key"],
          request.raw.rawHeaders,
        );
        if (!key) throw new WorkflowError(400, "Idempotency-Key required");
        const body = request.body as unknown as SystemGrantInput;
        const result = await options.systemAccess.grant(
          slug(request.params.id),
          semver(request.params.version),
          body,
          actors.get(request)!,
          key,
        );
        return reply.code(201).send(result);
      },
    );

    routes.put<{
      Params: {
        id: string;
        version: string;
        principalType: PrincipalType;
        principalId: string;
      };
    }>(
      "/v1/systems/:id/versions/:version/members/:principalType/:principalId",
      { bodyLimit: 16384 },
      async (request) => {
        if (!options.systemAccess)
          throw new WorkflowError(503, "System access service unavailable");
        bundleKeys(request.body, ["expectedRevision", "roles"]);
        const key = parseCreateKey(
          request.headers["idempotency-key"],
          request.raw.rawHeaders,
        );
        if (!key) throw new WorkflowError(400, "Idempotency-Key required");
        return options.systemAccess.update(
          slug(request.params.id),
          semver(request.params.version),
          request.params.principalType,
          request.params.principalId,
          request.body as unknown as SystemGrantUpdateInput,
          actors.get(request)!,
          key,
        );
      },
    );

    routes.delete<{
      Params: {
        id: string;
        version: string;
        principalType: PrincipalType;
        principalId: string;
      };
    }>(
      "/v1/systems/:id/versions/:version/members/:principalType/:principalId",
      { bodyLimit: 16384 },
      async (request) => {
        if (!options.systemAccess)
          throw new WorkflowError(503, "System access service unavailable");
        bundleKeys(request.body, ["expectedRevision"]);
        const key = parseCreateKey(
          request.headers["idempotency-key"],
          request.raw.rawHeaders,
        );
        if (!key) throw new WorkflowError(400, "Idempotency-Key required");
        return options.systemAccess.revoke(
          slug(request.params.id),
          semver(request.params.version),
          request.params.principalType,
          request.params.principalId,
          request.body as unknown as SystemGrantRevokeInput,
          actors.get(request)!,
          key,
        );
      },
    );

    routes.get<{
      Params: { id: string; version: string };
      Querystring: Record<string, unknown>;
    }>("/v1/systems/:id/versions/:version/members/history", async (request) => {
      if (!options.systemAccess)
        throw new WorkflowError(503, "System access service unavailable");
      const principalType = request.query.principalType as PrincipalType | undefined;
      const principalId = typeof request.query.principalId === "string" ? request.query.principalId : undefined;
      return options.systemAccess.history(
        slug(request.params.id),
        semver(request.params.version),
        actors.get(request)!,
        parsePage(request.query as Record<string, unknown>),
        principalType,
        principalId,
      );
    });
  });
}
