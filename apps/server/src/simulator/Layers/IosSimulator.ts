import { mkdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  type IosSimulatorBootResult,
  type IosSimulatorDevice,
  type IosSimulatorDeviceState,
  type IosSimulatorInputKind,
  type IosSimulatorInteractResult,
  type IosSimulatorRuntimeDeviceSnapshot,
  type IosSimulatorRuntimeEvent,
  type IosSimulatorRuntimeLogEntry,
  SimulatorError,
} from "@t3tools/contracts";
import { isCommandAvailable } from "@t3tools/shared/shell";
import {
  applyIosSimulatorRuntimeEvent,
  createEmptyIosSimulatorRuntimeState,
  createIosSimulatorRuntimeSnapshot,
  type IosSimulatorRuntimeState,
} from "@t3tools/shared/simulatorRuntime";
import { Effect, Layer, PubSub, Ref, Schema, Stream } from "effect";

import { runProcess } from "../../processRunner.ts";
import { IosSimulator, type IosSimulatorShape } from "../Services/IosSimulator.ts";

const DEFAULT_STREAM_FPS = 60;
const EXPO_CONFIG_CANDIDATES = [
  "app.json",
  "app.config.js",
  "app.config.cjs",
  "app.config.mjs",
  "app.config.ts",
] as const;
const IPHONE_NAME_RE = /\biphone\b/i;
const IOS_RUNTIME_RE = /\bios\b/i;
const SIMULATOR_BRIDGE_SOURCE_PATH = fileURLToPath(
  new URL("../bin/SimulatorBridge.swift", import.meta.url),
);
const SIMULATOR_BRIDGE_BINARY_NAME = "t3code-simulator-device-bridge-v5";
const FRAME_STATE_HEARTBEAT_MS = 1_000;
const INITIAL_STREAM_FRAME_TIMEOUT_MS = 10_000;
const STREAM_STALL_TIMEOUT_MS = 5_000;

interface SimctlListDevicesResponse {
  readonly devices?: Record<string, ReadonlyArray<SimctlDeviceJson>>;
}

interface SimctlDeviceJson {
  readonly udid?: string;
  readonly name?: string;
  readonly state?: string;
  readonly isAvailable?: boolean;
  readonly lastBootedAt?: string;
}

interface SimulatorBridgeResponse {
  readonly id: number | null;
  readonly type: "ready" | "response";
  readonly ok: boolean;
  readonly error: string | null;
}

interface SimulatorInteractionDaemon {
  readonly child: ReturnType<typeof spawn>;
  readonly output: readline.Interface;
  readonly send: (command: {
    readonly kind: "tap" | "drag" | "pointer" | "type" | "press";
    readonly phase?: "began" | "moved" | "ended";
    readonly x?: number;
    readonly y?: number;
    readonly fromX?: number;
    readonly fromY?: number;
    readonly toX?: number;
    readonly toY?: number;
    readonly text?: string;
    readonly key?: string;
  }) => Promise<void>;
  readonly close: () => void;
}

interface SimulatorRuntimeState {
  readonly sequence: number;
  readonly runtime: IosSimulatorRuntimeState;
}

interface StreamRuntimeState {
  viewerCount: number;
  liveViewerCount: number;
  frameCount: number;
  firstFrameAt: string | null;
  lastFrameAt: string | null;
  status: "idle" | "connecting" | "live" | "closed" | "error";
}

interface SimulatorRuntimeEvents {
  readonly lifecycle: (input: {
    readonly udid: string;
    readonly state: IosSimulatorRuntimeDeviceSnapshot["lifecycleState"];
    readonly detail?: string | null;
  }) => void;
  readonly log: (input: {
    readonly level: IosSimulatorRuntimeLogEntry["level"];
    readonly source: IosSimulatorRuntimeLogEntry["source"];
    readonly message: string;
    readonly udid?: string | null;
  }) => void;
  readonly readiness: (input: {
    readonly udid: string;
    readonly source: "interaction" | "stream";
    readonly ready: boolean;
    readonly reason?: string | null;
  }) => void;
  readonly frameState: (input: {
    readonly udid: string;
    readonly status: StreamRuntimeState["status"];
    readonly viewerCount: number;
    readonly frameCount: number;
    readonly firstFrameAt: string | null;
    readonly lastFrameAt: string | null;
    readonly reason?: string | null;
  }) => void;
  readonly inputState: (input: {
    readonly udid: string;
    readonly inputKind: IosSimulatorInputKind;
    readonly status: IosSimulatorRuntimeDeviceSnapshot["inputStatus"];
    readonly message?: string | null;
  }) => void;
  readonly stream: Stream.Stream<IosSimulatorRuntimeEvent>;
}

let simulatorBridgeBinaryPathPromise: Promise<string> | null = null;

function createSimulatorError(message: string, cause?: unknown): SimulatorError {
  return new SimulatorError(cause === undefined ? { message } : { message, cause });
}

