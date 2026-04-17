import type { EnvironmentId } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureEnvironmentApi } from "~/environmentApi";

const DEFAULT_IOS_SIMULATOR_STATE_STALE_TIME = 10_000;

export const simulatorQueryKeys = {
  all: ["simulator"] as const,
  iosState: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["simulator", "ios-state", environmentId ?? null, cwd] as const,
};

export function iosSimulatorStateQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: simulatorQueryKeys.iosState(input.environmentId, input.cwd),
    queryFn: async () => {
      if (!input.environmentId || !input.cwd) {
        throw new Error("iOS Simulator state is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.simulator.getState({ cwd: input.cwd });
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null && input.cwd !== null,
    staleTime: DEFAULT_IOS_SIMULATOR_STATE_STALE_TIME,
    refetchOnWindowFocus: false,
  });
}

export function buildIosSimulatorStreamUrl(input: {
  udid: string;
  cacheKey?: string | number;
}): string {
  const url = new URL("/api/simulator/ios/stream", window.location.origin);
  url.searchParams.set("udid", input.udid);
  if (input.cacheKey !== undefined) {
    url.searchParams.set("v", String(input.cacheKey));
  }
  return url.toString();
}
