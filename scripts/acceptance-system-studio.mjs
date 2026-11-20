/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url),
  esbuild = createRequire(require.resolve("tsx/package.json"))("esbuild");
const bundle = esbuild.buildSync({
  entryPoints: ["scripts/system-studio-acceptance.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["pg", "fastify", "jose"],
  write: false,
  logLevel: "silent",
}).outputFiles[0].contents;
try {
  console.log(
    execFileSync(
      "docker",
      [
        "--context",
        "desktop-linux",
        "compose",
        "-f",
        "infra/compose/core.yml",
        "exec",
        "-T",
        "-w",
        "/app/apps/api",
        "api",
        "node",
      ],
      {
        input: bundle,
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 2 * 1024 * 1024,
      },
    ).trim(),
  );
} catch {
  console.error("System Studio acceptance failed.");
  process.exitCode = 1;
}
