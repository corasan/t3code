import { Context } from "effect";
import type { Effect } from "effect";
import type {
  IosSimulatorBootInput,
  IosSimulatorBootResult,
  IosSimulatorInteractInput,
  IosSimulatorInteractResult,
  IosSimulatorProjectState,
  IosSimulatorProjectStateInput,
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
  readonly createMjpegStream: (input: {
    readonly udid: string;
    readonly intervalMs?: number;
  }) => Effect.Effect<ReadableStream<Uint8Array>, SimulatorError>;
}

export class IosSimulator extends Context.Service<IosSimulator, IosSimulatorShape>()(
  "t3/simulator/Services/IosSimulator",
) {}
