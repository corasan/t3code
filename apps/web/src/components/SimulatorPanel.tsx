import type { EnvironmentId } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LoaderIcon,
  PanelRightCloseIcon,
  PlayIcon,
  RefreshCcwIcon,
  SmartphoneIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { ensureEnvironmentApi } from "~/environmentApi";
import {
  buildIosSimulatorStreamUrl,
  iosSimulatorStateQueryOptions,
  simulatorQueryKeys,
} from "~/lib/simulatorReactQuery";
import { cn } from "~/lib/utils";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { toastManager } from "./ui/toast";

interface SimulatorPanelProps {
  environmentId: EnvironmentId;
  projectCwd: string | null;
  mode?: "sheet" | "sidebar";
  onClose: () => void;
}

interface DragState {
  startX: number;
  startY: number;
  latestX: number;
  latestY: number;
}

const DRAG_DISTANCE_THRESHOLD = 0.015;
const SPECIAL_KEY_MAP = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Escape",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
]);

function normalizePointerPosition(
  element: HTMLElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return { x: 0, y: 0 };
  }
  const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const y = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  return { x, y };
}

function isDragGesture(input: DragState): boolean {
  const deltaX = input.latestX - input.startX;
  const deltaY = input.latestY - input.startY;
  return Math.hypot(deltaX, deltaY) >= DRAG_DISTANCE_THRESHOLD;
}

