import type { EnvironmentId, IosSimulatorDevice } from "@t3tools/contracts";
import { createEmptyIosSimulatorRuntimeState } from "@t3tools/shared/simulatorRuntime";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleIcon,
  LayoutGridIcon,
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
import { isH264StreamPlayerSupported, startH264StreamPlayer } from "~/lib/h264StreamPlayer";
import {
  buildIosSimulatorStreamUrl,
  iosSimulatorStateQueryOptions,
  simulatorQueryKeys,
} from "~/lib/simulatorReactQuery";
import { resolveSelectedIosSimulatorDeviceUdid } from "./SimulatorPanel.logic";
import {
  hasSimulatorBootSignal,
  isSimulatorFrameStale,
  readSimulatorPanelRuntimeDevice,
  reduceSimulatorPanelRuntimeState,
  shouldAutoReconnectSimulatorStream,
} from "./SimulatorPanel.runtime";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { toastManager } from "./ui/toast";

interface SimulatorPanelProps {
  environmentId: EnvironmentId;
  projectCwd: string | null;
  onClose: () => void;
}

interface PointerGestureState {
  pointerId: number;
  latestX: number;
  latestY: number;
  sendInFlight: boolean;
  pendingPosition: { x: number; y: number } | null;
  ended: boolean;
}

const EMPTY_IOS_SIMULATOR_DEVICES: ReadonlyArray<IosSimulatorDevice> = [];
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

const webCodecsSupported = isH264StreamPlayerSupported();

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

