import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  DEFAULT_CLIENT_ID,
  DEFAULT_SCHEMA,
  legacySharingCredentialFile,
  sharingCredentialFile,
  TuyaSharingCredentials,
  TuyaSharingCredentialStore,
  TuyaSharingLogin,
} from '../src/core/TuyaSharingAuth';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Tuya account-sharing QR login', () => {
  test('uses Homebridge persist storage for QR credentials', () => {
    expect(sharingCredentialFile('/homebridge', 'private-user-code'))
      .toMatch(/^\/homebridge\/persist\/TuyaSharing\.[a-f0-9]{16}\.json$/);
    expect(legacySharingCredentialFile('/homebridge', 'private-user-code'))
      .toMatch(/^\/homebridge\/TuyaSharing\.[a-f0-9]{16}\.json$/);
  });

  test('defaults to Home Assistant compatibility identity', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({
      success: true,
      result: { qrcode: 'compatibility-token' },
    }));
    const login = new TuyaSharingLogin(undefined, 'https://login.example.test', fetchMock);

    await login.createQrCode('user-code');

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('clientid')).toBe(DEFAULT_CLIENT_ID);
    expect(url.searchParams.get('schema')).toBe(DEFAULT_SCHEMA);
  });

  test('creates a QR accepted by both Smart Life and Tuya Smart', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({
      success: true,
      result: { qrcode: 'fresh-qr-token' },
    }));
    const login = new TuyaSharingLogin('client-id', 'https://login.example.test', fetchMock, 'test-authorize');

    await expect(login.createQrCode('user-code')).resolves.toEqual({
      token: 'fresh-qr-token',
      content: 'tuyaSmart--qrLogin?token=fresh-qr-token',
    });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/v1.0/m/life/home-assistant/qrcode/tokens');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      clientid: 'client-id',
      usercode: 'user-code',
      schema: 'test-authorize',
    });
  });

  test('uses the QR schema issued with a non-Home-Assistant integration ID', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({
      success: true,
      result: { qrcode: 'qr-token' },
    }));
    const login = new TuyaSharingLogin(
      'homebridge-client-id',
      'https://login.example.test',
      fetchMock,
      'homebridge-authorize',
    );

    await login.createQrCode('user-code');

    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('schema')).toBe('homebridge-authorize');
  });

  test.each(['smartlife', 'tuyaSmart'] as const)('records the authorizing %s app', async appSchema => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({
      success: true,
      t: 1_710_000_000_000,
      result: {
        uid: 'user-1',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expire_time: 7200,
        terminal_id: 'terminal-1',
        endpoint: 'https://account-api.example.test',
        username: 'Example User',
      },
    }));
    const login = new TuyaSharingLogin('client-id', 'https://login.example.test', fetchMock);

    await expect(login.loginResult('qr-token', 'user-code', appSchema)).resolves.toMatchObject({
      client_id: 'client-id',
      user_code: 'user-code',
      app_schema: appSchema,
      terminal_id: 'terminal-1',
      endpoint: 'https://account-api.example.test',
      token_info: {
        t: 1_710_000_000_000,
        uid: 'user-1',
        expire_time: 7200,
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      },
    });
  });

  test('keeps polling while Tuya is waiting for a scan or confirmation', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ success: false, code: 'LOGIN_PENDING', msg: 'pending' }))
      .mockResolvedValueOnce(jsonResponse({ success: false, code: 'E0020003', msg: 'Please scan and try again' }));
    const login = new TuyaSharingLogin('client-id', 'https://login.example.test', fetchMock);

    await expect(login.loginResult('qr-token', 'user-code', 'tuyaSmart')).resolves.toBeNull();
    await expect(login.loginResult('qr-token', 'user-code', 'smartlife')).resolves.toBeNull();
  });

  test('rejects expired QR codes so the UI can generate a fresh token', async () => {
    const login = new TuyaSharingLogin(
      'client-id',
      'https://login.example.test',
      jest.fn().mockResolvedValue(jsonResponse({ success: false, code: 'QR_EXPIRED', msg: 'expired' })),
    );
    await expect(login.loginResult('old-token', 'user-code', 'tuyaSmart')).rejects.toThrow('QR_EXPIRED');
  });

  test('stores account tokens outside config with owner-only permissions', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'homebridge-tuya-sharing-'));
    const file = path.join(directory, 'credentials.json');
    const store = new TuyaSharingCredentialStore(file);
    const value: TuyaSharingCredentials = {
      client_id: 'client-id',
      user_code: 'user-code',
      app_schema: 'smartlife',
      terminal_id: 'terminal-id',
      endpoint: 'https://account-api.example.test',
      token_info: {
        t: 1,
        uid: 'uid',
        expire_time: 7200,
        access_token: 'access',
        refresh_token: 'refresh',
      },
    };

    try {
      await store.save(value);
      await expect(store.load()).resolves.toEqual(value);
      expect((await fs.promises.stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });
});
