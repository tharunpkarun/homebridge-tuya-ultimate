import { describe, expect, jest, test } from '@jest/globals';
import IRAirConditionerAccessory from '../../src/accessory/IRAirConditionerAccessory';

const CurrentHeaterCoolerState = {
  INACTIVE: 0,
  IDLE: 1,
  HEATING: 2,
  COOLING: 3,
};

const createHandler = (parent: any, remoteStatus: any[] = []) => {
  const handler = Object.create(IRAirConditionerAccessory.prototype) as any;
  handler.device = {
    id: 'virtual-ac',
    parent_id: 'physical-hub',
    status: remoteStatus,
  };
  handler.deviceManager = {
    getDevice: jest.fn((id: string) => id === 'physical-hub' ? parent : undefined),
  };
  handler.platform = {
    getDeviceSchemaConfig: jest.fn(() => undefined),
  };
  handler.Characteristic = {
    CurrentHeaterCoolerState,
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

describe('IRAirConditionerAccessory HomeKit presentation', () => {
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
