import { describe, expect, it } from "vitest";

import {
  applyIosSimulatorRuntimeEvent,
  createEmptyIosSimulatorRuntimeState,
  createIosSimulatorRuntimeSnapshot,
  readIosSimulatorRuntimeDeviceSnapshot,
} from "./simulatorRuntime.ts";

describe("simulatorRuntime", () => {
  it("replaces state from snapshot events", () => {
    const next = applyIosSimulatorRuntimeEvent(createEmptyIosSimulatorRuntimeState(), {
      version: 1,
      sequence: 4,
      type: "snapshot",
      snapshot: {
        devices: [
          {
            udid: "device-b",
            lifecycleState: "streaming",
            interactionReady: true,
            streamReady: true,
            frameStatus: "live",
            viewerCount: 1,
            frameCount: 12,
            firstFrameAt: "2026-04-17T10:00:00.000Z",
            lastFrameAt: "2026-04-17T10:00:01.000Z",
            inputStatus: "succeeded",
            lastInputKind: "tap",
            lastInputAt: "2026-04-17T10:00:01.000Z",
            lastError: null,
          },
        ],
        logs: [],
      },
    });

    expect(readIosSimulatorRuntimeDeviceSnapshot(next, "device-b")?.frameStatus).toBe("live");
    expect(createIosSimulatorRuntimeSnapshot(next).devices.map((device) => device.udid)).toEqual([
      "device-b",
    ]);
  });

  it("applies live device updates and keeps the most recent error", () => {
    const withReadiness = applyIosSimulatorRuntimeEvent(createEmptyIosSimulatorRuntimeState(), {
      version: 1,
      sequence: 1,
      createdAt: "2026-04-17T10:00:00.000Z",
      type: "readiness",
      payload: {
        udid: "device-a",
        source: "interaction",
        ready: true,
        reason: null,
      },
    });

    const withFailure = applyIosSimulatorRuntimeEvent(withReadiness, {
      version: 1,
      sequence: 2,
      createdAt: "2026-04-17T10:00:02.000Z",
      type: "inputState",
      payload: {
        udid: "device-a",
        inputKind: "press",
        status: "failed",
        message: "Keyboard bridge timed out.",
      },
    });

    expect(readIosSimulatorRuntimeDeviceSnapshot(withFailure, "device-a")).toMatchObject({
      interactionReady: true,
      inputStatus: "failed",
      lastInputKind: "press",
      lastInputAt: "2026-04-17T10:00:02.000Z",
      lastError: "Keyboard bridge timed out.",
    });
  });

  it("sorts projected snapshots and retains recent logs", () => {
    const withLogs = applyIosSimulatorRuntimeEvent(
      applyIosSimulatorRuntimeEvent(createEmptyIosSimulatorRuntimeState(), {
        version: 1,
        sequence: 1,
        createdAt: "2026-04-17T10:00:00.000Z",
        type: "log",
        payload: {
          sequence: 1,
          createdAt: "2026-04-17T10:00:00.000Z",
          level: "info",
          source: "service",
          udid: null,
          message: "Starting simulator stream.",
        },
      }),
      {
        version: 1,
        sequence: 2,
        createdAt: "2026-04-17T10:00:01.000Z",
        type: "frameState",
        payload: {
          udid: "device-z",
          status: "live",
          viewerCount: 1,
          frameCount: 3,
          firstFrameAt: "2026-04-17T10:00:01.000Z",
          lastFrameAt: "2026-04-17T10:00:01.000Z",
          reason: null,
        },
      },
    );

    const snapshot = createIosSimulatorRuntimeSnapshot(withLogs);
    expect(snapshot.logs).toHaveLength(1);
    expect(snapshot.devices[0]?.udid).toBe("device-z");
  });
});