const isSimulatorError = Schema.is(SimulatorError);

function normalizeSimulatorEventMessage(message: string | null | undefined): string | null {
  const normalized = message?.trim();
  return normalized ? normalized : null;
}

function makeSimulatorRuntimeEventBus(): Effect.Effect<SimulatorRuntimeEvents> {
  return Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const runSync = Effect.runSyncWith(context);
    const pubsub = yield* PubSub.unbounded<IosSimulatorRuntimeEvent>();
    const stateRef = yield* Ref.make<SimulatorRuntimeState>({
      sequence: 0,
      runtime: createEmptyIosSimulatorRuntimeState(),
    });

    const publish = (
      makeEvent: (input: {
        readonly sequence: number;
        readonly createdAt: string;
      }) => Exclude<IosSimulatorRuntimeEvent, { type: "snapshot" }>,
    ) =>
      Ref.modify(stateRef, (current) => {
        const nextSequence = current.sequence + 1;
        const createdAt = new Date().toISOString();
        const event = makeEvent({ sequence: nextSequence, createdAt });
        return [
          event,
          {
            sequence: nextSequence,
            runtime: applyIosSimulatorRuntimeEvent(current.runtime, event),
          },
        ] as const;
      }).pipe(Effect.tap((event) => PubSub.publish(pubsub, event)));

    const runPublish = (
      makeEvent: (input: {
        readonly sequence: number;
        readonly createdAt: string;
      }) => Exclude<IosSimulatorRuntimeEvent, { type: "snapshot" }>,
    ) => {
      runSync(publish(makeEvent));
    };

    return {
      lifecycle: ({ udid, state, detail }) => {
        runPublish(({ sequence, createdAt }) => ({
          version: 1,
          sequence,
          createdAt,
          type: "lifecycle",
          payload: {
            udid,
            state,
            detail: normalizeSimulatorEventMessage(detail) ?? null,
          },
        }));
      },
      log: ({ level, source, message, udid }) => {
        const normalizedMessage = normalizeSimulatorEventMessage(message);
        if (!normalizedMessage) {
          return;
        }
        runPublish(({ sequence, createdAt }) => ({
          version: 1,
          sequence,
          createdAt,
          type: "log",
          payload: {
            sequence,
            createdAt,
            level,
            source,
            udid: udid ?? null,
            message: normalizedMessage,
          },
        }));
      },
      readiness: ({ udid, source, ready, reason }) => {
        runPublish(({ sequence, createdAt }) => ({
          version: 1,
          sequence,
          createdAt,
          type: "readiness",
          payload: {
            udid,
            source,
            ready,
            reason: normalizeSimulatorEventMessage(reason) ?? null,
          },
        }));
      },
      frameState: ({
        udid,
        status,
        viewerCount,
        frameCount,
        firstFrameAt,
        lastFrameAt,
        reason,
      }) => {
        runPublish(({ sequence, createdAt }) => ({
          version: 1,
          sequence,
          createdAt,
          type: "frameState",
          payload: {
            udid,
            status,
            viewerCount,
            frameCount,
            firstFrameAt,
            lastFrameAt,
            reason: normalizeSimulatorEventMessage(reason) ?? null,
          },
        }));
      },
      inputState: ({ udid, inputKind, status, message }) => {
        runPublish(({ sequence, createdAt }) => ({
          version: 1,
          sequence,
          createdAt,
          type: "inputState",
          payload: {
            udid,
            inputKind,
            status,
            message: normalizeSimulatorEventMessage(message) ?? null,
          },
        }));
      },
      stream: Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(pubsub);
          const current = yield* Ref.get(stateRef);
          return Stream.concat(
            Stream.make({
              version: 1 as const,
              sequence: current.sequence,
              type: "snapshot" as const,
              snapshot: createIosSimulatorRuntimeSnapshot(current.runtime),
            }),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((event) => event.sequence > current.sequence),
            ),
          );
        }),
      ),
    } satisfies SimulatorRuntimeEvents;
  });
}

function formatRuntimeIdentifier(identifier: string): string {
  const raw = identifier.split("SimRuntime.")[1] ?? identifier;
  return raw
    .replace(/^iOS-/, "iOS ")
    .replace(/^tvOS-/, "tvOS ")
    .replace(/^watchOS-/, "watchOS ")
    .replace(/-/g, ".");
}

export function normalizeIosSimulatorDeviceState(raw: string | undefined): IosSimulatorDeviceState {
  switch (raw?.trim().toLowerCase()) {
    case "booted":
      return "booted";
    case "shutdown":
      return "shutdown";
    case "creating":
      return "creating";
    case "shutting down":
      return "shutting-down";
    default:
      return "unknown";
  }
}

