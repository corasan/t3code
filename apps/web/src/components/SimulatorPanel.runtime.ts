import type {
  IosSimulatorDeviceState,
  IosSimulatorRuntimeDeviceSnapshot,
  IosSimulatorRuntimeEvent,
  IosSimulatorRuntimeLogEntry,
} from "@t3tools/contracts";
import {
  applyIosSimulatorRuntimeEvent,
  createEmptyIosSimulatorRuntimeState,
  readIosSimulatorRuntimeDeviceSnapshot,
  type IosSimulatorRuntimeState,
} from "@t3tools/shared/simulatorRuntime";

const STALE_SIMULATOR_FRAME_MS = 4_000;
const DEFAULT_SIMULATOR_LOG_TAIL_LIMIT = 6;

export type SimulatorPanelRuntimeState = IosSimulatorRuntimeState;

export function createEmptySimulatorPanelRuntimeState(): SimulatorPanelRuntimeState {
  return createEmptyIosSimulatorRuntimeState();
}

export function reduceSimulatorPanelRuntimeState(
  state: SimulatorPanelRuntimeState,
  event: IosSimulatorRuntimeEvent,
): SimulatorPanelRuntimeState {
  return applyIosSimulatorRuntimeEvent(state, event);
}

export function readSimulatorPanelRuntimeDevice(
  state: SimulatorPanelRuntimeState,
  udid: string | null | undefined,
): IosSimulatorRuntimeDeviceSnapshot | null {
  return readIosSimulatorRuntimeDeviceSnapshot(state, udid);
}

export function getSimulatorPanelLogTail(
  state: SimulatorPanelRuntimeState,
  udid: string | null | undefined,
  limit: number = DEFAULT_SIMULATOR_LOG_TAIL_LIMIT,
): ReadonlyArray<IosSimulatorRuntimeLogEntry> {
  const visibleLogs = state.logs.filter(
    (entry) => !udid || entry.udid === null || entry.udid === udid,
  );
  return visibleLogs.slice(-limit);
}

export function hasSimulatorBootSignal(input: {
  readonly deviceState: IosSimulatorDeviceState | null | undefined;
  readonly runtimeDevice: IosSimulatorRuntimeDeviceSnapshot | null;
}): boolean {
  if (input.deviceState === "booted") {
    return true;
  }

  const runtimeDevice = input.runtimeDevice;
  if (!runtimeDevice) {
    return false;
  }

  return (
    runtimeDevice.interactionReady ||
    runtimeDevice.streamReady ||
    runtimeDevice.lifecycleState === "ready" ||
    runtimeDevice.lifecycleState === "streaming" ||
    runtimeDevice.frameStatus === "connecting" ||
    runtimeDevice.frameStatus === "live"
  );
}

export function isSimulatorFrameStale(
  runtimeDevice: IosSimulatorRuntimeDeviceSnapshot | null,
  nowMs: number = Date.now(),
): boolean {
  if (!runtimeDevice || runtimeDevice.frameStatus !== "live" || !runtimeDevice.lastFrameAt) {
    return false;
  }
  const lastFrameMs = Date.parse(runtimeDevice.lastFrameAt);
  return Number.isFinite(lastFrameMs) && nowMs - lastFrameMs >= STALE_SIMULATOR_FRAME_MS;
}

export function shouldAutoReconnectSimulatorStream(input: {
  readonly runtimeDevice: IosSimulatorRuntimeDeviceSnapshot | null;
  readonly nowMs?: number;
}): boolean {
  void input.nowMs;
  const runtimeDevice = input.runtimeDevice;
  if (!runtimeDevice) {
    return false;
  }

  if (runtimeDevice.frameStatus === "error") {
    return true;
  }

  if (runtimeDevice.frameStatus === "closed" && runtimeDevice.interactionReady) {
    return true;
  }

  return false;
}
