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
  type IosSimulatorInteractResult,
  SimulatorError,
} from "@t3tools/contracts";
import { isCommandAvailable } from "@t3tools/shared/shell";
import { Effect, Layer, Schema } from "effect";

import { runProcess } from "../../processRunner.ts";
import { IosSimulator, type IosSimulatorShape } from "../Services/IosSimulator.ts";

const DEFAULT_STREAM_FPS = 30;
const MJPEG_BOUNDARY = "t3code-ios-simulator-frame";
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
const SIMULATOR_BRIDGE_BINARY_NAME = "t3code-simulator-device-bridge-v4";

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

interface LengthPrefixedFrameState {
  buffer: Buffer;
  expectedLength: number | null;
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
    readonly kind: "tap" | "drag" | "type" | "press";
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

let simulatorBridgeBinaryPathPromise: Promise<string> | null = null;
const simulatorInteractionDaemonPromises = new Map<string, Promise<SimulatorInteractionDaemon>>();

function createSimulatorError(message: string, cause?: unknown): SimulatorError {
  return new SimulatorError(cause === undefined ? { message } : { message, cause });
}

const isSimulatorError = Schema.is(SimulatorError);

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

function encodeMjpegFrame(frame: Uint8Array): Uint8Array {
  const header = Buffer.from(
    `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.byteLength}\r\n\r\n`,
    "utf8",
  );
  const footer = Buffer.from("\r\n", "utf8");
  return Buffer.concat([header, Buffer.from(frame), footer]);
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
          "-framework",
          "CoreGraphics",
          "-framework",
          "CoreImage",
          "-framework",
          "IOSurface",
          "-framework",
          "ImageIO",
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

async function createInteractionDaemon(udid: string): Promise<SimulatorInteractionDaemon> {
  const binaryPath = await resolveSimulatorBridgeBinaryPath();
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
      rejectReady(`Failed to start the simulator interaction bridge: ${error.message}`);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
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
          rejectReady(message.error ?? "The simulator interaction bridge failed to become ready.");
          return;
        }
        ready = true;
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
        rejectReady(`The simulator interaction bridge exited before readiness: ${detail}`);
      }
      for (const request of pendingRequests.values()) {
        clearTimeout(request.timeout);
        request.reject(
          new Error(`The simulator interaction bridge stopped unexpectedly: ${detail}`),
        );
      }
      pendingRequests.clear();
      output.close();
      simulatorInteractionDaemonPromises.delete(udid);
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

async function ensureInteractionDaemon(udid: string): Promise<SimulatorInteractionDaemon> {
  const existing = simulatorInteractionDaemonPromises.get(udid);
  if (existing) {
    return await existing;
  }

  const created = createInteractionDaemon(udid).catch((error) => {
    simulatorInteractionDaemonPromises.delete(udid);
    throw error;
  });
  simulatorInteractionDaemonPromises.set(udid, created);
  return await created;
}

function parseLengthPrefixedFrames(
  state: LengthPrefixedFrameState,
  chunk: Buffer,
): ReadonlyArray<Buffer> {
  state.buffer = state.buffer.length === 0 ? chunk : Buffer.concat([state.buffer, chunk]);
  const frames: Buffer[] = [];

  for (;;) {
    if (state.expectedLength === null) {
      if (state.buffer.length < 4) {
        break;
      }
      state.expectedLength = state.buffer.readUInt32BE(0);
      state.buffer = state.buffer.subarray(4);
    }

    if (state.buffer.length < state.expectedLength) {
      break;
    }

    frames.push(state.buffer.subarray(0, state.expectedLength));
    state.buffer = state.buffer.subarray(state.expectedLength);
    state.expectedLength = null;
  }

  return frames;
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

const boot: IosSimulatorShape["boot"] = (input) =>
  Effect.tryPromise({
    try: async (): Promise<IosSimulatorBootResult> => {
      if (!supported) {
        throw createSimulatorError(supportReason ?? "iOS Simulator support is unavailable.");
      }

      const initialDevice = await resolveDeviceByUdid(input.udid);
      if (initialDevice.state !== "booted") {
        const bootResult = await runProcess("xcrun", ["simctl", "boot", input.udid], {
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

      await runProcess("xcrun", ["simctl", "bootstatus", input.udid, "-b"], {
        timeoutMs: 120_000,
      });

      const device = await resolveDeviceByUdid(input.udid);
      if (device.state !== "booted") {
        throw createSimulatorError("The selected iOS Simulator device did not finish booting.");
      }

      await ensureInteractionDaemon(input.udid);

      return { device };
    },
    catch: (cause) =>
      isSimulatorError(cause)
        ? cause
        : createSimulatorError("Failed to boot the selected iOS Simulator device.", cause),
  });

const interact: IosSimulatorShape["interact"] = (input) =>
  Effect.tryPromise({
    try: async (): Promise<IosSimulatorInteractResult> => {
      if (!supported) {
        throw createSimulatorError(supportReason ?? "iOS Simulator support is unavailable.");
      }

      // Skip a per-call `xcrun simctl list devices` here: that command takes
      // hundreds of ms and was running on every tap / drag step / key press,
      // making interactions feel sluggish. The Swift bridge already validates
      // the device is booted when the daemon is created, and exits if the
      // device shuts down — at which point `ensureInteractionDaemon` will
      // re-create it and surface a clear error.
      const daemon = await ensureInteractionDaemon(input.udid);

      switch (input.kind) {
        case "tap":
          await daemon.send({
            kind: "tap",
            x: input.x,
            y: input.y,
          });
          return { ok: true };
        case "drag":
          await daemon.send({
            kind: "drag",
            fromX: input.fromX,
            fromY: input.fromY,
            toX: input.toX,
            toY: input.toY,
          });
          return { ok: true };
        case "type":
          await daemon.send({
            kind: "type",
            text: input.text,
          });
          return { ok: true };
        case "press":
          await daemon.send({
            kind: "press",
            key: input.key,
          });
          return { ok: true };
      }
    },
    catch: (cause) =>
      isSimulatorError(cause)
        ? cause
        : createSimulatorError("The iOS Simulator input bridge failed.", cause),
  });

const createMjpegStream: IosSimulatorShape["createMjpegStream"] = (input) =>
  Effect.tryPromise({
    try: async () => {
      if (!supported) {
        throw createSimulatorError(supportReason ?? "iOS Simulator support is unavailable.");
      }

      // The Swift bridge process validates that the device exists and is
      // booted before it starts producing frames; skipping the redundant
      // `xcrun simctl list devices` here trims hundreds of ms off the time
      // between opening the panel and seeing the first frame.
      const binaryPath = await resolveSimulatorBridgeBinaryPath();
      const targetIntervalMs = input.intervalMs ?? Math.round(1000 / DEFAULT_STREAM_FPS);
      const fps = Math.max(1, Math.round(1000 / Math.max(16, targetIntervalMs)));

      let child: ReturnType<typeof spawn> | null = null;
      let cancelled = false;

      return new ReadableStream<Uint8Array>({
        start(controller) {
          const streamChild = spawn(binaryPath, ["stream-device", input.udid, String(fps)], {
            stdio: "pipe",
          });
          child = streamChild;
          const parseState: LengthPrefixedFrameState = {
            buffer: Buffer.alloc(0),
            expectedLength: null,
          };
          let stderr = "";

          streamChild.stdout.on("data", (chunk: Buffer | string) => {
            if (cancelled) {
              return;
            }
            const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            for (const frame of parseLengthPrefixedFrames(parseState, buffer)) {
              controller.enqueue(encodeMjpegFrame(frame));
            }
          });

          streamChild.stderr.on("data", (chunk: Buffer | string) => {
            stderr += chunk.toString();
          });

          streamChild.once("error", (error) => {
            if (cancelled) {
              return;
            }
            controller.error(
              createSimulatorError("Failed to start the Simulator device stream bridge.", error),
            );
          });

          streamChild.once("close", (code) => {
            if (cancelled) {
              return;
            }
            if (code === 0) {
              controller.close();
              return;
            }
            controller.error(
              createSimulatorError(
                "The Simulator device stream bridge stopped unexpectedly.",
                new Error(stderr.trim() || `exit code ${code ?? "null"}`),
              ),
            );
          });
        },
        cancel() {
          cancelled = true;
          if (child && !child.killed) {
            child.kill("SIGTERM");
          }
        },
      });
    },
    catch: (cause) =>
      isSimulatorError(cause)
        ? cause
        : createSimulatorError("Failed to start the live iOS Simulator stream.", cause),
  });

export const makeIosSimulator = {
  getProjectState,
  boot,
  interact,
  createMjpegStream,
} satisfies IosSimulatorShape;

export const IosSimulatorLive = Layer.succeed(IosSimulator, makeIosSimulator);

export const IOS_SIMULATOR_MJPEG_BOUNDARY = MJPEG_BOUNDARY;
