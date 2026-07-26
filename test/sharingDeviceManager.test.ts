import TuyaSharingAPI from '../src/core/TuyaSharingAPI';
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
});
