import { Schema } from "effect";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

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

export const IosSimulatorInteractInput = Schema.Union([
  IosSimulatorPointerTapInput,
  IosSimulatorPointerDragInput,
  IosSimulatorTypeTextInput,
  IosSimulatorPressKeyInput,
]);
export type IosSimulatorInteractInput = typeof IosSimulatorInteractInput.Type;

export const IosSimulatorInteractResult = Schema.Struct({
  ok: Schema.Boolean,
});
export type IosSimulatorInteractResult = typeof IosSimulatorInteractResult.Type;

export class SimulatorError extends Schema.TaggedErrorClass<SimulatorError>()("SimulatorError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}
