import path from 'node:path';

jest.mock('@homebridge/plugin-ui-utils', () => ({
  HomebridgePluginUiServer: class {},
  RequestError: class RequestError extends Error {},
}));

// The Homebridge custom UI server is JavaScript because it runs as a separate process.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createHandlers, credentialFile, sanitizeDevice } = require('../homebridge-ui/server.js');
import { legacySharingCredentialFile } from '../src/core/TuyaSharingAuth';

const credentials = {
  client_id: 'client-1',
  user_code: 'user-1',
  app_schema: 'smartlife',
  endpoint: 'https://example.test',
  terminal_id: 'terminal-1',
  username: 'Test account',
  token_info: {
    t: 1_700_000_000_000,
    uid: 'uid-1',
    expire_time: 7_200,
    access_token: 'access-token',
    refresh_token: 'refresh-token',
  },
};

class MockCredentialStore {
  static values = new Map<string, typeof credentials>();

  constructor(private readonly file: string) {}

  async load() {
    return MockCredentialStore.values.get(this.file) ?? null;
  }

  async save(value: typeof credentials) {
    MockCredentialStore.values.set(this.file, value);
  }
}

class MockLogin {
  async createQrCode() {
    return { token: 'qr-token', content: 'tuyaSmart--qrLogin?token=qr-token' };
  }

  async loginResult() {
    return credentials;
  }
}

class MockSharingAPI {
  constructor(_options: unknown) {}

  async get(requestPath: string, params?: Record<string, unknown>) {
    if (requestPath === '/v1.0/m/life/users/homes') {
      return {
        success: true,
        result: [
          { ownerId: 'home-1', name: 'Main home' },
          { ownerId: 'home-2', name: 'Workshop' },
        ],
      };
    }
    if (requestPath === '/v1.0/m/life/ha/home/devices' && params?.homeId === 'home-1') {
      return {
        success: true,
        result: [
          {
            id: 'device-1',
            name: 'Hall light https://private.example/device token=do-not-return',
            category: 'dj',
            product_id: 'product-1',
            product_name: 'Light https://private.example/product',
            online: true,
            set_up: true,
            local_key: 'local-key-value',
            lat: '12.345678',
            lon: '67.890123',
            status: [
              { code: 'switch_led', value: true },
              { code: 'work_mode', value: 'white' },
              { code: 'raw_payload', value: 'c2Vuc2l0aXZlLXJhdw==' },
              { code: 'stream_url', value: 'https://private.example/live' },
              { code: 'geo', value: '12.345678,67.890123' },
              { code: 'access_token', value: 'access-token-from-device' },
              { code: 'untyped_number', value: 123456789 },
            ],
          },
          { id: 'device-2', name: 'Door sensor', category: 'mcs', online: false, sub: true },
        ],
      };
    }
    if (requestPath === '/v1.1/m/life/device-1/specifications') {
      return {
        success: true,
        result: {
          functions: [
            { code: 'switch_led', type: 'Boolean', values: '{}' },
            { code: 'work_mode', type: 'Enum', values: '{"range":["white","colour","https://private.example"]}' },
          ],
          status: [
            { code: 'switch_led', type: 'Boolean', values: '{}' },
            { code: 'work_mode', type: 'Enum', values: '{"range":["white","colour","https://private.example"]}' },
            { code: 'raw_payload', type: 'Raw', values: '{}' },
            { code: 'stream_url', type: 'String', values: '{}' },
            { code: 'geo', type: 'String', values: '{}' },
            { code: 'access_token', type: 'String', values: '{}' },
          ],
        },
      };
    }
    if (requestPath === '/v1.1/m/life/device-2/specifications') {
      return {
        success: true,
        result: {
          functions: [],
          status: [{ code: 'doorcontact_state', type: 'Boolean', values: '{}' }],
        },
      };
    }
    throw new Error(`Unexpected API request: ${requestPath}`);
  }
}