export function selectPreferredIosSimulatorDevice(
  devices: ReadonlyArray<IosSimulatorDevice>,
): IosSimulatorDevice | null {
  if (devices.length === 0) {
    return null;
  }

  const score = (device: IosSimulatorDevice) => {
    const isBooted = device.state === "booted";
    const isIphone = IPHONE_NAME_RE.test(device.name);
    const lastBootedAt = device.lastBootedAt ? Date.parse(device.lastBootedAt) : Number.NaN;
    const sortableLastBootedAt = Number.isFinite(lastBootedAt) ? lastBootedAt : 0;
    return [isBooted ? 1 : 0, isIphone ? 1 : 0, sortableLastBootedAt, device.name] as const;
  };

  return devices.toSorted((left, right) => {
    const leftScore = score(left);
    const rightScore = score(right);
    return (
      rightScore[0] - leftScore[0] ||
      rightScore[1] - leftScore[1] ||
      rightScore[2] - leftScore[2] ||
      leftScore[3].localeCompare(rightScore[3])
    );
  })[0]!;
}

async function resolveSimulatorBridgeBinaryPath(): Promise<string> {
  if (simulatorBridgeBinaryPathPromise) {
    return simulatorBridgeBinaryPathPromise;
  }

  simulatorBridgeBinaryPathPromise = (async () => {
    const directory = path.join(os.tmpdir(), "t3code-simulator");
    const binaryPath = path.join(directory, SIMULATOR_BRIDGE_BINARY_NAME);
    await mkdir(directory, { recursive: true });

    let needsRebuild = true;
    try {
      const [sourceStat, binaryStat] = await Promise.all([
        stat(SIMULATOR_BRIDGE_SOURCE_PATH),
        stat(binaryPath),
      ]);
      needsRebuild = binaryStat.mtimeMs < sourceStat.mtimeMs;
    } catch {
      needsRebuild = true;
    }

    if (needsRebuild) {
      await runProcess(
        "swiftc",
        [
          "-O",
          "-framework",
          "CoreGraphics",
          "-framework",
          "CoreMedia",
          "-framework",
          "CoreVideo",
          "-framework",
          "IOSurface",
          "-framework",
          "VideoToolbox",
          SIMULATOR_BRIDGE_SOURCE_PATH,
          "-o",
          binaryPath,
        ],
        {
          timeoutMs: 120_000,
        },
      );
    }

    return binaryPath;
  })().catch((error) => {
    simulatorBridgeBinaryPathPromise = null;
    throw error;
  });

  return simulatorBridgeBinaryPathPromise;
}

