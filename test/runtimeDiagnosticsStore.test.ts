import fs from 'fs';
import os from 'os';
import path from 'path';

import RuntimeDiagnosticsStore from '../src/diagnostics/RuntimeDiagnosticsStore';

describe('RuntimeDiagnosticsStore', () => {
  let directory: string;
  let file: string;

  beforeEach(async () => {
    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tuya-diagnostics-'));
    file = path.join(directory, 'TuyaRuntimeDiagnostics.json');
  });

  afterEach(async () => {
    await fs.promises.rm(directory, { recursive: true, force: true });
  });

  test('stores MQTT freshness and command metadata without identifiers, values, or raw errors', async () => {
    let now = 1_000;
    const store = new RuntimeDiagnosticsStore(file, () => now);

    store.recordMqtt(4, 'real-device-id-123');
    now = 1_025;
    store.recordCommand('real-device-id-123', ['switch', 'temp_set', 'bad secret code'], {
      requestedRoute: 'hybrid',
      attemptedRoute: 'local',
      outcome: 'failure',
      durationMs: 25.4,
      error: new Error('connect ECONNREFUSED 192.0.2.1 local-key-secret'),
    });
    await store.flush();

    const text = await fs.promises.readFile(file, 'utf8');
    expect(text).not.toContain('real-device-id-123');
    expect(text).not.toContain('192.0.2.1');
    expect(text).not.toContain('local-key-secret');

    const snapshot = store.snapshot();
    expect(snapshot.mqtt).toMatchObject({
      messageCount: 1,
      lastMessageAt: 1_000,
      lastProtocol: 4,
      protocols: { 4: 1 },
    });
    expect(snapshot.mqtt.lastDeviceRef).toMatch(/^[a-f0-9]{16}$/);
    expect(snapshot.commands).toEqual([expect.objectContaining({
      timestamp: 1_025,
      deviceRef: snapshot.mqtt.lastDeviceRef,
      codes: ['switch', 'temp_set'],
      requestedRoute: 'hybrid',
      attemptedRoute: 'local',
      outcome: 'failure',
      durationMs: 25,
      errorKind: 'connection',
    })]);
    expect((await fs.promises.stat(file)).mode & 0o777).toBe(0o600);
  });

  test('bounds command history and never persists command values', () => {
    const store = new RuntimeDiagnosticsStore(file, () => 5_000);
    for (let index = 0; index < 120; index++) {
      store.recordCommand(`device-${index}`, ['switch'], {
        requestedRoute: 'cloud',
        attemptedRoute: 'cloud',
        outcome: 'success',
        durationMs: index,
      });
    }

    const snapshot = store.snapshot();
    expect(snapshot.commands).toHaveLength(100);
    expect(JSON.stringify(snapshot)).not.toContain('device-119');
    expect(snapshot.commands.at(-1)?.durationMs).toBe(119);
  });

  test('does not trust command strings loaded from disk', async () => {
    await fs.promises.writeFile(file, JSON.stringify({
      version: 1,
      mqtt: {
        messageCount: 7,
        protocols: { 4: 7, malicious: 'secret' },
      },
      commands: [{ error: 'secret', deviceRef: 'real-id' }],
      secret: 'must-not-load',
    }));

    const store = new RuntimeDiagnosticsStore(file);
    expect(store.snapshot()).toEqual({
      version: 1,
      mqtt: { messageCount: 7, protocols: { 4: 7 } },
      commands: [],
    });
  });
});