describe('Homebridge custom UI server', () => {
  const storagePath = path.join('/tmp', 'homebridge-tuya-ui-test');

  beforeEach(() => {
    MockCredentialStore.values.clear();
  });

  function handlers(overrides: Record<string, unknown> = {}) {
    return createHandlers(storagePath, {
      CredentialStore: MockCredentialStore,
      Login: MockLogin,
      SharingAPI: MockSharingAPI,
      renderQr: async () => 'data:image/png;base64,test',
      ...overrides,
    });
  }

  test('uses a stable credential filename without exposing the User Code', () => {
    const first = credentialFile(storagePath, 'private-user-code');
    const second = credentialFile(storagePath, 'private-user-code');

    expect(first).toBe(second);
    expect(path.dirname(first)).toBe(path.join(storagePath, 'persist'));
    expect(first).toMatch(/TuyaSharing\.[a-f0-9]{16}\.json$/);
    expect(first).not.toContain('private-user-code');
  });

  test('does not draft global overrides or accept URL-shaped device identities', () => {
    expect(sanitizeDevice({ id: 'global', category: 'dj' }, 'home-1')).toMatchObject({
      id: 'global',
      overrideDraft: undefined,
    });
    expect(sanitizeDevice({ id: 'https://private.example/device', category: 'dj' }, 'home-1')).toBeUndefined();
  });

  test('migrates credentials written by the earlier UI storage layout', async () => {
    const legacyFile = legacySharingCredentialFile(storagePath, 'user-1');
    MockCredentialStore.values.set(legacyFile, credentials);

    await expect(handlers().status({
      userCode: 'user-1',
      clientId: 'client-1',
      appSchema: 'smartlife',
    })).resolves.toMatchObject({ connected: true, matchesConfiguration: true });

    expect(MockCredentialStore.values.get(credentialFile(storagePath, 'user-1'))).toEqual(credentials);
  });

  test('returns package information for the dashboard', async () => {
    await expect(handlers().about()).resolves.toMatchObject({
      name: 'Tuya Ultimate',
      packageName: 'homebridge-tuya-ultimate',
      version: expect.any(String),
      repository: 'https://github.com/tharunpkarun/homebridge-tuya-ultimate',
    });
  });

  test('reports whether stored credentials match the selected app identity', async () => {
    MockCredentialStore.values.set(credentialFile(storagePath, 'user-1'), credentials);

    await expect(handlers().status({
      userCode: 'user-1',
      clientId: 'client-1',
      appSchema: 'smartlife',
    })).resolves.toMatchObject({ connected: true, matchesConfiguration: true });

    await expect(handlers().status({
      userCode: 'user-1',
      clientId: 'client-1',
      appSchema: 'tuyaSmart',
    })).resolves.toMatchObject({ connected: true, matchesConfiguration: false });
  });

  test('lists stored QR accounts without exposing their tokens', async () => {
    const file = credentialFile(storagePath, 'user-1');
    MockCredentialStore.values.set(file, credentials);

    const result = await handlers({ listCredentialFiles: async () => [file] }).accounts();

    expect(result).toEqual({
      accounts: [{
        userCode: 'user-1',
        clientId: 'client-1',
        appSchema: 'smartlife',
        username: 'Test account',
        endpoint: 'https://example.test',
        expiresAt: 1_700_007_200_000,
      }],
    });
    expect(JSON.stringify(result)).not.toContain('access-token');
    expect(JSON.stringify(result)).not.toContain('refresh-token');
  });

  test('generates a QR image and stores completed authorization', async () => {
    await expect(handlers().start({ userCode: 'user-1' })).resolves.toEqual({
      state: 'created',
      qrToken: 'qr-token',
      qrImage: 'data:image/png;base64,test',
    });

    await expect(handlers().poll({
      userCode: 'user-1',
      qrToken: 'qr-token',
      appSchema: 'smartlife',
    })).resolves.toMatchObject({ state: 'success', username: 'Test account' });
    expect(MockCredentialStore.values.get(credentialFile(storagePath, 'user-1'))).toEqual(credentials);
  });

  test('loads only selected homes and summarizes their devices', async () => {
    MockCredentialStore.values.set(credentialFile(storagePath, 'user-1'), credentials);

    await expect(handlers().overview({
      userCode: 'user-1',
      clientId: 'client-1',
      appSchema: 'smartlife',
      homeWhitelist: ['home-1'],
    })).resolves.toMatchObject({
      connected: true,
      connectionType: 'account-sharing',
      username: 'Test account',
      homes: [
        { id: 'home-1', selected: true, deviceCount: 2, onlineCount: 1 },
        { id: 'home-2', selected: false, deviceCount: 0, onlineCount: 0 },
      ],
      devices: [
        {
          id: 'device-1',
          online: true,
          homeId: 'home-1',
          connection: { status: 'online', transport: 'cloud', topology: 'direct', setup: 'ready' },
          overrideDraft: { id: 'device-1', category: 'dj' },
        },
        {
          id: 'device-2',
          online: false,
          subDevice: true,
          homeId: 'home-1',
          connection: { status: 'offline', transport: 'cloud', topology: 'sub-device' },
        },
      ],
    });
  });

  test('returns only allowlisted device diagnostics and redacts unsafe status values', async () => {
    MockCredentialStore.values.set(credentialFile(storagePath, 'user-1'), credentials);

    const result = await handlers({
      readRuntimeDiagnostics: async () => ({
        version: 1,
        mqtt: {
          messageCount: 12,
          lastMessageAt: 1_700_000_000_000,
          lastProtocol: 4,
          lastDeviceRef: 'aaaaaaaaaaaaaaaa',
          protocols: { 4: 10, 20: 2, malicious: 'mqtt-secret' },
          endpoint: 'https://private.example/mqtt',
        },
        commands: [
          {
            timestamp: 1_700_000_000_010,
            deviceRef: 'aaaaaaaaaaaaaaaa',
            codes: ['switch_led', 'access_token'],
            requestedRoute: 'hybrid',
            attemptedRoute: 'local',
            outcome: 'failure',
            durationMs: 25,
            errorKind: 'connection',
            value: 'raw-command-value',
            localKey: 'runtime-local-key',
          },
          {
            timestamp: 1_700_000_000_020,
            deviceRef: 'bbbbbbbbbbbbbbbb',
            codes: ['temp_current'],
            requestedRoute: 'cloud',
            attemptedRoute: 'cloud',
            outcome: 'success',
            durationMs: 75,
          },
          {
            timestamp: 1_700_000_000_030,
            deviceRef: 'actual-device-id',
            codes: ['switch_led'],
            requestedRoute: 'cloud',
            attemptedRoute: 'cloud',
            outcome: 'success',
            durationMs: 1,
          },
        ],
        credentials: 'runtime-credentials',
      }),
    }).overview({
      userCode: 'user-1',
      clientId: 'client-1',
      appSchema: 'smartlife',
      homeWhitelist: ['home-1'],
    });
    const device = result.devices[0];

    expect(device).toMatchObject({
      id: 'device-1',
      name: 'Hall light [hidden] [hidden]',
      productId: 'product-1',
      productName: 'Light [hidden]',
      schema: expect.arrayContaining([
        { code: 'switch_led', mode: 'rw', type: 'Boolean', property: {} },
        { code: 'work_mode', mode: 'rw', type: 'Enum', property: { range: ['white', 'colour'] } },
        { code: 'raw_payload', mode: 'ro', type: 'Raw', property: {} },
      ]),
      status: expect.arrayContaining([
        { code: 'switch_led', displayValue: 'true', redacted: false },
        { code: 'work_mode', displayValue: 'white', redacted: false },
        { code: 'raw_payload', displayValue: 'Hidden', redacted: true },
        { code: 'untyped_number', displayValue: 'Hidden', redacted: true },
      ]),
      statusOmittedCount: 3,
      overrideDraft: { id: 'device-1', category: 'dj' },
    });
    expect(result.runtimeDiagnostics).toMatchObject({
      version: 1,
      mqtt: {
        messageCount: 12,
        lastMessageAt: 1_700_000_000_000,
        lastProtocol: 4,
        lastDeviceReference: 'runtime-device-001',
        protocols: [{ protocol: 4, count: 10 }, { protocol: 20, count: 2 }],
      },
      commands: {
        retainedCount: 2,
        outcomeCounts: { success: 1, failure: 1 },
        requestedRouteCounts: { cloud: 1, local: 0, hybrid: 1 },
        attemptedRouteCounts: { cloud: 1, local: 1 },
        durationMs: { min: 25, max: 75, average: 50 },
        lastCommandAt: 1_700_000_000_020,
        recent: [
          expect.objectContaining({
            deviceReference: 'runtime-device-001',
            codes: ['switch_led'],
            outcome: 'failure',
            errorKind: 'connection',
          }),
          expect.objectContaining({
            deviceReference: 'runtime-device-002',
            codes: ['temp_current'],
            outcome: 'success',
          }),
        ],
      },
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('https://');
    expect(serialized).not.toContain('private.example');
    expect(serialized).not.toContain('12.345678');
    expect(serialized).not.toContain('67.890123');
    expect(serialized).not.toContain('local-key-value');
    expect(serialized).not.toContain('access-token-from-device');
    expect(serialized).not.toContain('c2Vuc2l0aXZlLXJhdw==');
    expect(serialized).not.toContain('123456789');
    expect(serialized).not.toContain(credentials.endpoint);
    expect(serialized).not.toContain('aaaaaaaaaaaaaaaa');
    expect(serialized).not.toContain('bbbbbbbbbbbbbbbb');
    expect(serialized).not.toContain('actual-device-id');
    expect(serialized).not.toContain('mqtt-secret');
    expect(serialized).not.toContain('raw-command-value');
    expect(serialized).not.toContain('runtime-local-key');
    expect(serialized).not.toContain('runtime-credentials');
    expect(Object.keys(device)).not.toContain('local_key');
  });

  test('omits missing or malformed runtime diagnostics without breaking the overview', async () => {
    MockCredentialStore.values.set(credentialFile(storagePath, 'user-1'), credentials);

    const result = await handlers({
      readRuntimeDiagnostics: async () => ({ version: 1, mqtt: null, commands: 'not-an-array' }),
    }).overview({
      userCode: 'user-1',
      clientId: 'client-1',
      appSchema: 'smartlife',
      homeWhitelist: ['home-1'],
    });

    expect(result.connected).toBe(true);
    expect(result).not.toHaveProperty('runtimeDiagnostics');
  });
});
