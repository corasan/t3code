import type * as Path from "effect/Path";

import { expandHomePathWith } from "../pathExpansion.ts";

/** Resolve the root for generated worktrees: empty keeps the fallback, `~` expands to home, anything else is an absolute path. */
export function resolveWorktreesRoot(
  input: { readonly configured: string; readonly fallback: string },
  path: Path.Path,
): string {
  if (input.configured === "") {
    return input.fallback;
  }
  if (input.configured.startsWith("~")) {
    return expandHomePathWith(input.configured, path);
  }
  return path.normalize(input.configured);
}
