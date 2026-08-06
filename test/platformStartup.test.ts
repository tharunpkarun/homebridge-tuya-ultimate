import { API, Logger, PlatformConfig } from 'homebridge';

import { TuyaSharingRequestError } from '../src/core/TuyaSharingAPI';
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
});
