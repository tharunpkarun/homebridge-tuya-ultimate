import fs from 'fs';
import os from 'os';
import path from 'path';

import EnergyHistoryStore from '../src/energy/EnergyHistoryStore';
import TuyaDevice, { TuyaDeviceSchemaMode, TuyaDeviceSchemaType } from '../src/device/TuyaDevice';

const device = () => ({
  id: 'meter-1',
  name: 'Main meter',
  category: 'zndb',
  schema: [
    {
      code: 'cur_power',
      mode: TuyaDeviceSchemaMode.READ_ONLY,
      type: TuyaDeviceSchemaType.Integer,
      property: { min: 0, max: 100000, step: 1, scale: 1, unit: 'W' },
    },
    {
      code: 'unknown_number',
      mode: TuyaDeviceSchemaMode.READ_ONLY,
      type: TuyaDeviceSchemaType.Integer,
      property: { min: 0, max: 100000, step: 1, scale: 0, unit: '' },
    },
  ],
  status: [
    { code: 'cur_power', value: 1234 },
    { code: 'unknown_number', value: 99 },
  ],
} as TuyaDevice);

describe('EnergyHistoryStore', () => {
  test('normalizes allowlisted metrics, merges time buckets, and writes owner-only files', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tuya-energy-'));
    const file = path.join(directory, 'history.json');
    let now = Date.UTC(2026, 7, 6, 12, 0, 0);
    const store = new EnergyHistoryStore(file, { retentionDays: 7, sampleIntervalMinutes: 5 }, () => now);
    const meter = device();

    expect(store.record(meter)).toBe(true);
    now += 60_000;
    expect(store.record(meter, [{ code: 'cur_voltage', value: 2300 }])).toBe(true);

    const samples = store.snapshot().devices['meter-1'].samples;
    expect(samples).toHaveLength(1);
    expect(samples[0].metrics.cur_power).toEqual({ raw: 1234, value: 123.4, scale: 1, unit: 'W' });
    expect(samples[0].metrics.cur_voltage).toEqual({ raw: 2300, value: 2300, scale: 0, unit: '' });
    expect(samples[0].metrics).not.toHaveProperty('unknown_number');

    await store.flush();
    expect(JSON.parse(await fs.promises.readFile(file, 'utf8')).version).toBe(1);
    expect((await fs.promises.stat(file)).mode & 0o777).toBe(0o600);
  });

  test('prunes samples beyond retention', () => {
    const file = path.join(os.tmpdir(), `tuya-energy-${process.pid}-${Date.now()}.json`);
    let now = 1_000_000_000;
    const store = new EnergyHistoryStore(file, { retentionDays: 1, sampleIntervalMinutes: 1 }, () => now);
    const meter = device();
    store.record(meter);
    now += 2 * 24 * 60 * 60 * 1000;
    store.record(meter);
    expect(store.snapshot().devices['meter-1'].samples).toHaveLength(1);
  });

  test('validates loaded history and prunes quiet devices beyond retention', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tuya-energy-load-'));
    const file = path.join(directory, 'history.json');
    const now = 10 * 24 * 60 * 60 * 1000;
    await fs.promises.writeFile(file, JSON.stringify({
      version: 1,
      devices: {
        stale: {
          name: 'Old meter',
          category: 'zndb',
          samples: [{
            timestamp: 1,
            metrics: { cur_power: { raw: 10, value: 10, scale: 0, unit: 'W' } },
          }],
        },
        current: {
          name: 'Current meter',
          category: 'zndb',
          samples: [
            { timestamp: now, metrics: { cur_power: { raw: 20, value: 20, scale: 0, unit: 'W' } } },
            { timestamp: now, metrics: { password: { raw: 1, value: 1, scale: 0, unit: '' } } },
          ],
        },
        malformed: { name: 'Broken', samples: 'not-an-array' },
      },
    }));

    try {
      const store = new EnergyHistoryStore(file, { retentionDays: 1 }, () => now);
      expect(Object.keys(store.snapshot().devices)).toEqual(['current']);
      expect(store.snapshot().devices.current.samples).toHaveLength(1);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });
});
