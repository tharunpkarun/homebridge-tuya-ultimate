import fs from 'fs';
import path from 'path';
import { PlatformAccessory } from 'homebridge';

export type AccessoryBackup = {
  version: 1;
  createdAt: string;
  reason: string;
  accessories: Array<{
    uuid: string;
    displayName: string;
    deviceId?: string;
    services: Array<{
      uuid: string;
      displayName: string;
      subtype?: string;
    }>;
  }>;
};

export default class AccessoryBackupStore {
  constructor(
    private readonly directory: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async backup(accessories: PlatformAccessory[], reason: string): Promise<string | undefined> {
    if (accessories.length === 0) {
      return undefined;
    }
    const created = this.now();
    const timestamp = created.toISOString().replace(/[:.]/g, '-');
    const destination = path.join(this.directory, `TuyaAccessoryBackup.${timestamp}.json`);
    const temporary = `${destination}.${process.pid}.tmp`;
    const payload: AccessoryBackup = {
      version: 1,
      createdAt: created.toISOString(),
      reason,
      accessories: accessories.map(accessory => ({
        uuid: accessory.UUID,
        displayName: accessory.displayName,
        deviceId: typeof accessory.context?.deviceID === 'string' ? accessory.context.deviceID : undefined,
        services: accessory.services.map(service => ({
          uuid: service.UUID,
          displayName: service.displayName,
          subtype: service.subtype,
        })),
      })),
    };

    await fs.promises.mkdir(this.directory, { recursive: true });
    try {
      await fs.promises.writeFile(temporary, JSON.stringify(payload, null, 2), { mode: 0o600 });
      await fs.promises.rename(temporary, destination);
      await fs.promises.chmod(destination, 0o600);
      return destination;
    } finally {
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
