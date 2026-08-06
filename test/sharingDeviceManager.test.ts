import TuyaSharingAPI, { TuyaSharingRequestError } from '../src/core/TuyaSharingAPI';
import TuyaDeviceManager from '../src/device/TuyaDeviceManager';
import TuyaSharingDeviceManager from '../src/device/TuyaSharingDeviceManager';

function success(result: unknown) {
  return { success: true as const, result, t: 1, tid: 'test' };
}

function manager(customType: boolean | string = false) {
  const get = jest.fn().mockImplementation(async (path: string) => {
    if (path === '/v1.0/m/life/ha/home/devices') {
      return success([{
        id: 'device-1',
        uuid: 'uuid-1',
        name: 'Three gang switch',
        online: false,
        owner_id: 'home-1',
        product_id: 'product-1',
        product_name: 'Switch',
        category: 'kg',
        status: [{ code: 'switch_1', value: false }],
        sub: true,
      }]);
    }
    if (path.endsWith('/specifications')) {
      return success({
        functions: [{ code: 'switch_1', type: 'Boolean', values: '{}' }],
        status: [{ code: 'switch_1', type: 'Boolean', values: '{}' }],
      });
    }
    if (path.endsWith('/status')) {
      return success({
        productKey: 'product-1',
        dpStatusRelationDTOS: [{
          dpId: 1,
          supportLocal: true,
          valueConvert: 'default',
          statusCode: 'switch_1',
          statusFormat: '{"switch_1":"$"}',
          valueDesc: '{}',
          valueType: 'Boolean',
          enumMappingMap: {},
        }],
      });
    }
    if (path.endsWith('/code/custom-type')) {
      return success(customType);
    }
    if (path.endsWith('/dp-report-types')) {
      return success([{ dp_code: 'switch_1', report_type: 'minux' }]);
    }
    throw new Error(`Unexpected path: ${path}`);
  });
  const api = {
    tokenInfo: { access_token: '', refresh_token: '', uid: 'user-1', expire: Number.MAX_SAFE_INTEGER },
    get,
    post: jest.fn(),
    postWithQuery: jest.fn(),
  } as unknown as TuyaSharingAPI;
  return { get, deviceManager: new TuyaSharingDeviceManager(api) };
}

