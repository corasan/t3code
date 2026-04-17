import { describe, expect, it } from "vitest";

import {
  createEmptySimulatorPanelRuntimeState,
  getSimulatorPanelLogTail,
  hasSimulatorBootSignal,
  isSimulatorFrameStale,
  readSimulatorPanelRuntimeDevice,
  reduceSimulatorPanelRuntimeState,
  shouldAutoReconnectSimulatorStream,
} from "./SimulatorPanel.runtime";

describe("SimulatorPanel.runtime", () => {
  it("applies snapshot and live updates to runtime state", () => {
    const snapshotState = reduceSimulatorPanelRuntimeState(
      createEmptySimulatorPanelRuntimeState(),
      {
        version: 1,
        sequence: 1,
        type: "snapshot",
        snapshot: {
          devices: [],
          logs: [],
        },
      },
    );
    const nextState = reduceSimulatorPanelRuntimeState(snapshotState, {
      version: 1,
      sequence: 2,
      createdAt: "2026-04-17T12:00:01.000Z",
      type: "frameState",
      payload: {
        udid: "sim-1",
        status: "live",
        viewerCount: 1,
        frameCount: 1,
        firstFrameAt: "2026-04-17T12:00:01.000Z",
        lastFrameAt: "2026-04-17T12:00:01.000Z",
        reason: null,
      },
    });

    expect(readSimulatorPanelRuntimeDevice(nextState, "sim-1")).toMatchObject({
      frameStatus: "live",
      lifecycleState: "streaming",
      frameCount: 1,
    });
  });

  it("retains device and global logs in the selected tail", () => {
    const state = reduceSimulatorPanelRuntimeState(
      reduceSimulatorPanelRuntimeState(createEmptySimulatorPanelRuntimeState(), {
        version: 1,
        sequence: 1,
        createdAt: "2026-04-17T12:00:00.000Z",
        type: "log",
        payload: {
          sequence: 1,
          createdAt: "2026-04-17T12:00:00.000Z",
          level: "info",
          source: "service",
          udid: null,
          message: "Opening simulator stream.",
        },
      }),
      {
        version: 1,
        sequence: 2,
        createdAt: "2026-04-17T12:00:01.000Z",
        type: "log",
        payload: {
          sequence: 2,
          createdAt: "2026-04-17T12:00:01.000Z",
          level: "warn",
          source: "stream-bridge",
          udid: "sim-1",
          message: "Waiting for the first simulator frame.",
        },
      },
    );

    expect(getSimulatorPanelLogTail(state, "sim-1").map((entry) => entry.message)).toEqual([
      "Opening simulator stream.",
      "Waiting for the first simulator frame.",
    ]);
  });

  it("derives boot, stale, and reconnect signals from runtime state", () => {
    const runtimeDevice = {
      udid: "sim-1",
      lifecycleState: "streaming",
      interactionReady: true,
      streamReady: true,
      frameStatus: "live",
      viewerCount: 1,
      frameCount: 8,
      firstFrameAt: "2026-04-17T12:00:00.000Z",
      lastFrameAt: "2026-04-17T12:00:00.000Z",
      inputStatus: "idle",
      lastInputKind: null,
      lastInputAt: null,
      lastError: null,
    } as const;

    expect(hasSimulatorBootSignal({ deviceState: "shutdown", runtimeDevice })).toBe(true);
    expect(isSimulatorFrameStale(runtimeDevice, Date.parse("2026-04-17T12:00:05.000Z"))).toBe(true);
    expect(
      shouldAutoReconnectSimulatorStream({
        runtimeDevice,
        nowMs: Date.parse("2026-04-17T12:00:05.000Z"),
      }),
    ).toBe(false);

    expect(
      shouldAutoReconnectSimulatorStream({
        runtimeDevice: {
          ...runtimeDevice,
          frameStatus: "error",
        },
      }),
    ).toBe(true);
  });
});
