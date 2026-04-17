import { mkdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

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

const DEFAULT_STREAM_FPS = 15;
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
const SIMULATOR_BRIDGE_BINARY_NAME = "t3code-simulator-bridge-v2";
const WINDOW_INFO_RETRY_ATTEMPTS = 12;
const WINDOW_INFO_RETRY_DELAY_MS = 125;

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

interface SimulatorWindowInfo {
  readonly windowId: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface SimulatorDisplayMetadata {
  readonly width: number;
  readonly height: number;
}

let simulatorBridgeBinaryPathPromise: Promise<string> | null = null;
const simulatorDisplayMetadataCache = new Map<string, SimulatorDisplayMetadata>();

function createSimulatorError(message: string, cause?: unknown): SimulatorError {
  return new SimulatorError(cause === undefined ? { message } : { message, cause });
}

const isSimulatorError = Schema.is(SimulatorError);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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

  return [...devices].sort((left, right) => {
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

function launchSimulatorApp(udid: string): void {
  const child = spawn("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", udid], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
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
          "AppKit",
          "-framework",
          "ApplicationServices",
          "-framework",
          "CoreGraphics",
          "-framework",
          "CoreImage",
          "-framework",
          "CoreMedia",
          "-framework",
          "CoreVideo",
          "-framework",
          "ImageIO",
          "-framework",
          "ScreenCaptureKit",
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

async function runSimulatorBridge(args: ReadonlyArray<string>): Promise<string> {
  const binaryPath = await resolveSimulatorBridgeBinaryPath();
  const result = await runProcess(binaryPath, args, {
    timeoutMs: 30_000,
    maxBufferBytes: 16 * 1024 * 1024,
  });
  return result.stdout;
}

function resolveSimulatorDisplayRect(
  windowInfo: SimulatorWindowInfo,
  displayMetadata: SimulatorDisplayMetadata,
) {
  const scale = Math.min(
    windowInfo.width / displayMetadata.width,
    windowInfo.height / displayMetadata.height,
  );
  const width = displayMetadata.width * scale;
  const height = displayMetadata.height * scale;
  return {
    x: windowInfo.x + (windowInfo.width - width) / 2,
    y: windowInfo.y + (windowInfo.height - height),
    width,
    height,
  };
}

function normalizeAbsolutePoint(
  windowInfo: SimulatorWindowInfo,
  displayMetadata: SimulatorDisplayMetadata,
  x: number,
  y: number,
) {
  const rect = resolveSimulatorDisplayRect(windowInfo, displayMetadata);
  return {
    x: rect.x + rect.width * x,
    y: rect.y + rect.height * y,
  };
}

function parseJpegDimensions(buffer: Buffer): SimulatorDisplayMetadata | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1]!;
    offset += 2;

    if (marker === 0xd8 || marker === 0xd9) {
      continue;
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    if (offset + 2 > buffer.length) {
      break;
    }
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      break;
    }

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      if (segmentLength < 7) {
        return null;
      }
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (width > 0 && height > 0) {
        return { width, height };
      }
      return null;
    }

    offset += segmentLength;
  }

  return null;
}

async function captureSimulatorDisplayFrame(udid: string): Promise<{
  readonly jpeg: Buffer;
  readonly metadata: SimulatorDisplayMetadata;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "xcrun",
      [
        "simctl",
        "io",
        udid,
        "screenshot",
        "--type=jpeg",
        "--display=internal",
        "--mask=ignored",
        "-",
      ],
      {
        stdio: "pipe",
      },
    );

    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 15_000);

    const finalize = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      finalize(() => {
        reject(new Error(`Failed to capture the Simulator display: ${error.message}`));
      });
    });

    child.once("close", (code, signal) => {
      finalize(() => {
        if (timedOut) {
          reject(new Error("Timed out while capturing the Simulator display."));
          return;
        }
        if (code !== 0) {
          reject(
            new Error(
              stderr.trim() ||
                `Simulator display capture failed (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
            ),
          );
          return;
        }

        const jpeg = Buffer.concat(stdoutChunks);
        const metadata = parseJpegDimensions(jpeg);
        if (!metadata) {
          reject(new Error("Simulator display capture returned an invalid JPEG frame."));
          return;
        }

        simulatorDisplayMetadataCache.set(udid, metadata);
        resolve({ jpeg, metadata });
      });
    });
  });
}

async function resolveSimulatorDisplayMetadata(udid: string): Promise<SimulatorDisplayMetadata> {
  const cached = simulatorDisplayMetadataCache.get(udid);
  if (cached) {
    return cached;
  }
  const frame = await captureSimulatorDisplayFrame(udid);
  return frame.metadata;
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

async function resolveSimulatorWindowInfo(udid: string): Promise<SimulatorWindowInfo> {
  let lastError: unknown;

  for (let attempt = 0; attempt < WINDOW_INFO_RETRY_ATTEMPTS; attempt += 1) {
    try {
      launchSimulatorApp(udid);
      const stdout = await runSimulatorBridge(["window-info"]);
      const parsed = JSON.parse(stdout) as SimulatorWindowInfo;
      if (parsed.width > 0 && parsed.height > 0) {
        return parsed;
      }
      lastError = new Error("Simulator window has invalid bounds.");
    } catch (error) {
      lastError = error;
    }

    await sleep(WINDOW_INFO_RETRY_DELAY_MS);
  }

  throw createSimulatorError(
    "Unable to locate the Simulator window. Make sure the Simulator app is allowed to be captured and automated.",
    lastError,
  );
}

const supported =
  process.platform === "darwin" &&
  isCommandAvailable("xcrun") &&
  isCommandAvailable("open", { platform: "darwin" }) &&
  isCommandAvailable("swiftc", { platform: "darwin" });

const supportReason =
  process.platform !== "darwin"
    ? "Built-in iOS Simulator streaming is only available on macOS."
    : !isCommandAvailable("xcrun")
      ? "xcrun is not available in the current shell environment."
      : !isCommandAvailable("swiftc", { platform: "darwin" })
        ? "swiftc is unavailable, so the simulator bridge cannot be built."
        : !isCommandAvailable("open", { platform: "darwin" })
          ? "The macOS open command is unavailable."
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
      launchSimulatorApp(input.udid);

      const device = await resolveDeviceByUdid(input.udid);
      if (device.state !== "booted") {
        throw createSimulatorError("The selected iOS Simulator device did not finish booting.");
      }

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

      const device = await resolveDeviceByUdid(input.udid);
      if (device.state !== "booted") {
        throw createSimulatorError(
          "The selected iOS Simulator device must be booted before it can receive input.",
        );
      }

      switch (input.kind) {
        case "tap": {
          const windowInfo = await resolveSimulatorWindowInfo(input.udid);
          const displayMetadata = await resolveSimulatorDisplayMetadata(input.udid);
          const point = normalizeAbsolutePoint(windowInfo, displayMetadata, input.x, input.y);
          await runSimulatorBridge(["click", String(point.x), String(point.y)]);
          return { ok: true };
        }
        case "drag": {
          const windowInfo = await resolveSimulatorWindowInfo(input.udid);
          const displayMetadata = await resolveSimulatorDisplayMetadata(input.udid);
          const from = normalizeAbsolutePoint(
            windowInfo,
            displayMetadata,
            input.fromX,
            input.fromY,
          );
          const to = normalizeAbsolutePoint(windowInfo, displayMetadata, input.toX, input.toY);
          await runSimulatorBridge([
            "drag",
            String(from.x),
            String(from.y),
            String(to.x),
            String(to.y),
          ]);
          return { ok: true };
        }
        case "type":
          await runSimulatorBridge(["type", input.text]);
          return { ok: true };
        case "press":
          await runSimulatorBridge(["press", input.key]);
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

      const device = await resolveDeviceByUdid(input.udid);
      if (device.state !== "booted") {
        throw createSimulatorError(
          "The selected iOS Simulator device must be booted before streaming starts.",
        );
      }

      const targetIntervalMs = input.intervalMs ?? Math.round(1000 / DEFAULT_STREAM_FPS);
      const firstFrame = await captureSimulatorDisplayFrame(input.udid);
      let cancelled = false;

      return new ReadableStream<Uint8Array>({
        start(controller) {
          launchSimulatorApp(input.udid);
          controller.enqueue(encodeMjpegFrame(firstFrame.jpeg));

          void (async () => {
            for (;;) {
              if (cancelled) {
                return;
              }
              await sleep(targetIntervalMs);
              if (cancelled) {
                return;
              }

              try {
                const frame = await captureSimulatorDisplayFrame(input.udid);
                if (cancelled) {
                  return;
                }
                controller.enqueue(encodeMjpegFrame(frame.jpeg));
              } catch (error) {
                if (cancelled) {
                  return;
                }
                controller.error(
                  createSimulatorError("Failed to capture the iOS Simulator display.", error),
                );
                return;
              }
            }
          })();
        },
        cancel() {
          cancelled = true;
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
