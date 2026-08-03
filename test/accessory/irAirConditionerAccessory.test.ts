import { describe, expect, jest, test } from '@jest/globals';
import IRAirConditionerAccessory from '../../src/accessory/IRAirConditionerAccessory';

const CurrentHeaterCoolerState = {
  INACTIVE: 0,
  IDLE: 1,
  HEATING: 2,
  COOLING: 3,
};

const TargetHeaterCoolerState = {
  AUTO: 0,
  HEAT: 1,
  COOL: 2,
};

const createHandler = (parent: any, remoteStatus: any[] = []) => {
  const handler = Object.create(IRAirConditionerAccessory.prototype) as any;
  handler.device = {
    id: 'virtual-ac',
    parent_id: 'physical-hub',
    category: 'infrared_ac',
    online: false,
    status: remoteStatus,
    isIRRemoteControl: () => true,
  };
  handler.deviceManager = {
    getDevice: jest.fn((id: string) => id === 'physical-hub' ? parent : undefined),
  };
  handler.platform = {
    getDeviceSchemaConfig: jest.fn(() => undefined),
  };
  handler.Characteristic = {
    CurrentHeaterCoolerState,
    TargetHeaterCoolerState,
    RotationSpeed: 'RotationSpeed',
  };
  handler.Service = {
    HeaterCooler: 'HeaterCooler',
    HumidifierDehumidifier: 'HumidifierDehumidifier',
    Fanv2: 'Fanv2',
  };
  return handler as IRAirConditionerAccessory;
};

describe('IRAirConditionerAccessory ambient sensors', () => {
  test('reads scaled temperature and humidity from the physical IR hub', () => {
    const handler = createHandler({
      status: [
        { code: 'temp_current', value: 264 },
        { code: 'humidity_current', value: 39 },
      ],
      schema: [
        { code: 'temp_current', property: { scale: 1 } },
        { code: 'humidity_current', property: { scale: 0 } },
      ],
    });

    expect(handler.getAmbientTemperature()).toBe(26.4);
    expect(handler.getAmbientHumidity()).toBe(39);
  });

  test('falls back safely when the parent sensor values are unavailable', () => {
    const handler = createHandler(undefined, [{ code: 'temp', value: '25' }]);

    expect(handler.getAmbientTemperature()).toBe(25);
    expect(handler.getAmbientHumidity()).toBe(0);
  });
});

describe('IRAirConditionerAccessory availability', () => {
  test('uses the physical IR hub availability instead of the virtual child flag', () => {
    const parent = { online: true };
    const handler = createHandler(parent);

    expect(handler.getOnlineStatus()).toBe(true);

    parent.online = false;
    expect(handler.getOnlineStatus()).toBe(false);
  });

  test('falls back to the child availability when its parent cannot be resolved', () => {
    const handler = createHandler(undefined) as any;
    handler.device.online = true;

    expect(handler.getOnlineStatus()).toBe(true);
  });
});

describe('IRAirConditionerAccessory HomeKit presentation', () => {
  test('uses HomeKit Cool when powering on with an invalid Tuya mode cache', () => {
    const remoteStatus = [
      { code: 'power', value: 0 },
      { code: 'mode', value: 4 },
      { code: 'temp', value: 24 },
    ];
    const handler = createHandler(undefined, remoteStatus) as any;
    handler.device.remote_keys = {
      key_range: [{ mode: 0 }, { mode: 1 }, { mode: 2 }],
    };
    handler.accessory = {
      getService: jest.fn(() => ({
        getCharacteristic: jest.fn(() => ({ value: TargetHeaterCoolerState.COOL })),
      })),
    };

    expect(handler.getActivationMode()).toBe(0);
  });

  test('remembers the last supported climate mode instead of defaulting to Auto', () => {
    const remoteStatus = [
      { code: 'power', value: 0 },
      { code: 'mode', value: 0 },
      { code: 'temp', value: 24 },
    ];
    const handler = createHandler(undefined, remoteStatus) as any;
    handler.device.remote_keys = {
      key_range: [{ mode: 0 }, { mode: 1 }, { mode: 2 }],
    };
    handler.lastClimateMode = 0;
    handler.accessory = {
      getService: jest.fn(() => ({
        getCharacteristic: jest.fn(() => ({ value: undefined })),
      })),
    };
    remoteStatus.find(status => status.code === 'mode')!.value = 4;

    expect(handler.getActivationMode()).toBe(0);
  });

  test('prefers Cool over Auto when no prior climate target is available', () => {
    const remoteStatus = [
      { code: 'power', value: 0 },
      { code: 'mode', value: 4 },
      { code: 'temp', value: 24 },
    ];
    const handler = createHandler(undefined, remoteStatus) as any;
    handler.device.remote_keys = {
      key_range: [{ mode: 2 }, { mode: 0 }],
    };
    handler.accessory = {
      getService: jest.fn(() => ({
        getCharacteristic: jest.fn(() => ({ value: undefined })),
      })),
    };

    expect(handler.getActivationMode()).toBe(0);
  });

  test('reports cooling, heating, idle, and inactive from power, mode, and temperatures', () => {
    const parent = {
      status: [{ code: 'temp_current', value: 266 }],
      schema: [{ code: 'temp_current', property: { scale: 1 } }],
    };
    const remoteStatus = [
      { code: 'power', value: 1 },
      { code: 'mode', value: 0 },
      { code: 'temp', value: 25 },
    ];
    const handler = createHandler(parent, remoteStatus);

    expect(handler.getCurrentState()).toBe(CurrentHeaterCoolerState.COOLING);

    remoteStatus.find(status => status.code === 'mode')!.value = 1;
    parent.status[0].value = 200;
    expect(handler.getCurrentState()).toBe(CurrentHeaterCoolerState.HEATING);

    remoteStatus.find(status => status.code === 'mode')!.value = 2;
    parent.status[0].value = 250;
    expect(handler.getCurrentState()).toBe(CurrentHeaterCoolerState.IDLE);

    remoteStatus.find(status => status.code === 'power')!.value = 0;
    expect(handler.getCurrentState()).toBe(CurrentHeaterCoolerState.INACTIVE);
  });

  test('removes cached dehumidifier and fan services', () => {
    const handler = createHandler(undefined) as any;
    const dehumidifier = { UUID: 'dehumidifier' };
    const fan = { UUID: 'fan' };
    handler.accessory = {
      getService: jest.fn((serviceType: string) => ({
        HumidifierDehumidifier: dehumidifier,
        Fanv2: fan,
      }[serviceType])),
      removeService: jest.fn(),
    };

    handler.removeUnusedModeServices();

    expect(handler.accessory.removeService).toHaveBeenCalledTimes(2);
    expect(handler.accessory.removeService).toHaveBeenCalledWith(dehumidifier);
    expect(handler.accessory.removeService).toHaveBeenCalledWith(fan);
  });

  test('removes the unsupported rotation-speed characteristic', () => {
    const handler = createHandler(undefined) as any;
    const rotationSpeed = { UUID: 'rotation-speed' };
    const service = {
      testCharacteristic: jest.fn(() => true),
      getCharacteristic: jest.fn(() => rotationSpeed),
      removeCharacteristic: jest.fn(),
    };

    handler.removeRotationSpeed(service);

    expect(service.removeCharacteristic).toHaveBeenCalledWith(rotationSpeed);
  });
});