const SimulatorPanel = memo(function SimulatorPanel({
  environmentId,
  projectCwd,
  mode = "sidebar",
  onClose,
}: SimulatorPanelProps) {
  const queryClient = useQueryClient();
  const viewportRef = useRef<HTMLImageElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const [selectedDeviceUdid, setSelectedDeviceUdid] = useState<string | null>(null);
  const [streamVersion, setStreamVersion] = useState(0);

  const simulatorStateQuery = useQuery({
    ...iosSimulatorStateQueryOptions({
      environmentId,
      cwd: projectCwd,
      enabled: projectCwd !== null,
    }),
    refetchInterval: 3_000,
  });

  const simulatorState = simulatorStateQuery.data ?? null;
  const devices = simulatorState?.devices ?? [];
  const bootedDeviceUdid = simulatorState?.bootedDeviceUdid ?? null;

  useEffect(() => {
    if (!devices.length) {
      setSelectedDeviceUdid(null);
      return;
    }
    if (selectedDeviceUdid && devices.some((device) => device.udid === selectedDeviceUdid)) {
      return;
    }
    setSelectedDeviceUdid(
      bootedDeviceUdid ?? simulatorState?.preferredDeviceUdid ?? devices[0]?.udid ?? null,
    );
  }, [bootedDeviceUdid, devices, selectedDeviceUdid, simulatorState?.preferredDeviceUdid]);

  const selectedDevice = useMemo(
    () => devices.find((device) => device.udid === selectedDeviceUdid) ?? null,
    [devices, selectedDeviceUdid],
  );

  const streamUrl =
    selectedDevice && selectedDevice.state === "booted"
      ? buildIosSimulatorStreamUrl({
          udid: selectedDevice.udid,
          cacheKey: `${selectedDevice.udid}:${streamVersion}`,
        })
      : null;

  const invalidateSimulatorState = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: simulatorQueryKeys.iosState(environmentId, projectCwd),
    });
  }, [environmentId, projectCwd, queryClient]);

  const bootMutation = useMutation({
    mutationFn: async (udid: string) =>
      ensureEnvironmentApi(environmentId).simulator.boot({ udid }),
    onSuccess: async (result) => {
      setSelectedDeviceUdid(result.device.udid);
      setStreamVersion((current) => current + 1);
      await invalidateSimulatorState();
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not boot Simulator",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });

  const sendInteraction = useCallback(
    async (
      input:
        | { kind: "tap"; x: number; y: number }
        | { kind: "drag"; fromX: number; fromY: number; toX: number; toY: number }
        | { kind: "type"; text: string }
        | { kind: "press"; key: string },
    ) => {
      if (!selectedDeviceUdid) {
        return;
      }
      try {
        await ensureEnvironmentApi(environmentId).simulator.interact({
          ...input,
          udid: selectedDeviceUdid,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Simulator input failed",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [environmentId, selectedDeviceUdid],
  );

  const handlePointerDown = useCallback((event: PointerEvent<HTMLImageElement>) => {
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const { x, y } = normalizePointerPosition(target, event.clientX, event.clientY);
    dragStateRef.current = {
      startX: x,
      startY: y,
      latestX: x,
      latestY: y,
    };
    target.focus();
  }, []);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLImageElement>) => {
    if (!dragStateRef.current) {
      return;
    }
    const { x, y } = normalizePointerPosition(event.currentTarget, event.clientX, event.clientY);
    dragStateRef.current = {
      ...dragStateRef.current,
      latestX: x,
      latestY: y,
    };
  }, []);

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLImageElement>) => {
      const dragState = dragStateRef.current;
      dragStateRef.current = null;
      if (!dragState) {
        return;
      }
      event.currentTarget.releasePointerCapture(event.pointerId);
      if (isDragGesture(dragState)) {
        void sendInteraction({
          kind: "drag",
          fromX: dragState.startX,
          fromY: dragState.startY,
          toX: dragState.latestX,
          toY: dragState.latestY,
        });
        return;
      }
      void sendInteraction({
        kind: "tap",
        x: dragState.latestX,
        y: dragState.latestY,
      });
    },
    [sendInteraction],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLImageElement>) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.key.length === 1) {
        event.preventDefault();
        void sendInteraction({ kind: "type", text: event.key });
        return;
      }
      if (SPECIAL_KEY_MAP.has(event.key)) {
        event.preventDefault();
        void sendInteraction({ kind: "press", key: event.key });
      }
    },
    [sendInteraction],
  );

  const shellClassName =
    mode === "sidebar"
      ? "h-full w-[min(32rem,42vw)] shrink-0 border-l border-border/70"
      : "h-full w-full";

  const eligible = Boolean(simulatorState?.supported && simulatorState.isExpoProject);
  const canRenderStream = Boolean(streamUrl);

  return (
    <div className={cn("flex min-h-0 flex-col bg-card/50", shellClassName)}>
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className="rounded-md bg-emerald-500/10 px-1.5 py-0 text-[10px] font-semibold tracking-wide text-emerald-400 uppercase"
          >
            Simulator
          </Badge>
          {selectedDevice ? (
            <span className="text-[11px] text-muted-foreground/70">{selectedDevice.name}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => {
              setStreamVersion((current) => current + 1);
              void invalidateSimulatorState();
            }}
            aria-label="Refresh Simulator"
            disabled={simulatorStateQuery.isFetching}
            className="text-muted-foreground/50 hover:text-foreground/70"
          >
            {simulatorStateQuery.isFetching ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : (
              <RefreshCcwIcon className="size-3.5" />
            )}
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
            aria-label="Close simulator panel"
            className="text-muted-foreground/50 hover:text-foreground/70"
          >
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <div className="flex items-center gap-2">
          <Select
            value={selectedDeviceUdid ?? ""}
            onValueChange={(value) => {
              setSelectedDeviceUdid(value);
              setStreamVersion((current) => current + 1);
            }}
            disabled={!devices.length}
          >
            <SelectTrigger size="sm" className="min-w-0 flex-1">
              <SelectValue placeholder={devices.length ? "Choose a device" : "No devices found"} />
            </SelectTrigger>
            <SelectPopup>
              {devices.map((device) => (
                <SelectItem key={device.udid} value={device.udid}>
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{device.name}</span>
                    <span className="text-[11px] text-muted-foreground/60">{device.runtime}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (!selectedDeviceUdid) {
                return;
              }
              bootMutation.mutate(selectedDeviceUdid);
            }}
            disabled={
              !selectedDeviceUdid || bootMutation.isPending || selectedDevice?.state === "booted"
            }
          >
            {bootMutation.isPending ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : (
              <PlayIcon className="size-3.5" />
            )}
            {selectedDevice?.state === "booted" ? "Ready" : "Boot"}
          </Button>
        </div>

        {!simulatorStateQuery.isLoading && !simulatorState?.supported ? (
          <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-border/70 bg-background/60 px-6 text-center text-sm text-muted-foreground/75">
            {simulatorState?.supportReason ?? "Simulator streaming is unavailable here."}
          </div>
        ) : null}

        {!simulatorStateQuery.isLoading &&
        simulatorState?.supported &&
        !simulatorState.isExpoProject ? (
          <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-border/70 bg-background/60 px-6 text-center text-sm text-muted-foreground/75">
            This project does not look like an Expo app, so the built-in simulator stays hidden.
          </div>
        ) : null}

        {!simulatorStateQuery.isLoading && eligible && devices.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-border/70 bg-background/60 px-6 text-center text-sm text-muted-foreground/75">
            No available iOS Simulator devices were found on this Mac.
          </div>
        ) : null}

        {eligible ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[1.75rem] border border-border/70 bg-[radial-gradient(circle_at_top,#1f293733,transparent_55%),linear-gradient(180deg,#0f172a,#020617)] p-3 shadow-[0_20px_60px_-30px_rgba(15,23,42,0.8)]">
            <div className="mb-2 flex items-center justify-between gap-2 px-1">
              <div className="flex items-center gap-2 text-[11px] text-slate-300/70">
                <SmartphoneIcon className="size-3.5" />
                <span>{selectedDevice?.runtime ?? "iOS Simulator"}</span>
              </div>
              <Badge
                variant="outline"
                className={cn(
                  "border-white/10 bg-white/5 text-[10px] uppercase tracking-wide text-slate-200/70",
                  selectedDevice?.state === "booted" &&
                    "border-emerald-400/20 bg-emerald-400/10 text-emerald-200",
                )}
              >
                {selectedDevice?.state ?? "idle"}
              </Badge>
            </div>

            <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-[1.4rem] border border-white/10 bg-black/70">
              {canRenderStream ? (
                <img
                  key={streamUrl}
                  ref={viewportRef}
                  src={streamUrl ?? undefined}
                  alt="Live iOS Simulator stream"
                  className="max-h-full max-w-full select-none outline-none"
                  draggable={false}
                  tabIndex={0}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onKeyDown={handleKeyDown}
                  onError={() => {
                    setStreamVersion((current) => current + 1);
                  }}
                />
              ) : (
                <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center text-sm text-slate-300/75">
                  <SmartphoneIcon className="size-8 text-slate-200/55" />
                  <p>
                    {selectedDevice
                      ? "Boot the selected simulator to start the live interactive view."
                      : "Choose a simulator device to begin."}
                  </p>
                  {selectedDevice && selectedDevice.state !== "booted" ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        if (!selectedDeviceUdid) {
                          return;
                        }
                        bootMutation.mutate(selectedDeviceUdid);
                      }}
                      disabled={bootMutation.isPending}
                    >
                      {bootMutation.isPending ? (
                        <LoaderIcon className="size-3.5 animate-spin" />
                      ) : (
                        <PlayIcon className="size-3.5" />
                      )}
                      Boot And Open
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
});

export default SimulatorPanel;
