import path from 'node:path';

jest.mock('@homebridge/plugin-ui-utils', () => ({
  HomebridgePluginUiServer: class {},
  RequestError: class RequestError extends Error {},
}));

// The Homebridge custom UI server is JavaScript because it runs as a separate process.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createHandlers, credentialFile } = require('../homebridge-ui/server.js');
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
          { id: 'device-1', name: 'Hall light', category: 'dj', online: true },
          { id: 'device-2', name: 'Door sensor', category: 'mcs', online: false, sub: true },
        ],
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
      username: 'Test account',
      homes: [
        { id: 'home-1', selected: true, deviceCount: 2, onlineCount: 1 },
        { id: 'home-2', selected: false, deviceCount: 0, onlineCount: 0 },
      ],
      devices: [
        { id: 'device-1', online: true, homeId: 'home-1' },
        { id: 'device-2', online: false, subDevice: true, homeId: 'home-1' },
      ],
    });
  });
});
