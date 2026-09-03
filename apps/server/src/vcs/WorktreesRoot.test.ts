import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { resolveWorktreesRoot } from "./WorktreesRoot.ts";

describe("resolveWorktreesRoot", () => {
  const withPathService = (body: (pathService: Path.Path) => void) =>
    Effect.gen(function* () {
      body(yield* Path.Path);
    }).pipe(Effect.provide(NodeServices.layer));

  it.effect("keeps the fallback when nothing is configured", () =>
    withPathService((pathService) => {
      assert.equal(
        resolveWorktreesRoot({ configured: "", fallback: "/t3/worktrees" }, pathService),
        "/t3/worktrees",
      );
    }),
  );

  it.effect("expands a leading tilde to the home directory", () =>
    withPathService((pathService) => {
      assert.equal(
        resolveWorktreesRoot({ configured: "~/worktrees", fallback: "/t3/worktrees" }, pathService),
        pathService.join(NodeOS.homedir(), "worktrees"),
      );
    }),
  );

  it.effect("keeps an absolute directory as written", () =>
    withPathService((pathService) => {
      assert.equal(
        resolveWorktreesRoot({ configured: "/mnt/trees/", fallback: "/t3/worktrees" }, pathService),
        pathService.normalize("/mnt/trees/"),
      );
    }),
  );
});