async function createInteractionDaemon(
  udid: string,
  runtimeEvents: SimulatorRuntimeEvents,
  daemonPromises: Map<string, Promise<SimulatorInteractionDaemon>>,
): Promise<SimulatorInteractionDaemon> {
  const binaryPath = await resolveSimulatorBridgeBinaryPath();
  runtimeEvents.log({
    level: "info",
    source: "service",
    udid,
    message: `Starting simulator interaction bridge for ${udid}.`,
  });
  runtimeEvents.readiness({
    udid,
    source: "interaction",
    ready: false,
    reason: "Starting simulator interaction bridge.",
  });
  const child = spawn(binaryPath, ["serve", udid], {
    stdio: "pipe",
  });
  const output = readline.createInterface({ input: child.stdout });
  const pendingRequests = new Map<
    number,
    {
      readonly resolve: () => void;
      readonly reject: (error: Error) => void;
      readonly timeout: ReturnType<typeof setTimeout>;
    }
  >();
  let nextRequestId = 1;
  let stderr = "";
  let ready = false;

  const readyPromise = new Promise<void>((resolve, reject) => {
    const rejectReady = (message: string) => {
      reject(new Error(message));
    };

    child.once("error", (error) => {
      runtimeEvents.log({
        level: "error",
        source: "interaction-bridge",
        udid,
        message: `Failed to start simulator interaction bridge: ${error.message}`,
      });
      rejectReady(`Failed to start the simulator interaction bridge: ${error.message}`);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      runtimeEvents.log({
        level: "warn",
        source: "interaction-bridge",
        udid,
        message: text,
      });
    });

    output.on("line", (line) => {
      let message: SimulatorBridgeResponse;
      try {
        message = JSON.parse(line) as SimulatorBridgeResponse;
      } catch {
        return;
      }

      if (message.type === "ready") {
        if (!message.ok) {
          runtimeEvents.readiness({
            udid,
            source: "interaction",
            ready: false,
            reason: message.error,
          });
          runtimeEvents.lifecycle({
            udid,
            state: "error",
            detail: message.error,
          });
          rejectReady(message.error ?? "The simulator interaction bridge failed to become ready.");
          return;
        }
        ready = true;
        runtimeEvents.readiness({
          udid,
          source: "interaction",
          ready: true,
        });
        runtimeEvents.lifecycle({
          udid,
          state: "ready",
        });
        runtimeEvents.log({
          level: "info",
          source: "interaction-bridge",
          udid,
          message: `Simulator interaction bridge ready for ${udid}.`,
        });
        resolve();
        return;
      }

      if (message.type !== "response" || message.id === null) {
        return;
      }

      const pendingRequest = pendingRequests.get(message.id);
      if (!pendingRequest) {
        return;
      }
      pendingRequests.delete(message.id);
      clearTimeout(pendingRequest.timeout);
      if (message.ok) {
        pendingRequest.resolve();
        return;
      }
      pendingRequest.reject(
        new Error(message.error ?? "The simulator interaction bridge rejected the request."),
      );
    });

    child.once("close", (code) => {
      const detail = stderr.trim() || `exit code ${code ?? "null"}`;
      if (!ready) {
        runtimeEvents.readiness({
          udid,
          source: "interaction",
          ready: false,
          reason: detail,
        });
        runtimeEvents.lifecycle({
          udid,
          state: "error",
          detail,
        });
        rejectReady(`The simulator interaction bridge exited before readiness: ${detail}`);
      }
      if (ready) {
        runtimeEvents.readiness({
          udid,
          source: "interaction",
          ready: false,
          reason: detail,
        });
        runtimeEvents.lifecycle({
          udid,
          state: "error",
          detail,
        });
      }
      runtimeEvents.log({
        level: code === 0 ? "info" : "error",
        source: "interaction-bridge",
        udid,
        message:
          code === 0
            ? `Simulator interaction bridge exited for ${udid}.`
            : `Simulator interaction bridge stopped unexpectedly: ${detail}`,
      });
      for (const request of pendingRequests.values()) {
        clearTimeout(request.timeout);
        request.reject(
          new Error(`The simulator interaction bridge stopped unexpectedly: ${detail}`),
        );
      }
      pendingRequests.clear();
      output.close();
      daemonPromises.delete(udid);
    });
  });

  await readyPromise;

  return {
    child,
    output,
    send(command) {
      const id = nextRequestId++;
      const payload = JSON.stringify({ id, ...command });
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingRequests.delete(id);
          reject(new Error("The simulator interaction bridge timed out."));
        }, 5_000);
        pendingRequests.set(id, { resolve, reject, timeout });
        child.stdin.write(`${payload}\n`, (error) => {
          if (!error) {
            return;
          }
          clearTimeout(timeout);
          pendingRequests.delete(id);
          reject(
            new Error(`Failed to write to the simulator interaction bridge: ${error.message}`),
          );
        });
      });
    },
    close() {
      output.close();
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    },
  };
}

async function ensureInteractionDaemon(
  udid: string,
  runtimeEvents: SimulatorRuntimeEvents,
  daemonPromises: Map<string, Promise<SimulatorInteractionDaemon>>,
): Promise<SimulatorInteractionDaemon> {
  const existing = daemonPromises.get(udid);
  if (existing) {
    return await existing;
  }

  const created = createInteractionDaemon(udid, runtimeEvents, daemonPromises).catch((error) => {
    daemonPromises.delete(udid);
    throw error;
  });
  daemonPromises.set(udid, created);
  return await created;
}

function isExpectedSimctlBootError(stderr: string): boolean {
  return /current state:\s*booted|already booted/i.test(stderr);
}

async function readPackageJson(cwd: string): Promise<Record<string, unknown> | null> {
  const packageJsonPath = path.join(cwd, "package.json");
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw createSimulatorError(
      "Failed to parse package.json while checking Expo project support.",
      error,
    );
  }
}

