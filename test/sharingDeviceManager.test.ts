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

  test('exposes a QR-authorized IR AC through its normal sharing functions', async () => {
    const irACSpecification = {
      functions: [
        { code: 'F', type: 'Enum', values: '{"min":0,"max":3,"scale":0,"step":1,"type":"Integer"}' },
        { code: 'M', type: 'Enum', values: '{"min":0,"max":4,"scale":0,"step":1,"type":"Integer"}' },
        { code: 'PowerOff', type: 'String', values: 'PowerOff' },
        { code: 'PowerOn', type: 'String', values: 'PowerOn' },
        { code: 'T', type: 'Enum', values: '{"min":16,"max":30,"scale":0,"step":1,"type":"Integer"}' },
      ],
      status: [
        { code: 'wind', type: 'Enum', values: '{"min":0,"max":3,"scale":0,"step":1,"type":"Integer"}' },
        { code: 'mode', type: 'Enum', values: '{"min":0,"max":4,"scale":0,"step":1,"type":"Integer"}' },
        { code: 'power', type: 'Boolean', values: '{}' },
        { code: 'temp', type: 'Enum', values: '{"min":16,"max":30,"scale":0,"step":1,"type":"Integer"}' },
      ],
    };
    const get = jest.fn().mockImplementation(async (path: string) => {
      if (path === '/v1.0/m/life/ha/home/devices') {
        return success([{
          id: 'ir-ac',
          uuid: 'ir-ac-uuid',
          name: 'Bedroom AC',
          owner_id: 'home-1',
          product_id: 'qzktzhehinzsz2je',
          product_name: 'Air Conditioning',
          category: 'infrared_ac',
          status: [],
          sub: true,
          set_up: false,
        }]);
      }
      if (path === '/v1.1/m/life/ir-ac/specifications') {
        return success(irACSpecification);
      }
      if (path.endsWith('/status')) {
        return success({ productKey: 'qzktzhehinzsz2je', dpStatusRelationDTOS: [] });
      }
      if (path.endsWith('/code/custom-type')) {
        return success(false);
      }
      if (path.endsWith('/dp-report-types')) {
        return success([]);
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    const postWithQuery = jest.fn().mockResolvedValue(success(true));
    const api = {
      tokenInfo: { access_token: '', refresh_token: '', uid: 'user-1', expire: Number.MAX_SAFE_INTEGER },
      get,
      post: jest.fn(),
      postWithQuery,
    } as unknown as TuyaSharingAPI;
    const deviceManager = new TuyaSharingDeviceManager(api);
    const devices = await deviceManager.updateDevices(['home-1']);

    await deviceManager.updateInfraredRemotes(devices);

    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      id: 'ir-ac',
      product_id: 'qzktzhehinzsz2je',
      category: 'infrared_ac',
      set_up: true,
      infrared_ac_command_mode: 'device-sharing',
      status: [
        { code: 'mode', value: 0 },
        { code: 'power', value: false },
        { code: 'temp', value: 25 },
        { code: 'wind', value: 0 },
      ],
    });
    expect(devices[0].schema).toHaveLength(9);
    expect(devices[0].schema.map(item => [item.code, item.mode])).toEqual(expect.arrayContaining([
      ['F', 'wo'],
      ['M', 'wo'],
      ['PowerOff', 'wo'],
      ['PowerOn', 'wo'],
      ['T', 'wo'],
      ['mode', 'ro'],
      ['power', 'ro'],
      ['temp', 'ro'],
      ['wind', 'ro'],
    ]));
    expect(devices[0].remote_keys?.key_range.map(item => item.mode)).toEqual([0, 1, 2, 3, 4]);
    expect(devices[0].remote_keys?.key_range[0].temp_list.map(item => item.temp))
      .toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
    expect(devices[0].remote_keys?.key_range[0].temp_list[0].fan_list.map(item => item.fan))
      .toEqual([0, 1, 2, 3]);
    expect(deviceManager.sharingMq.devices).toEqual([{ id: 'ir-ac', supportLocal: false }]);
    expect(get).not.toHaveBeenCalledWith(expect.stringMatching(/^\/v2\.0\/infrareds\//));

    await expect(deviceManager.getInfraredACStatus('', 'ir-ac')).resolves.toMatchObject({
      success: true,
      result: { power: false, mode: 0, temp: 25, wind: 0 },
    });
    await deviceManager.sendInfraredACCommands('', 'ir-ac', 1, 0, 25, 0);
    expect(postWithQuery).toHaveBeenLastCalledWith(
      '/v1.1/m/thing/ir-ac/commands',
      undefined,
      { commands: [
        { code: 'M', value: 0 },
        { code: 'T', value: 25 },
        { code: 'F', value: 0 },
        { code: 'PowerOn', value: 'PowerOn' },
      ] },
    );

    await deviceManager.sendInfraredACCommands('', 'ir-ac', 0, 0, 25, 0);
    expect(postWithQuery).toHaveBeenLastCalledWith(
      '/v1.1/m/thing/ir-ac/commands',
      undefined,
      { commands: [{ code: 'PowerOff', value: 'PowerOff' }] },
    );
  });

  test('exposes an IR AC whose sharing functions are embedded in the device mapping', async () => {
    const infraredMapping = {
      wind: {
        code: 'wind', type: 'ENUM',
        values: { min: 0, max: 3, scale: 0, step: 1, type: 'Integer' },
      },
      mode: {
        code: 'mode', type: 'ENUM',
        values: { min: 0, max: 4, scale: 0, step: 1, type: 'Integer' },
      },
      power: { code: 'power', type: 'BOOLEAN', values: {} },
      temp: {
        code: 'temp', type: 'ENUM',
        values: { min: 16, max: 30, scale: 0, step: 1, type: 'Integer' },
      },
      F: {
        code: 'F', type: 'ENUM',
        values: { min: 0, max: 3, scale: 0, step: 1, type: 'Integer' },
      },
      M: {
        code: 'M', type: 'ENUM',
        values: { min: 0, max: 4, scale: 0, step: 1, type: 'Integer' },
      },
      PowerOff: { code: 'PowerOff', type: 'STRING', values: 'PowerOff' },
      PowerOn: { code: 'PowerOn', type: 'STRING', values: 'PowerOn' },
      T: {
        code: 'T', type: 'ENUM',
        values: { min: 16, max: 30, scale: 0, step: 1, type: 'Integer' },
      },
    };
    const get = jest.fn().mockImplementation(async (path: string) => {
      if (path === '/v1.0/m/life/ha/home/devices') {
        return success([
          {
            id: 'ir-hub', name: 'IR Thermostat', owner_id: 'home-1',
            product_id: 'aqlyorlybbtn6ox7', product_name: 'IR Thermostat',
            category: 'hwktwkq', status: [], sub: false,
          },
          {
            id: 'ir-ac', name: 'Bedroom AC', owner_id: 'home-1',
            product_id: 'qzktzhehinzsz2je', product_name: 'Air Conditioning',
            category: 'infrared_ac', status: [], sub: true, set_up: false,
            parent: 'ir-hub', mapping: infraredMapping,
          },
        ]);
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
    const postWithQuery = jest.fn().mockResolvedValue(success(true));
    const api = {
      tokenInfo: { access_token: '', refresh_token: '', uid: 'user-1', expire: Number.MAX_SAFE_INTEGER },
      get,
      post: jest.fn(),
      postWithQuery,
    } as unknown as TuyaSharingAPI;
    const deviceManager = new TuyaSharingDeviceManager(api);
    const devices = await deviceManager.updateDevices(['home-1']);

    await deviceManager.updateInfraredRemotes(devices);

    expect(devices).toHaveLength(2);
    const hub = devices.find(device => device.id === 'ir-hub')!;
    const airConditioner = devices.find(device => device.id === 'ir-ac')!;
    expect(hub.schema).toEqual([]);
    expect(hub.status).toEqual([]);
    expect(airConditioner).toMatchObject({
      parent_id: 'ir-hub',
      set_up: true,
      infrared_ac_command_mode: 'device-sharing',
    });
    expect(airConditioner.schema.map(item => [item.code, item.mode])).toEqual(expect.arrayContaining([
      ['F', 'wo'],
      ['M', 'wo'],
      ['PowerOff', 'wo'],
      ['PowerOn', 'wo'],
      ['T', 'wo'],
      ['mode', 'ro'],
      ['power', 'ro'],
      ['temp', 'ro'],
      ['wind', 'ro'],
    ]));
    expect(airConditioner.status).toEqual([
      { code: 'mode', value: 0 },
      { code: 'power', value: false },
      { code: 'temp', value: 25 },
      { code: 'wind', value: 0 },
    ]);
    expect(airConditioner.remote_keys?.key_range).not.toHaveLength(0);
    expect(get).not.toHaveBeenCalledWith(expect.stringMatching(/^\/v2\.0\/infrareds\//));

    await deviceManager.sendInfraredACCommands('ir-hub', 'ir-ac', 1, 1, 23, 2);
    expect(postWithQuery).toHaveBeenLastCalledWith(
      '/v1.1/m/thing/ir-ac/commands',
      undefined,
      { commands: [
        { code: 'M', value: 1 },
        { code: 'T', value: 23 },
        { code: 'F', value: 2 },
        { code: 'PowerOn', value: 'PowerOn' },
      ] },
    );
  });

  test('exposes static buttons from an inventory-mapped QR IR remote', async () => {
    const get = jest.fn().mockImplementation(async (path: string) => {
      if (path === '/v1.0/m/life/ha/home/devices') {
        return success([
          {
            id: 'ir-hub', name: 'IR hub', owner_id: 'home-1', product_id: 'hub-product',
            category: 'wnykq', status: [], sub: false,
          },
          {
            id: 'ir-tv', name: 'Living room TV', owner_id: 'home-1', product_id: '000000dp6t',
            category: 'infrared_tv', status: [], sub: true, set_up: false, parent: 'ir-hub',
            mapping: JSON.stringify([
              { code: 'Power', type: 'STRING', value: 'Power' },
              { code: '0', type: 'STRING', value: 0 },
              {
                code: 'C', type: 'ENUM',
                value: { min: 1, max: 999, scale: 0, step: 1, type: 'Integer' },
              },
            ]),
          },
        ]);
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
    const postWithQuery = jest.fn().mockResolvedValue(success(true));
    const api = {
      tokenInfo: { access_token: '', refresh_token: '', uid: 'user-1', expire: Number.MAX_SAFE_INTEGER },
      get,
      post: jest.fn(),
      postWithQuery,
    } as unknown as TuyaSharingAPI;
    const deviceManager = new TuyaSharingDeviceManager(api);
    const devices = await deviceManager.updateDevices(['home-1']);

    await deviceManager.updateInfraredRemotes(devices);

    const television = devices.find(device => device.id === 'ir-tv')!;
    expect(television).toMatchObject({
      parent_id: 'ir-hub',
      set_up: true,
      infrared_remote_command_mode: 'device-sharing',
    });
    expect(television.schema.map(item => item.code)).toEqual(['0', 'Power']);
    expect(television.remote_keys?.key_list.map(item => item.key)).toEqual(['0', 'Power']);
    expect(get).not.toHaveBeenCalledWith(expect.stringMatching(/^\/v2\.0\/infrareds\//));

    await deviceManager.sendInfraredCommands('ir-hub', 'ir-tv', 999, 0, '0', 0);
    expect(postWithQuery).toHaveBeenLastCalledWith(
      '/v1.1/m/thing/ir-tv/commands',
      undefined,
      { commands: [{ code: '0', value: 0 }] },
    );
  });

  test('uses explicitly directed function and status-range data embedded in an inventory device', async () => {
    const get = jest.fn().mockImplementation(async (path: string) => {
      if (path === '/v1.0/m/life/ha/home/devices') {
        return success([{
          id: 'embedded-switch', name: 'Embedded switch', owner_id: 'home-1', product_id: 'switch-product',
          category: 'kg', status: { switch_1: false }, sub: false,
          function: {
            switch_1: { type: 'BOOLEAN', value: {} },
          },
          status_range: [{ code: 'switch_1', type: 'BOOL', value: {} }],
        }]);
      }
      if (path.endsWith('/specifications')) {
        return success({ functions: [], status: [] });
      }
      if (path.endsWith('/status')) {
        return success({ productKey: 'switch-product', dpStatusRelationDTOS: [] });
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

    const [device] = await deviceManager.updateDevices(['home-1']);

    expect(device.schema).toEqual([{
      code: 'switch_1', mode: 'rw', type: 'Boolean', property: {}, report_type: undefined,
    }]);
    expect(device.status).toEqual([{ code: 'switch_1', value: false }]);
  });

  test.each([
    [
      'standard enum ranges',
      '{"range":["0","1","2"]}',
      '{"range":["16","17","18"]}',
    ],
    [
      'nonzero integer scale',
      '{"min":0,"max":2,"scale":0,"step":1,"type":"Integer"}',
      '{"min":160,"max":300,"scale":1,"step":1,"type":"Integer"}',
    ],
  ])('rejects a QR IR AC with unsupported %s descriptors', async (_label, modeValues, temperatureValues) => {
    const get = jest.fn().mockImplementation(async (path: string) => {
      if (path === '/v1.0/m/life/ha/home/devices') {
        return success([{
          id: 'ir-ac', name: 'Bedroom AC', owner_id: 'home-1', product_id: 'ac-product',
          category: 'infrared_ac', status: [], sub: true, set_up: false,
        }]);
      }
      if (path.endsWith('/specifications')) {
        return success({
          functions: [
            { code: 'M', type: 'Enum', values: modeValues },
            { code: 'PowerOff', type: 'String', values: 'PowerOff' },
            { code: 'PowerOn', type: 'String', values: 'PowerOn' },
            { code: 'T', type: 'Enum', values: temperatureValues },
          ],
          status: [],
        });
      }
      if (path.endsWith('/status')) {
        return success({ productKey: 'ac-product', dpStatusRelationDTOS: [] });
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

    expect(devices).toEqual([]);
    expect(deviceManager.sharingMq.devices).toEqual([]);
  });

  test('preserves a QR IR AC cloud shadow instead of replacing it with defaults', async () => {
    const get = jest.fn().mockImplementation(async (path: string) => {
      if (path === '/v1.0/m/life/ha/home/devices') {
        return success([{
          id: 'ir-ac', name: 'Bedroom AC', owner_id: 'home-1', product_id: 'ac-product',
          category: 'infrared_ac', sub: true,
          status: [
            { code: 'power', value: true },
            { code: 'mode', value: 1 },
            { code: 'temp', value: 22 },
            { code: 'wind', value: 2 },
          ],
        }]);
      }
      if (path.endsWith('/specifications')) {
        return success({
          functions: [
            { code: 'M', type: 'Enum', values: '{"min":0,"max":4,"scale":0,"step":1,"type":"Integer"}' },
            { code: 'PowerOff', type: 'String', values: 'PowerOff' },
            { code: 'PowerOn', type: 'String', values: 'PowerOn' },
            { code: 'T', type: 'Enum', values: '{"min":16,"max":30,"scale":0,"step":1,"type":"Integer"}' },
          ],
          status: [],
        });
      }
      if (path.endsWith('/status')) {
        return success({ productKey: 'ac-product', dpStatusRelationDTOS: [] });
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

    expect(Object.fromEntries(devices[0].status.map(item => [item.code, item.value]))).toEqual({
      power: true,
      mode: 1,
      temp: 22,
      wind: 2,
    });
  });

  test('finalizes a compatible IR AC added after startup before publishing it', async () => {
    const get = jest.fn().mockImplementation(async (path: string) => {
      if (path === '/v1.0/m/life/ha/devices/detail') {
        return success([{
          id: 'new-ir-ac', name: 'New AC', owner_id: 'home-1', product_id: 'ac-product',
          category: 'infrared_ac', status: [], sub: true, set_up: false,
        }]);
      }
      if (path.endsWith('/specifications')) {
        return success({
          functions: [
            { code: 'M', type: 'Enum', values: '{"min":0,"max":4,"scale":0,"step":1,"type":"Integer"}' },
            { code: 'PowerOff', type: 'String', values: 'PowerOff' },
            { code: 'PowerOn', type: 'String', values: 'PowerOn' },
            { code: 'T', type: 'Enum', values: '{"min":16,"max":30,"scale":0,"step":1,"type":"Integer"}' },
          ],
          status: [],
        });
      }
      if (path.endsWith('/status')) {
        return success({ productKey: 'ac-product', dpStatusRelationDTOS: [] });
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
    deviceManager.ownerIDs = ['home-1'];

    const device = await deviceManager.updateDevice('new-ir-ac');

    expect(device).toMatchObject({
      id: 'new-ir-ac',
      set_up: true,
      infrared_ac_command_mode: 'device-sharing',
    });
    expect(device?.status.map(item => item.code)).toEqual(['mode', 'power', 'temp', 'wind']);
    expect(device?.remote_keys?.key_range).not.toHaveLength(0);
    expect(deviceManager.sharingMq.devices).toEqual([{ id: 'new-ir-ac', supportLocal: false }]);
  });

  test('restores the sharing schema when Developer Cloud cannot fully resolve a QR IR AC', async () => {
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
      if (path === '/v1.1/m/life/ir-ac/specifications') {
        return success({
          functions: [
            { code: 'M', type: 'Enum', values: '{"min":0,"max":4,"scale":0,"step":1,"type":"Integer"}' },
            { code: 'PowerOff', type: 'String', values: 'PowerOff' },
            { code: 'PowerOn', type: 'String', values: 'PowerOn' },
            { code: 'T', type: 'Enum', values: '{"min":16,"max":30,"scale":0,"step":1,"type":"Integer"}' },
          ],
          status: [],
        });
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
    const productFallback = {
      getInfraredRemotes: jest.fn().mockResolvedValue(success([{
        category_id: 5,
        remote_id: 'ir-ac',
      }])),
      getInfraredKeys: jest.fn().mockResolvedValue({
        success: false,
        code: 2008,
        msg: 'app param is invalid',
      }),
    } as unknown as TuyaDeviceManager;
    deviceManager.setProductApiFallback(productFallback);
    const devices = await deviceManager.updateDevices(['home-1']);

    await deviceManager.updateInfraredRemotes(devices);

    const airConditioner = devices.find(device => device.id === 'ir-ac')!;
    expect(airConditioner.schema.map(item => item.code)).toEqual(expect.arrayContaining([
      'M', 'PowerOff', 'PowerOn', 'T',
    ]));
    expect(airConditioner.remote_keys?.key_range).not.toHaveLength(0);
    expect(airConditioner.status.map(item => item.code)).toEqual(['mode', 'power', 'temp', 'wind']);
    expect(airConditioner.infrared_ac_command_mode).toBe('device-sharing');
  });

  test('prefers a successfully resolved Developer Cloud IR AC over sharing commands', async () => {
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
      if (path === '/v1.1/m/life/ir-ac/specifications') {
        return success({
          functions: [
            { code: 'M', type: 'Enum', values: '{"min":0,"max":4,"scale":0,"step":1,"type":"Integer"}' },
            { code: 'PowerOff', type: 'String', values: 'PowerOff' },
            { code: 'PowerOn', type: 'String', values: 'PowerOn' },
            { code: 'T', type: 'Enum', values: '{"min":16,"max":30,"scale":0,"step":1,"type":"Integer"}' },
          ],
          status: [],
        });
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
    const postWithQuery = jest.fn();
    const api = {
      tokenInfo: { access_token: '', refresh_token: '', uid: 'user-1', expire: Number.MAX_SAFE_INTEGER },
      get,
      post: jest.fn(),
      postWithQuery,
    } as unknown as TuyaSharingAPI;
    const deviceManager = new TuyaSharingDeviceManager(api);
    const sendInfraredACCommands = jest.fn().mockResolvedValue(success(true));
    const productFallback = {
      getInfraredRemotes: jest.fn().mockResolvedValue(success([{
        category_id: 5,
        remote_id: 'ir-ac',
      }])),
      getInfraredKeys: jest.fn().mockResolvedValue(success({
        category_id: 5,
        org_category_id: 5,
        brand_id: 1,
        remote_index: 1,
        single_air: true,
        duplicate_power: false,
        key_list: [],
        key_range: [{
          mode: 0,
          mode_name: 'Cool',
          temp_list: [{ temp: 25, temp_name: '25', fan_list: [{ fan: 0, fan_name: 'Auto' }] }],
        }],
      })),
      getInfraredACStatus: jest.fn().mockResolvedValue(success({
        power: 1,
        mode: 0,
        temp: 25,
        wind: 0,
      })),
      sendInfraredACCommands,
    } as unknown as TuyaDeviceManager;
    deviceManager.setProductApiFallback(productFallback);
    const devices = await deviceManager.updateDevices(['home-1']);

    await deviceManager.updateInfraredRemotes(devices);

    const airConditioner = devices.find(device => device.id === 'ir-ac')!;
    expect(productFallback.getInfraredACStatus).toHaveBeenCalledWith('ir-hub', 'ir-ac');
    expect(airConditioner.infrared_ac_product_api_resolved).toBe(true);
    expect(airConditioner.infrared_ac_command_mode).toBeUndefined();

    await deviceManager.sendInfraredACCommands('ir-hub', 'ir-ac', 1, 0, 25, 0);
    expect(sendInfraredACCommands).toHaveBeenCalledWith('ir-hub', 'ir-ac', 1, 0, 25, 0);
    expect(postWithQuery).not.toHaveBeenCalled();
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