describe('Tuya account-sharing device manager', () => {
  test('normalizes account devices for the existing official accessory mappings', async () => {
    const { deviceManager } = manager();
    const [device] = await deviceManager.updateDevices(['home-1']);

    expect(device).toMatchObject({
      id: 'device-1',
      name: 'Three gang switch',
      owner_id: 'home-1',
      category: 'kg',
      support_local: true,
      set_up: true,
    });
    expect(device.schema).toEqual([expect.objectContaining({
      code: 'switch_1',
      mode: 'rw',
      type: 'Boolean',
      report_type: 'minux',
    })]);
    expect(device.local_strategy?.[1]).toMatchObject({
      value_convert: 'default',
      status_code: 'switch_1',
    });
    expect(deviceManager.sharingMq.devices).toEqual([{ id: 'device-1', supportLocal: true }]);
  });

  test('disables raw conversion when Tuya marks a product as custom type', async () => {
    const { deviceManager } = manager('true');
    const [device] = await deviceManager.updateDevices(['home-1']);

    expect(device.support_local).toBe(false);
    expect(device.local_strategy).toEqual({});
    expect(deviceManager.sharingMq.devices).toEqual([{ id: 'device-1', supportLocal: false }]);
  });

  test('converts raw DP reports before handing them to the existing event pipeline', async () => {
    const { deviceManager } = manager();
    const [device] = await deviceManager.updateDevices(['home-1']);
    const listener = jest.fn();
    deviceManager.on(TuyaDeviceManager.Events.DEVICE_STATUS_UPDATE, listener);

    await deviceManager.onMQTTMessage('device/topic', 4, {
      devId: 'device-1',
      status: [{ dpId: 1, value: true, t: 123 }],
    });

    expect(device.status.find(status => status.code === 'switch_1')?.value).toBe(true);
    expect(listener).toHaveBeenCalledWith(device, [{ code: 'switch_1', value: true }]);
  });

  test('normalizes protocol-20 IDs nested inside bizData', async () => {
    const { deviceManager } = manager();
    const [device] = await deviceManager.updateDevices(['home-1']);
    const listener = jest.fn();
    deviceManager.on(TuyaDeviceManager.Events.DEVICE_INFO_UPDATE, listener);

    await deviceManager.onMQTTMessage('owner/topic', 20, {
      bizCode: 'online',
      bizData: { devId: 'device-1', ownerId: 1 },
    });

    expect(device.online).toBe(true);
    expect(listener).toHaveBeenCalledWith(device, expect.objectContaining({ devId: 'device-1' }));
  });

  test('rejects an incomplete multi-home device inventory', async () => {
    const get = jest.fn().mockImplementation(async (path: string, params?: Record<string, unknown>) => {
      if (path === '/v1.0/m/life/ha/home/devices' && params?.homeId === 'home-1') {
        return success([]);
      }
      if (path === '/v1.0/m/life/ha/home/devices' && params?.homeId === 'home-2') {
        return { success: false as const, code: 500, msg: 'temporary', result: undefined };
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    const api = {
      tokenInfo: { access_token: '', refresh_token: '', uid: 'user-1', expire: Number.MAX_SAFE_INTEGER },
      get,
      post: jest.fn(),
      postWithQuery: jest.fn(),
    } as unknown as TuyaSharingAPI;
    const deviceManager = new TuyaSharingDeviceManager(api);

    await expect(deviceManager.updateDevices(['home-1', 'home-2']))
      .rejects.toBeInstanceOf(TuyaSharingRequestError);
    expect(deviceManager.devices).toEqual([]);
  });

  test('rejects a failed scene inventory instead of deleting cached scenes', async () => {
    const api = {
      tokenInfo: { access_token: '', refresh_token: '', uid: 'user-1', expire: Number.MAX_SAFE_INTEGER },
      get: jest.fn().mockResolvedValue({
        success: false as const,
        code: 500,
        msg: 'temporary',
        result: undefined,
      }),
      post: jest.fn(),
      postWithQuery: jest.fn(),
    } as unknown as TuyaSharingAPI;
    const deviceManager = new TuyaSharingDeviceManager(api);

    await expect(deviceManager.getSceneList('home-1'))
      .rejects.toBeInstanceOf(TuyaSharingRequestError);
  });

  test('omits IR remotes when the QR account cannot resolve their metadata and commands', async () => {
    const get = jest.fn().mockImplementation(async (path: string) => {
      if (path === '/v1.0/m/life/ha/home/devices') {
        return success([
          {
            id: 'ir-hub', name: 'IR hub', owner_id: 'home-1', product_id: 'hub-product',
            category: 'hwktwkq', status: [], sub: false,
          },
          {
            id: 'ir-ac', name: 'Bedroom AC', owner_id: 'home-1', product_id: 'ac-product',
            category: 'infrared_ac', status: [], sub: true,
          },
        ]);
      }
      if (path.startsWith('/v2.0/infrareds/')) {
        return { success: false as const, code: 2008, msg: 'app param is invalid', result: undefined };
      }
      if (path.endsWith('/specifications')) {
        return success({ functions: [], status: [] });
      }
      if (path.endsWith('/status')) {
        return success({ productKey: 'product', dpStatusRelationDTOS: [] });
      }
      if (path.endsWith('/code/custom-type')) {
        return success(false);
      }
      if (path.endsWith('/dp-report-types')) {
        return success([]);
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    const api = {
      tokenInfo: { access_token: '', refresh_token: '', uid: 'user-1', expire: Number.MAX_SAFE_INTEGER },
      get,
      post: jest.fn(),
      postWithQuery: jest.fn(),
    } as unknown as TuyaSharingAPI;
    const deviceManager = new TuyaSharingDeviceManager(api);
    const devices = await deviceManager.updateDevices(['home-1']);

    await deviceManager.updateInfraredRemotes(devices);

    expect(devices.map(device => device.id)).toEqual(['ir-hub']);
    expect(get).toHaveBeenCalledWith('/v2.0/infrareds/ir-hub/remotes');
  });
});
