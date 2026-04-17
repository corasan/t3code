import { Context } from "effect";
import type { Effect, Stream } from "effect";
import type {
  IosSimulatorBootInput,
  IosSimulatorBootResult,
  IosSimulatorInteractInput,
  IosSimulatorInteractResult,
  IosSimulatorProjectState,
  IosSimulatorProjectStateInput,
  IosSimulatorRuntimeEvent,
  SimulatorError,
} from "@t3tools/contracts";

export interface IosSimulatorShape {
  readonly getProjectState: (
    input: IosSimulatorProjectStateInput,
  ) => Effect.Effect<IosSimulatorProjectState, SimulatorError>;
  readonly boot: (
    input: IosSimulatorBootInput,
  ) => Effect.Effect<IosSimulatorBootResult, SimulatorError>;
  readonly interact: (
    input: IosSimulatorInteractInput,
  ) => Effect.Effect<IosSimulatorInteractResult, SimulatorError>;
  readonly createVideoStream: (input: {
    readonly udid: string;
    readonly intervalMs?: number;
    readonly signal?: AbortSignal;
  }) => Effect.Effect<ReadableStream<Uint8Array>, SimulatorError>;
  readonly streamRuntimeEvents: Stream.Stream<IosSimulatorRuntimeEvent>;
}

export class IosSimulator extends Context.Service<IosSimulator, IosSimulatorShape>()(
  "t3/simulator/Services/IosSimulator",
) {}
