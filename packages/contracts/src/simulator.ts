import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const IosSimulatorDeviceState = Schema.Literals([
  "booted",
  "shutdown",
  "creating",
  "shutting-down",
  "unknown",
]);
export type IosSimulatorDeviceState = typeof IosSimulatorDeviceState.Type;

export const IosSimulatorDevice = Schema.Struct({
  udid: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  runtime: TrimmedNonEmptyString,
  state: IosSimulatorDeviceState,
  isAvailable: Schema.Boolean,
  lastBootedAt: Schema.NullOr(IsoDateTime),
});
export type IosSimulatorDevice = typeof IosSimulatorDevice.Type;

export const IosSimulatorLifecycleState = Schema.Literals([
  "idle",
  "booting",
  "ready",
  "streaming",
  "error",
]);
export type IosSimulatorLifecycleState = typeof IosSimulatorLifecycleState.Type;

export const IosSimulatorReadinessSource = Schema.Literals(["interaction", "stream"]);
export type IosSimulatorReadinessSource = typeof IosSimulatorReadinessSource.Type;

export const IosSimulatorFrameStatus = Schema.Literals([
  "idle",
  "connecting",
  "live",
  "closed",
  "error",
]);
export type IosSimulatorFrameStatus = typeof IosSimulatorFrameStatus.Type;

export const IosSimulatorInputStatus = Schema.Literals([
  "idle",
  "dispatching",
  "succeeded",
  "failed",
]);
export type IosSimulatorInputStatus = typeof IosSimulatorInputStatus.Type;

export const IosSimulatorLogLevel = Schema.Literals(["info", "warn", "error"]);
export type IosSimulatorLogLevel = typeof IosSimulatorLogLevel.Type;

export const IosSimulatorLogSource = Schema.Literals([
  "service",
  "interaction-bridge",
  "stream-bridge",
]);
export type IosSimulatorLogSource = typeof IosSimulatorLogSource.Type;

export const IosSimulatorProjectStateInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type IosSimulatorProjectStateInput = typeof IosSimulatorProjectStateInput.Type;

export const IosSimulatorProjectState = Schema.Struct({
  supported: Schema.Boolean,
  supportReason: Schema.NullOr(TrimmedNonEmptyString),
  isExpoProject: Schema.Boolean,
  devices: Schema.Array(IosSimulatorDevice),
  bootedDeviceUdid: Schema.NullOr(TrimmedNonEmptyString),
  preferredDeviceUdid: Schema.NullOr(TrimmedNonEmptyString),
});
export type IosSimulatorProjectState = typeof IosSimulatorProjectState.Type;

export const IosSimulatorBootInput = Schema.Struct({
  udid: TrimmedNonEmptyString,
});
export type IosSimulatorBootInput = typeof IosSimulatorBootInput.Type;

export const IosSimulatorBootResult = Schema.Struct({
  device: IosSimulatorDevice,
});
export type IosSimulatorBootResult = typeof IosSimulatorBootResult.Type;

const NormalizedPointerCoordinate = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);

const IosSimulatorPointerTapInput = Schema.Struct({
  kind: Schema.Literal("tap"),
  udid: TrimmedNonEmptyString,
  x: NormalizedPointerCoordinate,
  y: NormalizedPointerCoordinate,
});

const IosSimulatorPointerDragInput = Schema.Struct({
  kind: Schema.Literal("drag"),
  udid: TrimmedNonEmptyString,
  fromX: NormalizedPointerCoordinate,
  fromY: NormalizedPointerCoordinate,
  toX: NormalizedPointerCoordinate,
  toY: NormalizedPointerCoordinate,
});

export const IosSimulatorPointerPhase = Schema.Literals(["began", "moved", "ended"]);
export type IosSimulatorPointerPhase = typeof IosSimulatorPointerPhase.Type;

const IosSimulatorPointerStreamInput = Schema.Struct({
  kind: Schema.Literal("pointer"),
  udid: TrimmedNonEmptyString,
  phase: IosSimulatorPointerPhase,
  x: NormalizedPointerCoordinate,
  y: NormalizedPointerCoordinate,
});

const IosSimulatorTypeTextInput = Schema.Struct({
  kind: Schema.Literal("type"),
  udid: TrimmedNonEmptyString,
  text: Schema.String,
});

const IosSimulatorPressKeyInput = Schema.Struct({
  kind: Schema.Literal("press"),
  udid: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString,
});

const IosSimulatorHomeButtonInput = Schema.Struct({
  kind: Schema.Literal("home"),
  udid: TrimmedNonEmptyString,
});

const IosSimulatorAppSwitcherInput = Schema.Struct({
  kind: Schema.Literal("appSwitcher"),
  udid: TrimmedNonEmptyString,
});

export const IosSimulatorInputKind = Schema.Literals([
  "tap",
  "drag",
  "pointer",
  "type",
  "press",
  "home",
  "appSwitcher",
]);
export type IosSimulatorInputKind = typeof IosSimulatorInputKind.Type;

export const IosSimulatorInteractInput = Schema.Union([
  IosSimulatorPointerTapInput,
  IosSimulatorPointerDragInput,
  IosSimulatorPointerStreamInput,
  IosSimulatorTypeTextInput,
  IosSimulatorPressKeyInput,
  IosSimulatorHomeButtonInput,
  IosSimulatorAppSwitcherInput,
]);
export type IosSimulatorInteractInput = typeof IosSimulatorInteractInput.Type;

