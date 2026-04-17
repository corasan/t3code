import type {
  IosSimulatorRuntimeDeviceSnapshot,
  IosSimulatorRuntimeEvent,
  IosSimulatorRuntimeLogEntry,
  IosSimulatorRuntimeSnapshot,
} from "@t3tools/contracts";

export const MAX_IOS_SIMULATOR_RUNTIME_LOG_ENTRIES = 80;

export interface IosSimulatorRuntimeState {
  readonly devices: Readonly<Record<string, IosSimulatorRuntimeDeviceSnapshot>>;
  readonly logs: ReadonlyArray<IosSimulatorRuntimeLogEntry>;
}

export function createEmptyIosSimulatorRuntimeDeviceSnapshot(
  udid: string,
): IosSimulatorRuntimeDeviceSnapshot {
  return {
    udid,
    lifecycleState: "idle",
    interactionReady: false,
    streamReady: false,
    frameStatus: "idle",
    viewerCount: 0,
    frameCount: 0,
    firstFrameAt: null,
    lastFrameAt: null,
    inputStatus: "idle",
    lastInputKind: null,
    lastInputAt: null,
    lastError: null,
  };
}

export function createEmptyIosSimulatorRuntimeState(): IosSimulatorRuntimeState {
  return {
    devices: {},
    logs: [],
  };
}

export function createIosSimulatorRuntimeStateFromSnapshot(
  snapshot: IosSimulatorRuntimeSnapshot,
): IosSimulatorRuntimeState {
  return {
    devices: Object.fromEntries(snapshot.devices.map((device) => [device.udid, device])),
    logs: [...snapshot.logs],
  };
}

export function createIosSimulatorRuntimeSnapshot(
  state: IosSimulatorRuntimeState,
): IosSimulatorRuntimeSnapshot {
  return {
    devices: Object.values(state.devices).toSorted((left, right) =>
      left.udid.localeCompare(right.udid),
    ),
    logs: [...state.logs],
  };
}

export function readIosSimulatorRuntimeDeviceSnapshot(
  state: IosSimulatorRuntimeState,
  udid: string | null | undefined,
): IosSimulatorRuntimeDeviceSnapshot | null {
  if (!udid) {
    return null;
  }
  return state.devices[udid] ?? null;
}

function updateIosSimulatorRuntimeDevice(
  state: IosSimulatorRuntimeState,
  udid: string,
  update: (device: IosSimulatorRuntimeDeviceSnapshot) => IosSimulatorRuntimeDeviceSnapshot,
): IosSimulatorRuntimeState {
  const existing = state.devices[udid] ?? createEmptyIosSimulatorRuntimeDeviceSnapshot(udid);
  return {
    ...state,
    devices: {
      ...state.devices,
      [udid]: update(existing),
    },
  };
}

function applyIosSimulatorRuntimeLiveEvent(
  state: IosSimulatorRuntimeState,
  event: Exclude<IosSimulatorRuntimeEvent, { type: "snapshot" }>,
): IosSimulatorRuntimeState {
  switch (event.type) {
    case "log":
      return {
        ...state,
        logs: [...state.logs, event.payload].slice(-MAX_IOS_SIMULATOR_RUNTIME_LOG_ENTRIES),
      };
    case "lifecycle":
      return updateIosSimulatorRuntimeDevice(state, event.payload.udid, (existing) => ({
        ...existing,
        lifecycleState: event.payload.state,
        lastError:
          event.payload.state === "error"
            ? (event.payload.detail ?? existing.lastError)
            : existing.lastError,
      }));
    case "readiness":
      return updateIosSimulatorRuntimeDevice(state, event.payload.udid, (existing) => ({
        ...existing,
        interactionReady:
          event.payload.source === "interaction" ? event.payload.ready : existing.interactionReady,
        streamReady: event.payload.source === "stream" ? event.payload.ready : existing.streamReady,
        lastError:
          !event.payload.ready && event.payload.reason ? event.payload.reason : existing.lastError,
      }));
    case "frameState":
      return updateIosSimulatorRuntimeDevice(state, event.payload.udid, (existing) => ({
        ...existing,
        lifecycleState:
          event.payload.status === "live"
            ? "streaming"
            : event.payload.status === "error"
              ? "error"
              : event.payload.viewerCount > 0
                ? existing.lifecycleState
                : existing.interactionReady
                  ? "ready"
                  : "idle",
        streamReady:
          event.payload.status === "live"
            ? true
            : event.payload.viewerCount > 0
              ? existing.streamReady
              : false,
        frameStatus: event.payload.status,
        viewerCount: event.payload.viewerCount,
        frameCount: event.payload.frameCount,
        firstFrameAt: event.payload.firstFrameAt,
        lastFrameAt: event.payload.lastFrameAt,
        lastError:
          event.payload.status === "error"
            ? (event.payload.reason ?? existing.lastError)
            : existing.lastError,
      }));
    case "inputState":
      return updateIosSimulatorRuntimeDevice(state, event.payload.udid, (existing) => ({
        ...existing,
        inputStatus: event.payload.status,
        lastInputKind: event.payload.inputKind,
        lastInputAt: event.createdAt,
        lastError:
          event.payload.status === "failed"
            ? (event.payload.message ?? existing.lastError)
            : existing.lastError,
      }));
  }
}

export function applyIosSimulatorRuntimeEvent(
  state: IosSimulatorRuntimeState,
  event: IosSimulatorRuntimeEvent,
): IosSimulatorRuntimeState {
  if (event.type === "snapshot") {
    return createIosSimulatorRuntimeStateFromSnapshot(event.snapshot);
  }
  return applyIosSimulatorRuntimeLiveEvent(state, event);
}
