import type { IosSimulatorDevice } from "@t3tools/contracts";

export function resolveSelectedIosSimulatorDeviceUdid(input: {
  devices: ReadonlyArray<Pick<IosSimulatorDevice, "udid">>;
  requestedDeviceUdid: string | null;
  bootedDeviceUdid: string | null;
  preferredDeviceUdid: string | null;
}): string | null {
  const availableDeviceUdids = new Set(input.devices.map((device) => device.udid));

  if (input.requestedDeviceUdid !== null && availableDeviceUdids.has(input.requestedDeviceUdid)) {
    return input.requestedDeviceUdid;
  }

  if (input.bootedDeviceUdid !== null && availableDeviceUdids.has(input.bootedDeviceUdid)) {
    return input.bootedDeviceUdid;
  }

  if (input.preferredDeviceUdid !== null && availableDeviceUdids.has(input.preferredDeviceUdid)) {
    return input.preferredDeviceUdid;
  }

  return input.devices[0]?.udid ?? null;
}