export const IosSimulatorInteractResult = Schema.Struct({
  ok: Schema.Boolean,
});
export type IosSimulatorInteractResult = typeof IosSimulatorInteractResult.Type;

export const IosSimulatorSubscribeEventsInput = Schema.Struct({});
export type IosSimulatorSubscribeEventsInput = typeof IosSimulatorSubscribeEventsInput.Type;

export const IosSimulatorRuntimeLogEntry = Schema.Struct({
  sequence: NonNegativeInt,
  createdAt: IsoDateTime,
  level: IosSimulatorLogLevel,
  source: IosSimulatorLogSource,
  udid: Schema.NullOr(TrimmedNonEmptyString),
  message: TrimmedNonEmptyString,
});
export type IosSimulatorRuntimeLogEntry = typeof IosSimulatorRuntimeLogEntry.Type;

export const IosSimulatorRuntimeDeviceSnapshot = Schema.Struct({
  udid: TrimmedNonEmptyString,
  lifecycleState: IosSimulatorLifecycleState,
  interactionReady: Schema.Boolean,
  streamReady: Schema.Boolean,
  frameStatus: IosSimulatorFrameStatus,
  viewerCount: NonNegativeInt,
  frameCount: NonNegativeInt,
  firstFrameAt: Schema.NullOr(IsoDateTime),
  lastFrameAt: Schema.NullOr(IsoDateTime),
  inputStatus: IosSimulatorInputStatus,
  lastInputKind: Schema.NullOr(IosSimulatorInputKind),
  lastInputAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
});
export type IosSimulatorRuntimeDeviceSnapshot = typeof IosSimulatorRuntimeDeviceSnapshot.Type;

export const IosSimulatorRuntimeSnapshot = Schema.Struct({
  devices: Schema.Array(IosSimulatorRuntimeDeviceSnapshot),
  logs: Schema.Array(IosSimulatorRuntimeLogEntry),
});
export type IosSimulatorRuntimeSnapshot = typeof IosSimulatorRuntimeSnapshot.Type;

const IosSimulatorRuntimeEventBase = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const IosSimulatorRuntimeSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("snapshot"),
  snapshot: IosSimulatorRuntimeSnapshot,
});
export type IosSimulatorRuntimeSnapshotEvent = typeof IosSimulatorRuntimeSnapshotEvent.Type;

export const IosSimulatorRuntimeLifecycleEvent = Schema.Struct({
  ...IosSimulatorRuntimeEventBase.fields,
  type: Schema.Literal("lifecycle"),
  payload: Schema.Struct({
    udid: TrimmedNonEmptyString,
    state: IosSimulatorLifecycleState,
    detail: Schema.NullOr(TrimmedNonEmptyString),
  }),
});
export type IosSimulatorRuntimeLifecycleEvent = typeof IosSimulatorRuntimeLifecycleEvent.Type;

export const IosSimulatorRuntimeLogEvent = Schema.Struct({
  ...IosSimulatorRuntimeEventBase.fields,
  type: Schema.Literal("log"),
  payload: IosSimulatorRuntimeLogEntry,
});
export type IosSimulatorRuntimeLogEvent = typeof IosSimulatorRuntimeLogEvent.Type;

export const IosSimulatorRuntimeReadinessEvent = Schema.Struct({
  ...IosSimulatorRuntimeEventBase.fields,
  type: Schema.Literal("readiness"),
  payload: Schema.Struct({
    udid: TrimmedNonEmptyString,
    source: IosSimulatorReadinessSource,
    ready: Schema.Boolean,
    reason: Schema.NullOr(TrimmedNonEmptyString),
  }),
});
export type IosSimulatorRuntimeReadinessEvent = typeof IosSimulatorRuntimeReadinessEvent.Type;

export const IosSimulatorRuntimeFrameStateEvent = Schema.Struct({
  ...IosSimulatorRuntimeEventBase.fields,
  type: Schema.Literal("frameState"),
  payload: Schema.Struct({
    udid: TrimmedNonEmptyString,
    status: IosSimulatorFrameStatus,
    viewerCount: NonNegativeInt,
    frameCount: NonNegativeInt,
    firstFrameAt: Schema.NullOr(IsoDateTime),
    lastFrameAt: Schema.NullOr(IsoDateTime),
    reason: Schema.NullOr(TrimmedNonEmptyString),
  }),
});
export type IosSimulatorRuntimeFrameStateEvent = typeof IosSimulatorRuntimeFrameStateEvent.Type;

export const IosSimulatorRuntimeInputStateEvent = Schema.Struct({
  ...IosSimulatorRuntimeEventBase.fields,
  type: Schema.Literal("inputState"),
  payload: Schema.Struct({
    udid: TrimmedNonEmptyString,
    inputKind: IosSimulatorInputKind,
    status: IosSimulatorInputStatus,
    message: Schema.NullOr(TrimmedNonEmptyString),
  }),
});
export type IosSimulatorRuntimeInputStateEvent = typeof IosSimulatorRuntimeInputStateEvent.Type;

export const IosSimulatorRuntimeEvent = Schema.Union([
  IosSimulatorRuntimeSnapshotEvent,
  IosSimulatorRuntimeLifecycleEvent,
  IosSimulatorRuntimeLogEvent,
  IosSimulatorRuntimeReadinessEvent,
  IosSimulatorRuntimeFrameStateEvent,
  IosSimulatorRuntimeInputStateEvent,
]);
export type IosSimulatorRuntimeEvent = typeof IosSimulatorRuntimeEvent.Type;

export class SimulatorError extends Schema.TaggedErrorClass<SimulatorError>()("SimulatorError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}
