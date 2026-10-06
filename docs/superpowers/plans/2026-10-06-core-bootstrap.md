# Core Bootstrap Implementation Plan

> **For agentic workers:** Execute inline with executing-plans, task by task.

**Goal:** Prepare a shareable repo with local PostgreSQL, Keycloak, APISIX and an authenticated records API.

**Architecture:** APISIX forwards authenticated requests to an internal API container. API independently verifies issuer, audience and signatures using Keycloak JWKS; PostgreSQL persists owner-scoped records. Development realm credentials are public fixtures, never production secrets.

**Tech Stack:** Existing pnpm workspace, Fastify, jose, pg, Docker Compose.

## Constraints

- Keep upstream checkout ignored; do not redistribute NocoBase.
- Pin Docker versions and record source/license links.
- Bind published ports to loopback; no public deployment.
- No workflow/files/NGSI-LD implementation in this slice.

## Tasks

- [x] Write failing integration tests for JWT validation, role enforcement, owner isolation and malformed record data, using signed RSA JWTs and an injected repository.
- [x] Implement verifier and records routes; use PostgreSQL queries with parameters and owner filters.
- [x] Add Compose, container build, development Keycloak realm and APISIX standalone routes.
- [x] Verify typecheck/tests/build and Compose config.
- [ ] Run container smoke test: Docker Engine was not responsive after Docker Desktop start attempts. Configuration and SQL/container integration remain unverified at runtime.
- [x] Add reproducible smoke script, setup/build/license/limitation docs and contribution files.
- [x] Review tracked content and secret exclusions; prepare local Git baseline. Remote creation depends on chosen name and destination.
