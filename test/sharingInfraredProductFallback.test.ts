import TuyaSharingAPI from '../src/core/TuyaSharingAPI';
import TuyaDevice, {
  TuyaDeviceSchemaMode,
  TuyaDeviceSchemaProperty,
  TuyaDeviceSchemaType,
  TuyaIRRemoteKeys,
} from '../src/device/TuyaDevice';
import TuyaDeviceManager from '../src/device/TuyaDeviceManager';
import TuyaSharingDeviceManager from '../src/device/TuyaSharingDeviceManager';

function success(result: unknown) {
  return { success: true as const, result, t: 1, tid: 'test' };
}

function remoteKeys(temp = 25, fan = 0): TuyaIRRemoteKeys {
  return {
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
      temp_list: [{
        temp,
        temp_name: String(temp),
        fan_list: [{ fan, fan_name: String(fan) }],
      }],
    }],
  };
}

function sharingDevices(nativeKeys: TuyaIRRemoteKeys) {
  const hub = new TuyaDevice({
    id: 'ir-hub',
    name: 'IR hub',
    category: 'hwktwkq',
    schema: [],
    status: [],
    sub: false,
    lat: 'hub-lat',
    lon: 'hub-lon',
    update_time: 1,
  });
  const remote = new TuyaDevice({
    id: 'ir-ac',
    name: 'Bedroom AC',
    category: 'infrared_ac',
    schema: [
      {
        code: 'M',
        mode: TuyaDeviceSchemaMode.WRITE_ONLY,
        type: TuyaDeviceSchemaType.Enum,
        property: {
          min: 0, max: 4, scale: 0, step: 1, unit: '', type: 'Integer',
        } as TuyaDeviceSchemaProperty,
      },
      {
        code: 'PowerOff',
        mode: TuyaDeviceSchemaMode.WRITE_ONLY,
        type: TuyaDeviceSchemaType.String,
        property: 'PowerOff',
      },
      {
        code: 'PowerOn',
        mode: TuyaDeviceSchemaMode.WRITE_ONLY,
        type: TuyaDeviceSchemaType.String,
        property: 'PowerOn',
      },
      {
        code: 'T',
        mode: TuyaDeviceSchemaMode.WRITE_ONLY,
        type: TuyaDeviceSchemaType.Enum,
        property: {
          min: 16, max: 30, scale: 0, step: 1, unit: '', type: 'Integer',
        } as TuyaDeviceSchemaProperty,
      },
    ],
    status: [
      { code: 'mode', value: 0 },
      { code: 'power', value: false },
      { code: 'temp', value: 25 },
      { code: 'wind', value: 0 },
    ],
    sub: true,
    lat: 'remote-lat',
    lon: 'remote-lon',
    update_time: 2,
    remote_keys: nativeKeys,
    infrared_ac_command_mode: 'device-sharing',
  });
  return { hub, remote, devices: [hub, remote] };
}

function managerWithFallback(productKeys: TuyaIRRemoteKeys, productStatus: ReturnType<typeof success> | {
  success: false;
  code: number;
  msg: string;
  result: undefined;
}) {
  const api = {
    tokenInfo: { access_token: '', refresh_token: '', uid: 'user-1', expire: Number.MAX_SAFE_INTEGER },
    get: jest.fn(),
    post: jest.fn(),
    postWithQuery: jest.fn(),
  } as unknown as TuyaSharingAPI;
  const manager = new TuyaSharingDeviceManager(api);
  manager.setProductApiFallback({
    getInfraredRemotes: jest.fn().mockResolvedValue(success([{
      category_id: 5,
      remote_id: 'ir-ac',
    }])),
    getInfraredKeys: jest.fn().mockResolvedValue(success(productKeys)),
    getInfraredACStatus: jest.fn().mockResolvedValue(productStatus),
  } as unknown as TuyaDeviceManager);
  return manager;
}

describe('QR IR AC Developer Cloud fallback safety', () => {
  test('routes resolved AC commands only through the Developer Cloud product API', async () => {
    const sharingApi = {
      tokenInfo: { access_token: '', refresh_token: '', uid: 'user-1', expire: Number.MAX_SAFE_INTEGER },
      get: jest.fn(),
      post: jest.fn(),
      postWithQuery: jest.fn(),
    } as unknown as TuyaSharingAPI;
    const manager = new TuyaSharingDeviceManager(sharingApi);
    const fallback = {
      getInfraredRemotes: jest.fn().mockResolvedValue(success([{
        category_id: 5,
        remote_id: 'ir-ac',
      }])),
      getInfraredKeys: jest.fn().mockResolvedValue(success(remoteKeys(18, 3))),
      getInfraredACStatus: jest.fn().mockResolvedValue(success({
        power: 1,
        mode: 0,
        temp: 18,
        wind: 3,
      })),
      sendInfraredACCommands: jest.fn().mockResolvedValue(success(true)),
    } as unknown as TuyaDeviceManager;
    manager.setProductApiFallback(fallback);
    const { remote, devices } = sharingDevices(remoteKeys());
    manager.devices = devices;

    await manager.updateInfraredRemotes(devices);
    const response = await manager.sendInfraredACCommands('ir-hub', 'ir-ac', 1, 0, 18, 3);

    expect(response.success).toBe(true);
    expect(remote.infrared_ac_product_api_resolved).toBe(true);
    expect(remote.infrared_ac_command_mode).toBeUndefined();
    expect(fallback.sendInfraredACCommands).toHaveBeenCalledWith('ir-hub', 'ir-ac', 1, 0, 18, 3);
    expect(sharingApi.postWithQuery).not.toHaveBeenCalled();
  });

  test('restores the sharing key table when product status resolution fails', async () => {
    const nativeKeys = remoteKeys(25, 0);
    const { remote, devices } = sharingDevices(nativeKeys);
    const manager = managerWithFallback(remoteKeys(18, 3), {
      success: false,
      code: 2008,
      msg: 'app param is invalid',
      result: undefined,
    });
    manager.devices = devices;

    await manager.updateInfraredRemotes(devices);

    expect(remote.remote_keys).toBe(nativeKeys);
    expect(remote.remote_keys?.key_range[0].temp_list[0].temp).toBe(25);
    expect(remote.infrared_ac_command_mode).toBe('device-sharing');
  });

  test.each([
    ['an empty temperature list', [{ mode: 0, mode_name: 'Cool', temp_list: [] }]],
    ['an empty fan list', [{
      mode: 0,
      mode_name: 'Cool',
      temp_list: [{ temp: 25, temp_name: '25', fan_list: [] }],
    }]],
  ])('rejects product keys with %s', async (_description, keyRange) => {
    const nativeKeys = remoteKeys();
    const malformedKeys = { ...remoteKeys(), key_range: keyRange } as TuyaIRRemoteKeys;
    const { remote, devices } = sharingDevices(nativeKeys);
    const manager = managerWithFallback(malformedKeys, success({
      power: 1,
      mode: 0,
      temp: 25,
      wind: 0,
    }));
    manager.devices = devices;

    await manager.updateInfraredRemotes(devices);

    expect(remote.remote_keys).toBe(nativeKeys);
    expect(remote.infrared_ac_product_api_resolved).toBeUndefined();
    expect(remote.infrared_ac_command_mode).toBe('device-sharing');
  });
});
