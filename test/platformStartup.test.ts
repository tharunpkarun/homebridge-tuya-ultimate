import { API, Logger, PlatformConfig } from 'homebridge';

import { TuyaPlatformAccountConfigOptions } from '../src/config';
import { TuyaSharingRequestError } from '../src/core/TuyaSharingAPI';
import TuyaOpenAPI from '../src/core/TuyaOpenAPI';
import TuyaDevice from '../src/device/TuyaDevice';
import TuyaDeviceManager from '../src/device/TuyaDeviceManager';
import { TuyaPlatform } from '../src/platform';

type Listener = () => unknown;

function createPlatform() {
  const listeners = new Map<string, Listener>();
  const log = {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  } as unknown as Logger;
  const api = {
    hap: {
      Characteristic: {},
      Service: {},
    },
    on: jest.fn((event: string, listener: Listener) => {
      listeners.set(event, listener);
      return api;
    }),
    registerPlatformAccessories: jest.fn(),
    unregisterPlatformAccessories: jest.fn(),
    updatePlatformAccessories: jest.fn(),
    user: {
      persistPath: () => '/tmp/homebridge-tuya-platform-test',
      storagePath: () => '/tmp/homebridge-tuya-platform-test',
    },
  } as unknown as API;
  const config = {
    platform: 'TuyaPlatform',
    name: 'Tuya',
    options: {
      projectType: '3',
      userCode: 'user-code',
      appSchema: 'smartlife',
      generateWeatherAccessory: false,
      weatherAPI: 'open-meteo',
      forceIPv4: false,
    },
  } as unknown as PlatformConfig;

  return {
    platform: new TuyaPlatform(log, config, api),
    api,
    listeners,
    log,
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('Tuya platform startup resilience', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('absorbs account discovery failures and retries without terminating the child bridge', async () => {
    const { platform, listeners, log } = createPlatform();
    const initDevices = jest.spyOn(platform, 'initDevices')
      .mockRejectedValueOnce(new TuyaSharingRequestError('fetch failed', true))
      .mockResolvedValueOnce(undefined);

    expect(listeners.get('didFinishLaunching')?.()).toBeUndefined();
    await flushPromises();

    expect(initDevices).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      'Tuya account discovery failed: %s. Retrying in %d seconds without stopping the child bridge.',
      'fetch failed',
      15,
    );
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(15_000);
    await flushPromises();

    expect(initDevices).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
    await listeners.get('shutdown')?.();
  });

  test('cancels a pending account discovery retry during shutdown', async () => {
    const { platform, listeners } = createPlatform();
    const initDevices = jest.spyOn(platform, 'initDevices')
      .mockRejectedValue(new TuyaSharingRequestError('fetch failed', true));

    listeners.get('didFinishLaunching')?.();
    await flushPromises();
    expect(jest.getTimerCount()).toBe(1);

    await listeners.get('shutdown')?.();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(120_000);

    expect(initDevices).toHaveBeenCalledTimes(1);
  });

  test('does not replay initialization after a non-transport failure', async () => {
    const { platform, listeners, log } = createPlatform();
    const initDevices = jest.spyOn(platform, 'initDevices')
      .mockRejectedValue(new Error('accessory configuration failed'));

    listeners.get('didFinishLaunching')?.();
    await flushPromises();

    expect(initDevices).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(log.error).toHaveBeenCalledWith(
      'Tuya device discovery failed: %s',
      'accessory configuration failed',
    );
  });

  test('stops an in-flight discovery that finishes after shutdown', async () => {
    const { platform, listeners, api } = createPlatform();
    let resolveInfrared!: () => void;
    const infraredDiscovery = new Promise<void>(resolve => {
      resolveInfrared = resolve;
    });
    const deviceManager = {
      setLocalCommandRouter: jest.fn(),
      setRuntimeDiagnostics: jest.fn(),
      stop: jest.fn(),
      updateInfraredRemotes: jest.fn(() => infraredDiscovery),
    } as unknown as TuyaDeviceManager;
    jest.spyOn(platform, 'initAccountProject').mockImplementation(async () => {
      platform.deviceManager = deviceManager;
      return [{} as TuyaDevice];
    });

    listeners.get('didFinishLaunching')?.();
    await flushPromises();
    expect(deviceManager.updateInfraredRemotes).toHaveBeenCalledTimes(1);

    await listeners.get('shutdown')?.();
    resolveInfrared();
    await flushPromises();

    expect(deviceManager.stop).toHaveBeenCalled();
    expect(platform.deviceManager).toBeUndefined();
    expect(api.registerPlatformAccessories).not.toHaveBeenCalled();
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();
  });

  test.each([
    ['the dedicated hidden flag', { id: 'hidden-device', hidden: true }],
    ['the legacy hidden category', { id: 'hidden-device', category: 'hidden' }],
  ])('does not publish accessories hidden with %s', (_description, override) => {
    const { platform, api } = createPlatform();
    platform.options.deviceOverrides = [override];
    const device = new TuyaDevice({
      id: 'hidden-device',
      name: 'Hidden device',
      category: 'kg',
      product_id: 'product-1',
      schema: [],
      status: [],
    });

    platform.addAccessory(device);

    expect(device.hidden).toBe(true);
    expect(device.category).toBe('kg');
    expect(api.registerPlatformAccessories).not.toHaveBeenCalled();
  });

  test('applies the configured QR IR thermostat LAN address to the runtime device', () => {
    const { platform } = createPlatform();
    platform.options.deviceOverrides = [{
      id: 'ir-ac',
      hidden: true,
      irAirConditionerLocalIp: ' 192.168.1.50 ',
    }];
    const device = new TuyaDevice({
      id: 'ir-ac',
      uuid: 'ir-ac',
      name: 'Bedroom AC',
      category: 'infrared_ac',
      product_id: 'ir-product',
      schema: [],
      status: [],
    });

    platform.addAccessory(device);

    expect(device.infrared_ac_local_ip).toBe('192.168.1.50');
  });

  test('authenticates the QR product API with a Developer Cloud project token', async () => {
    const { platform, log } = createPlatform();
    (platform.options as TuyaPlatformAccountConfigOptions).developerCloudFallback = {
      enabled: true,
      endpoint: 'https://openapi.tuyain.com',
      accessId: 'project-access-id',
      accessKey: 'project-access-secret',
    };
    const primary = {
      setProductApiFallback: jest.fn(),
    } as unknown as TuyaDeviceManager;
    const getToken = jest.spyOn(TuyaOpenAPI.prototype, 'getToken').mockResolvedValue({
      success: true,
      result: {
        access_token: 'project-token',
        refresh_token: 'refresh-token',
        uid: 'project-uid',
        expire_time: 7200,
      },
      t: Date.now(),
      tid: 'test',
    });
    const homeLogin = jest.spyOn(TuyaOpenAPI.prototype, 'homeLogin');

    await (platform as unknown as {
      configureDeveloperCloudFallback(manager: TuyaDeviceManager, debug: boolean): Promise<void>;
    }).configureDeveloperCloudFallback(primary, false);

    expect(getToken).toHaveBeenCalledTimes(1);
    expect(homeLogin).not.toHaveBeenCalled();
    expect(primary.setProductApiFallback).toHaveBeenCalledWith(expect.any(TuyaDeviceManager));
    expect(log.info).toHaveBeenCalledWith(
      'Developer Cloud product API is active for QR-mode IR, locks, and cameras (project-token authentication).',
    );
    getToken.mockRestore();
    homeLogin.mockRestore();
  });
});