async function hasFile(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

async function detectExpoProject(cwd: string): Promise<boolean> {
  const packageJson = await readPackageJson(cwd);
  const dependencySets = [
    packageJson?.dependencies,
    packageJson?.devDependencies,
    packageJson?.peerDependencies,
  ];
  const hasExpoDependency = dependencySets.some((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    return "expo" in entry || "expo-router" in entry;
  });
  if (hasExpoDependency) {
    return true;
  }

  for (const candidate of EXPO_CONFIG_CANDIDATES) {
    if (await hasFile(path.join(cwd, candidate))) {
      return true;
    }
  }

  return false;
}

async function listDevices(): Promise<ReadonlyArray<IosSimulatorDevice>> {
  const result = await runProcess("xcrun", ["simctl", "list", "devices", "available", "--json"], {
    timeoutMs: 30_000,
    maxBufferBytes: 32 * 1024 * 1024,
  });
  const parsed = JSON.parse(result.stdout) as SimctlListDevicesResponse;

  return Object.entries(parsed.devices ?? {})
    .filter(([runtimeIdentifier]) => IOS_RUNTIME_RE.test(runtimeIdentifier))
    .flatMap(([runtimeIdentifier, entries]) =>
      entries.flatMap((entry) => {
        if (!entry.udid || !entry.name) {
          return [];
        }
        return [
          {
            udid: entry.udid,
            name: entry.name,
            runtime: formatRuntimeIdentifier(runtimeIdentifier),
            state: normalizeIosSimulatorDeviceState(entry.state),
            isAvailable: entry.isAvailable !== false,
            lastBootedAt: entry.lastBootedAt ?? null,
          } satisfies IosSimulatorDevice,
        ];
      }),
    )
    .filter((entry) => entry.isAvailable);
}

async function resolveDeviceByUdid(udid: string): Promise<IosSimulatorDevice> {
  const devices = await listDevices();
  const device = devices.find((entry) => entry.udid === udid);
  if (!device) {
    throw createSimulatorError("The selected iOS Simulator device could not be found.");
  }
  return device;
}

const supported =
  process.platform === "darwin" &&
  isCommandAvailable("xcrun") &&
  isCommandAvailable("swiftc", { platform: "darwin" });

const supportReason =
  process.platform !== "darwin"
    ? "Built-in iOS Simulator streaming is only available on macOS."
    : !isCommandAvailable("xcrun")
      ? "xcrun is not available in the current shell environment."
      : !isCommandAvailable("swiftc", { platform: "darwin" })
        ? "swiftc is unavailable, so the simulator bridge cannot be built."
        : null;

const getProjectState: IosSimulatorShape["getProjectState"] = (input) =>
  Effect.tryPromise({
    try: async () => {
      if (!supported) {
        return {
          supported: false,
          supportReason,
          isExpoProject: false,
          devices: [],
          bootedDeviceUdid: null,
          preferredDeviceUdid: null,
        };
      }

      const [isExpoProject, devices] = await Promise.all([
        detectExpoProject(input.cwd),
        listDevices(),
      ]);
      const bootedDevice = devices.find((device) => device.state === "booted") ?? null;
      const preferredDevice = selectPreferredIosSimulatorDevice(devices);
      return {
        supported: true,
        supportReason: null,
        isExpoProject,
        devices,
        bootedDeviceUdid: bootedDevice?.udid ?? null,
        preferredDeviceUdid: preferredDevice?.udid ?? null,
      };
    },
    catch: (cause) =>
      isSimulatorError(cause)
        ? cause
        : createSimulatorError("Failed to load iOS Simulator project state.", cause),
  });

function makeIosSimulator(input: {
  readonly runtimeEvents: SimulatorRuntimeEvents;
  readonly daemonPromises: Map<string, Promise<SimulatorInteractionDaemon>>;
}): IosSimulatorShape {
  const streamStates = new Map<string, StreamRuntimeState>();

  const getStreamState = (udid: string): StreamRuntimeState => {
    const existing = streamStates.get(udid);
    if (existing) {
      return existing;
    }
    const created: StreamRuntimeState = {
      viewerCount: 0,
      liveViewerCount: 0,
      frameCount: 0,
      firstFrameAt: null,
      lastFrameAt: null,
      status: "idle",
    };
    streamStates.set(udid, created);
    return created;
  };

  const updateStreamState = (
    udid: string,
    update: (current: StreamRuntimeState) => StreamRuntimeState,
  ): StreamRuntimeState => {
    const next = update({ ...getStreamState(udid) });
    streamStates.set(udid, next);
    return next;
  };

  const boot: IosSimulatorShape["boot"] = (bootInput) =>
    Effect.tryPromise(async (): Promise<IosSimulatorBootResult> => {
      input.runtimeEvents.lifecycle({
        udid: bootInput.udid,
        state: "booting",
      });
      input.runtimeEvents.log({
        level: "info",
        source: "service",
        udid: bootInput.udid,
        message: `Booting simulator ${bootInput.udid}.`,
      });

      try {
        if (!supported) {
          throw createSimulatorError(supportReason ?? "iOS Simulator support is unavailable.");
        }

        const initialDevice = await resolveDeviceByUdid(bootInput.udid);
        if (initialDevice.state !== "booted") {
          const bootResult = await runProcess("xcrun", ["simctl", "boot", bootInput.udid], {
            timeoutMs: 30_000,
            allowNonZeroExit: true,
          });
          if (
            bootResult.code !== 0 &&
            !isExpectedSimctlBootError(`${bootResult.stdout}\n${bootResult.stderr}`)
          ) {
            throw createSimulatorError(
              "Failed to boot the selected iOS Simulator device.",
              new Error(
                bootResult.stderr.trim() || bootResult.stdout.trim() || "Unknown simctl error.",
              ),
            );
          }
        }

        await runProcess("xcrun", ["simctl", "bootstatus", bootInput.udid, "-b"], {
          timeoutMs: 120_000,
        });

        const device = await resolveDeviceByUdid(bootInput.udid);
        if (device.state !== "booted") {
          throw createSimulatorError("The selected iOS Simulator device did not finish booting.");
        }

        await ensureInteractionDaemon(bootInput.udid, input.runtimeEvents, input.daemonPromises);

        input.runtimeEvents.lifecycle({
          udid: bootInput.udid,
          state: "ready",
        });
        input.runtimeEvents.log({
          level: "info",
          source: "service",
          udid: bootInput.udid,
          message: `Simulator ${bootInput.udid} is ready.`,
        });

        return { device };
      } catch (cause) {
        const error = isSimulatorError(cause)
          ? cause
          : createSimulatorError("Failed to boot the selected iOS Simulator device.", cause);
        input.runtimeEvents.lifecycle({
          udid: bootInput.udid,
          state: "error",
          detail: error.message,
        });
        input.runtimeEvents.log({
          level: "error",
          source: "service",
          udid: bootInput.udid,
          message: error.message,
        });
        throw error;
      }
    });

  const interact: IosSimulatorShape["interact"] = (interactInput) =>
    Effect.tryPromise(async (): Promise<IosSimulatorInteractResult> => {
      // Intermediate pointer-move frames would flood the event bus and log
      // tail at ~60Hz. We only publish lifecycle-worthy transitions
      // (gesture start, gesture end, and failures).
      const shouldEmitInputState = !(
        interactInput.kind === "pointer" && interactInput.phase === "moved"
      );

      if (shouldEmitInputState) {
        input.runtimeEvents.inputState({
          udid: interactInput.udid,
          inputKind: interactInput.kind,
          status: "dispatching",
        });
      }

      try {
        if (!supported) {
          throw createSimulatorError(supportReason ?? "iOS Simulator support is unavailable.");
        }

        const daemon = await ensureInteractionDaemon(
          interactInput.udid,
          input.runtimeEvents,
          input.daemonPromises,
        );

        switch (interactInput.kind) {
          case "tap":
            await daemon.send({
              kind: "tap",
              x: interactInput.x,
              y: interactInput.y,
            });
            break;
          case "drag":
            await daemon.send({
              kind: "drag",
              fromX: interactInput.fromX,
              fromY: interactInput.fromY,
              toX: interactInput.toX,
              toY: interactInput.toY,
            });
            break;
          case "pointer":
            await daemon.send({
              kind: "pointer",
              phase: interactInput.phase,
              x: interactInput.x,
              y: interactInput.y,
            });
            break;
          case "type":
            await daemon.send({
              kind: "type",
              text: interactInput.text,
            });
            break;
          case "press":
            await daemon.send({
              kind: "press",
              key: interactInput.key,
            });
            break;
        }

        if (shouldEmitInputState) {
          input.runtimeEvents.inputState({
            udid: interactInput.udid,
            inputKind: interactInput.kind,
            status: "succeeded",
          });
        }
        return { ok: true };
      } catch (cause) {
        const error = isSimulatorError(cause)
          ? cause
          : createSimulatorError("The iOS Simulator input bridge failed.", cause);
        input.runtimeEvents.inputState({
          udid: interactInput.udid,
          inputKind: interactInput.kind,
          status: "failed",
          message: error.message,
        });
        input.runtimeEvents.log({
          level: "error",
          source: "service",
          udid: interactInput.udid,
          message: `Simulator input failed: ${error.message}`,
        });
        throw error;
      }
    });

  const createVideoStream: IosSimulatorShape["createVideoStream"] = (streamInput) =>
    Effect.tryPromise(async () => {
      if (!supported) {
        throw createSimulatorError(supportReason ?? "iOS Simulator support is unavailable.");
      }

      const binaryPath = await resolveSimulatorBridgeBinaryPath();
      const targetIntervalMs = streamInput.intervalMs ?? Math.round(1000 / DEFAULT_STREAM_FPS);
      const fps = Math.max(1, Math.round(1000 / Math.max(8, targetIntervalMs)));
      const abortSignal = streamInput.signal;

      let child: ReturnType<typeof spawn> | null = null;
      let cleanedUp = false;
      let cancelled = false;
      let firstFrameDelivered = false;
      let lastFrameStatePublishedAt = 0;
      let startupFrameTimeout: ReturnType<typeof setTimeout> | null = null;
      let stallTimeout: ReturnType<typeof setTimeout> | null = null;
      let detachAbortListener: (() => void) | null = null;

      const clearFrameTimers = () => {
        if (startupFrameTimeout) {
          clearTimeout(startupFrameTimeout);
          startupFrameTimeout = null;
        }
        if (stallTimeout) {
          clearTimeout(stallTimeout);
          stallTimeout = null;
        }
      };

      const cleanupStream = (status: StreamRuntimeState["status"], reason?: string | null) => {
        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        clearFrameTimers();
        detachAbortListener?.();
        detachAbortListener = null;

        const nextState = updateStreamState(streamInput.udid, (current) => {
          const liveViewerCount = Math.max(
            0,
            current.liveViewerCount - (firstFrameDelivered ? 1 : 0),
          );
          const viewerCount = Math.max(0, current.viewerCount - 1);
          return {
            ...current,
            viewerCount,
            liveViewerCount,
            status:
              status === "error"
                ? "error"
                : liveViewerCount > 0
                  ? "live"
                  : viewerCount > 0
                    ? "connecting"
                    : "closed",
          };
        });

        input.runtimeEvents.frameState({
          udid: streamInput.udid,
          status: nextState.status,
          viewerCount: nextState.viewerCount,
          frameCount: nextState.frameCount,
          firstFrameAt: nextState.firstFrameAt,
          lastFrameAt: nextState.lastFrameAt,
          ...(reason === undefined ? {} : { reason }),
        });

        if (firstFrameDelivered && nextState.liveViewerCount === 0) {
          input.runtimeEvents.readiness({
            udid: streamInput.udid,
            source: "stream",
            ready: false,
            reason: reason ?? "Simulator stream closed.",
          });
        } else if (!firstFrameDelivered && nextState.viewerCount === 0) {
          input.runtimeEvents.readiness({
            udid: streamInput.udid,
            source: "stream",
            ready: false,
            reason: reason ?? "Simulator stream stopped before the first frame.",
          });
        }

        input.runtimeEvents.log({
          level: status === "error" ? "error" : "info",
          source: "stream-bridge",
          udid: streamInput.udid,
          message:
            status === "error"
              ? `Simulator stream failed: ${reason ?? "Unknown stream error."}`
              : `Simulator stream closed for ${streamInput.udid}.`,
        });
      };

      return new ReadableStream<Uint8Array>({
        start(controller) {
          const abortStream = (reason: string, status: StreamRuntimeState["status"]) => {
            cancelled = true;
            cleanupStream(status, reason);
            if (child && !child.killed) {
              child.kill("SIGTERM");
            }
            if (status === "error") {
              controller.error(createSimulatorError(reason));
            } else {
              controller.close();
            }
          };

          if (abortSignal) {
            if (abortSignal.aborted) {
              abortStream("Stream request aborted.", "closed");
              return;
            }
            const onAbort = () => {
              abortStream("Stream request aborted.", "closed");
            };
            abortSignal.addEventListener("abort", onAbort, { once: true });
            detachAbortListener = () => {
              abortSignal.removeEventListener("abort", onAbort);
            };
          }

          const initialState = updateStreamState(streamInput.udid, (current) => ({
            ...current,
            viewerCount: current.viewerCount + 1,
            status: current.liveViewerCount > 0 ? "live" : "connecting",
          }));

          input.runtimeEvents.frameState({
            udid: streamInput.udid,
            status: initialState.status,
            viewerCount: initialState.viewerCount,
            frameCount: initialState.frameCount,
            firstFrameAt: initialState.firstFrameAt,
            lastFrameAt: initialState.lastFrameAt,
            reason:
              initialState.liveViewerCount > 0 ? null : "Waiting for the first simulator frame.",
          });
          if (initialState.liveViewerCount === 0) {
            input.runtimeEvents.readiness({
              udid: streamInput.udid,
              source: "stream",
              ready: false,
              reason: "Waiting for the first simulator frame.",
            });
          }
          input.runtimeEvents.log({
            level: "info",
            source: "service",
            udid: streamInput.udid,
            message: `Opening simulator stream for ${streamInput.udid}.`,
          });

          const streamChild = spawn(binaryPath, ["stream-device", streamInput.udid, String(fps)], {
            stdio: "pipe",
          });
          child = streamChild;
          // The Swift bridge emits length-prefixed H.264 access units. We
          // forward every raw chunk verbatim and count AUs on the fly so
          // the UI heartbeat reflects actual frame delivery.
          let pendingAccessUnitBytes = 0;
          let countingCarry = Buffer.alloc(0);
          let stderr = "";

          const countAccessUnits = (chunk: Buffer): number => {
            let units = 0;
            const buffer =
              countingCarry.length === 0 ? chunk : Buffer.concat([countingCarry, chunk]);
            let offset = 0;
            while (true) {
              if (pendingAccessUnitBytes === 0) {
                if (buffer.length - offset < 4) {
                  break;
                }
                pendingAccessUnitBytes = buffer.readUInt32BE(offset);
                offset += 4;
              }
              const available = buffer.length - offset;
              if (available < pendingAccessUnitBytes) {
                offset += available;
                pendingAccessUnitBytes -= available;
                break;
              }
              offset += pendingAccessUnitBytes;
              pendingAccessUnitBytes = 0;
              units += 1;
            }
            countingCarry =
              offset >= buffer.length ? Buffer.alloc(0) : Buffer.from(buffer.subarray(offset));
            return units;
          };

          const scheduleStartupFrameTimeout = () => {
            startupFrameTimeout = setTimeout(() => {
              if (cancelled || cleanedUp || firstFrameDelivered) {
                return;
              }
              abortStream("Timed out waiting for the first simulator frame.", "error");
            }, INITIAL_STREAM_FRAME_TIMEOUT_MS);
          };

          const scheduleStallTimeout = () => {
            if (stallTimeout) {
              clearTimeout(stallTimeout);
            }
            stallTimeout = setTimeout(() => {
              if (cancelled || cleanedUp || !firstFrameDelivered) {
                return;
              }
              abortStream("Simulator stream stopped producing frames.", "error");
            }, STREAM_STALL_TIMEOUT_MS);
          };

          scheduleStartupFrameTimeout();
          scheduleStallTimeout();

          streamChild.stdout.on("data", (chunk: Buffer | string) => {
            if (cancelled) {
              return;
            }
            const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            if (buffer.length === 0) {
              return;
            }
            controller.enqueue(new Uint8Array(buffer));

            const framesInChunk = countAccessUnits(buffer);
            if (framesInChunk === 0 && firstFrameDelivered) {
              return;
            }
            const now = new Date();
            const nowIso = now.toISOString();
            const nowMs = now.getTime();
            const isFirstFrame = !firstFrameDelivered;
            if (framesInChunk > 0) {
              firstFrameDelivered = true;
            }
            if (isFirstFrame && startupFrameTimeout) {
              clearTimeout(startupFrameTimeout);
              startupFrameTimeout = null;
            }
            scheduleStallTimeout();

            const nextState = updateStreamState(streamInput.udid, (current) => ({
              ...current,
              liveViewerCount: isFirstFrame ? current.liveViewerCount + 1 : current.liveViewerCount,
              frameCount: current.frameCount + framesInChunk,
              firstFrameAt: current.firstFrameAt ?? nowIso,
              lastFrameAt: nowIso,
              status: "live",
            }));

            if (isFirstFrame && nextState.liveViewerCount === 1) {
              input.runtimeEvents.readiness({
                udid: streamInput.udid,
                source: "stream",
                ready: true,
              });
              input.runtimeEvents.lifecycle({
                udid: streamInput.udid,
                state: "streaming",
              });
              input.runtimeEvents.log({
                level: "info",
                source: "stream-bridge",
                udid: streamInput.udid,
                message: `Simulator stream is live for ${streamInput.udid}.`,
              });
            }

            if (isFirstFrame || nowMs - lastFrameStatePublishedAt >= FRAME_STATE_HEARTBEAT_MS) {
              lastFrameStatePublishedAt = nowMs;
              input.runtimeEvents.frameState({
                udid: streamInput.udid,
                status: nextState.status,
                viewerCount: nextState.viewerCount,
                frameCount: nextState.frameCount,
                firstFrameAt: nextState.firstFrameAt,
                lastFrameAt: nextState.lastFrameAt,
              });
            }
          });

          streamChild.stderr.on("data", (chunk: Buffer | string) => {
            const text = chunk.toString();
            stderr += text;
            input.runtimeEvents.log({
              level: "warn",
              source: "stream-bridge",
              udid: streamInput.udid,
              message: text,
            });
          });

          streamChild.once("error", (error) => {
            cleanupStream("error", error.message);
            if (cancelled) {
              return;
            }
            controller.error(
              createSimulatorError("Failed to start the Simulator device stream bridge.", error),
            );
          });

          streamChild.once("close", (code) => {
            const detail = stderr.trim() || `exit code ${code ?? "null"}`;
            if (code === 0) {
              cleanupStream("closed");
              if (!cancelled) {
                controller.close();
              }
              return;
            }

            cleanupStream("error", detail);
            if (cancelled) {
              return;
            }
            controller.error(
              createSimulatorError(
                "The Simulator device stream bridge stopped unexpectedly.",
                new Error(detail),
              ),
            );
          });
        },
        cancel() {
          cancelled = true;
          cleanupStream("closed", "Stream cancelled.");
          if (child && !child.killed) {
            child.kill("SIGTERM");
          }
        },
      });
    });

  return {
    getProjectState,
    boot,
    interact,
    createVideoStream,
    streamRuntimeEvents: input.runtimeEvents.stream,
  } satisfies IosSimulatorShape;
}

export const IosSimulatorLive = Layer.effect(
  IosSimulator,
  Effect.gen(function* () {
    const runtimeEvents = yield* makeSimulatorRuntimeEventBus();
    const daemonPromises = new Map<string, Promise<SimulatorInteractionDaemon>>();
    return makeIosSimulator({
      runtimeEvents,
      daemonPromises,
    });
  }),
);

/**
 * Custom wire type marker for the length-prefixed H.264 Annex-B access unit
 * stream. Pinned here so server and client stay in lockstep.
 */
export const IOS_SIMULATOR_VIDEO_CONTENT_TYPE = "application/vnd.t3code.h264-annex-b";