const SimulatorPanel = memo(function SimulatorPanel({
  environmentId,
  projectCwd,
  onClose,
}: SimulatorPanelProps) {
  const queryClient = useQueryClient();
  const viewportRef = useRef<HTMLCanvasElement | null>(null);
  const gestureRef = useRef<PointerGestureState | null>(null);
  const autoRefreshSignatureRef = useRef<string | null>(null);
  const [requestedDeviceUdid, setRequestedDeviceUdid] = useState<string | null>(null);
  const [runtimeState, setRuntimeState] = useState(createEmptyIosSimulatorRuntimeState);
  const [streamVersion, setStreamVersion] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Aspect ratio (width/height) of the decoded simulator stream. Used to
  // drive the iPhone frame's aspect-ratio so the canvas fills edge-to-edge
  // (no letterbox bars) and the sidebar width hugs the phone exactly.
  const [streamAspect, setStreamAspect] = useState<number | null>(null);

  const simulatorStateQuery = useQuery({
    ...iosSimulatorStateQueryOptions({
      environmentId,
      cwd: projectCwd,
      enabled: projectCwd !== null,
    }),
    refetchInterval: 3_000,
  });

  const simulatorState = simulatorStateQuery.data ?? null;
  const devices = simulatorState?.devices ?? EMPTY_IOS_SIMULATOR_DEVICES;
  const bootedDeviceUdid = simulatorState?.bootedDeviceUdid ?? null;
  const selectedDeviceUdid = resolveSelectedIosSimulatorDeviceUdid({
    devices,
    requestedDeviceUdid,
    bootedDeviceUdid,
    preferredDeviceUdid: simulatorState?.preferredDeviceUdid ?? null,
  });

  const selectedDevice = useMemo(
    () => devices.find((device) => device.udid === selectedDeviceUdid) ?? null,
    [devices, selectedDeviceUdid],
  );
  const selectedRuntimeDevice = readSimulatorPanelRuntimeDevice(runtimeState, selectedDeviceUdid);
  const hasBootedSignal = hasSimulatorBootSignal({
    deviceState: selectedDevice?.state,
    runtimeDevice: selectedRuntimeDevice,
  });
  const frameStale = isSimulatorFrameStale(selectedRuntimeDevice, nowMs);

  const streamUrl =
    selectedDeviceUdid && hasBootedSignal && webCodecsSupported
      ? buildIosSimulatorStreamUrl({
          udid: selectedDeviceUdid,
          cacheKey: `${selectedDeviceUdid}:${streamVersion}`,
        })
      : null;

  const invalidateSimulatorState = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: simulatorQueryKeys.iosState(environmentId, projectCwd),
    });
  }, [environmentId, projectCwd, queryClient]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    setRuntimeState(createEmptyIosSimulatorRuntimeState());
    const unsubscribe = ensureEnvironmentApi(environmentId).simulator.subscribeEvents(
      {},
      (event) => {
        setRuntimeState((current) => reduceSimulatorPanelRuntimeState(current, event));
      },
      {
        onResubscribe: () => {
          void invalidateSimulatorState();
        },
      },
    );
    return unsubscribe;
  }, [environmentId, invalidateSimulatorState]);

  useEffect(() => {
    autoRefreshSignatureRef.current = null;
  }, [selectedDeviceUdid]);

  useEffect(() => {
    const shouldReconnect = shouldAutoReconnectSimulatorStream({
      runtimeDevice: selectedRuntimeDevice,
      nowMs,
    });
    if (!shouldReconnect || !streamUrl || !selectedDeviceUdid) {
      autoRefreshSignatureRef.current = null;
      return;
    }

    const signature = [
      selectedDeviceUdid,
      selectedRuntimeDevice?.frameStatus ?? "idle",
      selectedRuntimeDevice?.lastFrameAt ?? "never",
      String(selectedRuntimeDevice?.frameCount ?? 0),
    ].join(":");
    if (autoRefreshSignatureRef.current === signature) {
      return;
    }

    autoRefreshSignatureRef.current = signature;
    setStreamVersion((current) => current + 1);
    void invalidateSimulatorState();
  }, [invalidateSimulatorState, nowMs, selectedDeviceUdid, selectedRuntimeDevice, streamUrl]);

  useEffect(() => {
    const canvas = viewportRef.current;
    if (!canvas || !streamUrl) {
      return;
    }
    setStreamAspect(null);
    const player = startH264StreamPlayer({
      canvas,
      streamUrl,
      onDimensions: (width, height) => {
        if (width > 0 && height > 0) {
          setStreamAspect(width / height);
        }
      },
      onError: (error) => {
        toastManager.add({
          type: "error",
          title: "Simulator stream failed",
          description: error.message,
        });
        setStreamVersion((current) => current + 1);
        void invalidateSimulatorState();
      },
    });
    return () => player.stop();
  }, [invalidateSimulatorState, streamUrl]);

  const bootMutation = useMutation({
    mutationFn: async (udid: string) =>
      ensureEnvironmentApi(environmentId).simulator.boot({ udid }),
    onSuccess: async (result) => {
      setRequestedDeviceUdid(result.device.udid);
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
        | { kind: "pointer"; phase: "began" | "moved" | "ended"; x: number; y: number }
        | { kind: "type"; text: string }
        | { kind: "press"; key: string }
        | { kind: "home" }
        | { kind: "appSwitcher" },
      options?: { silent?: boolean },
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
        if (!options?.silent) {
          toastManager.add({
            type: "error",
            title: "Simulator input failed",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        void invalidateSimulatorState();
      }
    },
    [environmentId, invalidateSimulatorState, selectedDeviceUdid],
  );

  // Drains the gesture's latest position to the server while the pointer is
  // down. We keep at most one pointer-move RPC in flight so a slow send
  // coalesces every queued frame into the most recent coordinate.
  const flushPointerMove = useCallback(() => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.sendInFlight || gesture.ended || !gesture.pendingPosition) {
      return;
    }
    const position = gesture.pendingPosition;
    gesture.pendingPosition = null;
    gesture.sendInFlight = true;
    void sendInteraction(
      { kind: "pointer", phase: "moved", x: position.x, y: position.y },
      { silent: true },
    ).finally(() => {
      const current = gestureRef.current;
      if (!current || current.pointerId !== gesture.pointerId) {
        return;
      }
      current.sendInFlight = false;
      if (current.pendingPosition && !current.ended) {
        flushPointerMove();
      }
    });
  }, [sendInteraction]);

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      const { x, y } = normalizePointerPosition(target, event.clientX, event.clientY);
      gestureRef.current = {
        pointerId: event.pointerId,
        latestX: x,
        latestY: y,
        sendInFlight: false,
        pendingPosition: null,
        ended: false,
      };
      target.focus();
      void sendInteraction({ kind: "pointer", phase: "began", x, y });
    },
    [sendInteraction],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId || gesture.ended) {
        return;
      }
      const { x, y } = normalizePointerPosition(event.currentTarget, event.clientX, event.clientY);
      gesture.latestX = x;
      gesture.latestY = y;
      gesture.pendingPosition = { x, y };
      // `sendInFlight` already coalesces bursts of pointer events into a
      // single outstanding RPC, so dispatch directly instead of waiting
      // a frame boundary — that was adding up to ~16ms of idle latency
      // per round trip on localhost.
      flushPointerMove();
    },
    [flushPointerMove],
  );

  const endPointerGesture = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId || gesture.ended) {
        return;
      }
      gesture.ended = true;
      const { x, y } = normalizePointerPosition(event.currentTarget, event.clientX, event.clientY);
      gesture.latestX = x;
      gesture.latestY = y;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      gestureRef.current = null;
      void sendInteraction({ kind: "pointer", phase: "ended", x, y });
    },
    [sendInteraction],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLCanvasElement>) => {
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

  const handleHomePress = useCallback(() => {
    void sendInteraction({ kind: "home" });
  }, [sendInteraction]);

  const handleAppSwitcherPress = useCallback(() => {
    void sendInteraction({ kind: "appSwitcher" });
  }, [sendInteraction]);

  const effectiveAspect = streamAspect ?? 9 / 19.5;

  const eligible = Boolean(simulatorState?.supported && simulatorState.isExpoProject);
  const canRenderStream = Boolean(streamUrl);
  const streamOverlayMessage = !canRenderStream
    ? null
    : frameStale || selectedRuntimeDevice?.frameStatus === "live"
      ? null
      : (selectedRuntimeDevice?.lastError ?? "Connecting to the live simulator stream...");
  const canSendHardwareButton = canRenderStream && selectedDeviceUdid !== null;

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-card/50">
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
              setRequestedDeviceUdid(value);
              setStreamVersion((current) => current + 1);
            }}
            disabled={!devices.length}
          >
            <SelectTrigger size="sm" className="min-w-0 flex-1">
              <SelectValue placeholder={devices.length ? "Choose a device" : "No devices found"}>
                {(value) =>
                  devices.find((device) => device.udid === value)?.name ??
                  (devices.length ? "Choose a device" : "No devices found")
                }
              </SelectValue>
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
          <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center gap-4">
            <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center self-stretch">
              <div
                className="relative h-full max-h-full w-auto max-w-full overflow-hidden rounded-[2.5rem] border border-border/60 bg-neutral-950 p-1.5 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.55)] dark:border-white/10"
                style={{ aspectRatio: effectiveAspect }}
              >
                <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[2.05rem] bg-black">
                  {streamOverlayMessage ? (
                    <div className="pointer-events-none absolute inset-x-4 top-4 z-10 flex justify-center">
                      <div className="rounded-full border border-white/10 bg-black/70 px-3 py-1 text-[11px] text-slate-200/85 shadow-lg backdrop-blur">
                        {streamOverlayMessage}
                      </div>
                    </div>
                  ) : null}
                  {canRenderStream ? (
                    <canvas
                      key={streamUrl}
                      ref={viewportRef}
                      aria-label="Live iOS Simulator stream"
                      role="img"
                      className="block h-full w-full select-none outline-none"
                      tabIndex={0}
                      onPointerDown={handlePointerDown}
                      onPointerMove={handlePointerMove}
                      onPointerUp={endPointerGesture}
                      onPointerCancel={endPointerGesture}
                      onKeyDown={handleKeyDown}
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
            </div>

            <div className="flex shrink-0 items-center justify-center gap-2">
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={handleAppSwitcherPress}
                disabled={!canSendHardwareButton}
                aria-label="Open the iOS app switcher"
                className="size-9 rounded-full border border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <LayoutGridIcon className="size-4" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={handleHomePress}
                disabled={!canSendHardwareButton}
                aria-label="Press the iOS home button"
                className="size-9 rounded-full border border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <CircleIcon className="size-4" />
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
});

export default SimulatorPanel;
