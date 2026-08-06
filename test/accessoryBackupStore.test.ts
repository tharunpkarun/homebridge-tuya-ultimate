import fs from 'fs';
import os from 'os';
import path from 'path';
import { PlatformAccessory } from 'homebridge';

import AccessoryBackupStore from '../src/migration/AccessoryBackupStore';

describe('AccessoryBackupStore', () => {
  test('writes a minimal owner-only migration backup', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tuya-accessory-backup-'));
    const store = new AccessoryBackupStore(directory, () => new Date('2026-08-06T12:00:00.000Z'));
    const accessory = {
      UUID: 'accessory-uuid',
      displayName: 'Old switch',
      context: { deviceID: 'device-1', token: 'must-not-be-copied' },
      services: [{ UUID: 'service-uuid', displayName: 'Switch', subtype: 'switch_1', characteristics: ['secret'] }],
    } as unknown as PlatformAccessory;

    const file = await store.backup([accessory], 'stale-accessory-cleanup');
    const backup = JSON.parse(await fs.promises.readFile(file!, 'utf8'));

    expect(backup).toEqual({
      version: 1,
      createdAt: '2026-08-06T12:00:00.000Z',
      reason: 'stale-accessory-cleanup',
      accessories: [{
        uuid: 'accessory-uuid',
        displayName: 'Old switch',
        deviceId: 'device-1',
        services: [{ uuid: 'service-uuid', displayName: 'Switch', subtype: 'switch_1' }],
      }],
    });
    expect(JSON.stringify(backup)).not.toContain('must-not-be-copied');
    expect((await fs.promises.stat(file!)).mode & 0o777).toBe(0o600);
  });

  test('does not create an empty backup', async () => {
    const store = new AccessoryBackupStore(os.tmpdir());
    await expect(store.backup([], 'nothing')).resolves.toBeUndefined();
  });
});
