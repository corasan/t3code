import { describe, expect, it } from "vitest";

import { resolveSelectedIosSimulatorDeviceUdid } from "./SimulatorPanel.logic";

const BOOTED_DEVICE = { udid: "booted-device" };
const OTHER_DEVICE = { udid: "other-device" };
const PREFERRED_DEVICE = { udid: "preferred-device" };

describe("resolveSelectedIosSimulatorDeviceUdid", () => {
  it("keeps an explicitly selected device when it is still available", () => {
    expect(
      resolveSelectedIosSimulatorDeviceUdid({
        devices: [BOOTED_DEVICE, OTHER_DEVICE],
        requestedDeviceUdid: OTHER_DEVICE.udid,
        bootedDeviceUdid: BOOTED_DEVICE.udid,
        preferredDeviceUdid: BOOTED_DEVICE.udid,
      }),
    ).toBe(OTHER_DEVICE.udid);
  });

  it("falls back to the booted device when no explicit selection exists", () => {
    expect(
      resolveSelectedIosSimulatorDeviceUdid({
        devices: [BOOTED_DEVICE, OTHER_DEVICE],
        requestedDeviceUdid: null,
        bootedDeviceUdid: BOOTED_DEVICE.udid,
        preferredDeviceUdid: OTHER_DEVICE.udid,
      }),
    ).toBe(BOOTED_DEVICE.udid);
  });

  it("ignores stale explicit selections and reuses the preferred device", () => {
    expect(
      resolveSelectedIosSimulatorDeviceUdid({
        devices: [PREFERRED_DEVICE, OTHER_DEVICE],
        requestedDeviceUdid: "missing-device",
        bootedDeviceUdid: null,
        preferredDeviceUdid: PREFERRED_DEVICE.udid,
      }),
    ).toBe(PREFERRED_DEVICE.udid);
  });

  it("falls back to the first device when cached udids no longer exist", () => {
    expect(
      resolveSelectedIosSimulatorDeviceUdid({
        devices: [OTHER_DEVICE],
        requestedDeviceUdid: "missing-device",
        bootedDeviceUdid: "missing-booted-device",
        preferredDeviceUdid: "missing-preferred-device",
      }),
    ).toBe(OTHER_DEVICE.udid);
  });

  it("returns null when there are no available devices", () => {
    expect(
      resolveSelectedIosSimulatorDeviceUdid({
        devices: [],
        requestedDeviceUdid: null,
        bootedDeviceUdid: BOOTED_DEVICE.udid,
        preferredDeviceUdid: PREFERRED_DEVICE.udid,
      }),
    ).toBeNull();
  });
});
