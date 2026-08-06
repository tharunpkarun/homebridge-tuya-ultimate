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

const createHandler = (parent: any, remoteStatus: any[] = [], deviceConfig?: any) => {
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
    sendInfraredACCommands: jest.fn(),
  };
  handler.platform = {
    getDeviceConfig: jest.fn(() => deviceConfig),
    getDeviceSchemaConfig: jest.fn(() => undefined),
  };
  handler.Characteristic = {
    Active: { ACTIVE: 1, INACTIVE: 0 },
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
  test('removes cached StatusActive characteristics from virtual IR services', () => {
    const handler = createHandler({ online: false }) as any;
    const statusActive = { UUID: 'status-active' };
    const heaterCooler = {
      testCharacteristic: jest.fn(() => true),
      getCharacteristic: jest.fn(() => statusActive),
      removeCharacteristic: jest.fn(),
    };
    const humidity = {
      testCharacteristic: jest.fn(() => true),
      getCharacteristic: jest.fn(() => statusActive),
      removeCharacteristic: jest.fn(),
    };
    handler.Characteristic.StatusActive = 'StatusActive';
    handler.accessory = { services: [heaterCooler, humidity] };

    handler.configureStatusActive();

    expect(heaterCooler.removeCharacteristic).toHaveBeenCalledWith(statusActive);
    expect(humidity.removeCharacteristic).toHaveBeenCalledWith(statusActive);
  });
});

describe('IRAirConditionerAccessory HomeKit presentation', () => {
  test.each([
    [undefined, 'cool'],
    ['cool', 'cool'],
    ['heat', 'heat'],
    ['auto', 'auto'],
    ['last', 'last'],
    ['invalid', 'cool'],
  ])('uses %s as a %s power-on profile', (configuredMode, expectedProfile) => {
    const handler = createHandler(undefined, [], {
      irAirConditionerPowerOnMode: configuredMode,
    });

    expect(handler.getPowerOnModeProfile()).toBe(expectedProfile);
  });

  test.each([
    ['cool', 0],
    ['heat', 1],
    ['auto', 2],
    ['last', 1],
  ])('resolves the %s power-on profile', (profile, expectedMode) => {
    const remoteStatus = [
      { code: 'power', value: 0 },
      { code: 'mode', value: 4 },
      { code: 'temp', value: 24 },
    ];
    const handler = createHandler(undefined, remoteStatus, {
      irAirConditionerPowerOnMode: profile,
    }) as any;
    handler.device.remote_keys = {
      key_range: [{ mode: 0 }, { mode: 1 }, { mode: 2 }],
    };
    handler.lastClimateMode = 1;
    handler.getCachedTargetMode = jest.fn(() => undefined);

    expect(handler.getPowerOnMode()).toBe(expectedMode);
  });

  test.each([
    ['heat', [{ mode: 0 }, { mode: 2 }], 0],
    ['cool', [{ mode: 1 }, { mode: 2 }], 1],
    ['heat', [{ mode: 2 }], 2],
  ])('falls back from unsupported %s through Cool, Heat, then Auto', (profile, keyRange, expectedMode) => {
    const handler = createHandler(undefined, [], {
      irAirConditionerPowerOnMode: profile,
    }) as any;
    handler.device.remote_keys = { key_range: keyRange };

    expect(handler.getPowerOnMode()).toBe(expectedMode);
  });

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

  test('does not mistake HomeKit default Auto for a prior climate target', () => {
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
        getCharacteristic: jest.fn(() => ({ value: TargetHeaterCoolerState.AUTO })),
      })),
    };

    expect(handler.getActivationMode()).toBe(0);
  });

  test('uses Cool instead of a remembered Auto mode for a plain power-on', () => {
    const remoteStatus = [
      { code: 'power', value: 0 },
      { code: 'mode', value: 4 },
      { code: 'temp', value: 24 },
    ];
    const handler = createHandler(undefined, remoteStatus) as any;
    handler.device.remote_keys = {
      key_range: [{ mode: 0 }, { mode: 1 }, { mode: 2 }],
    };
    handler.lastClimateMode = 2;
    handler.accessory = {
      getService: jest.fn(() => ({
        getCharacteristic: jest.fn(() => ({ value: TargetHeaterCoolerState.AUTO })),
      })),
    };

    expect(handler.getActivationMode()).toBe(2);
    expect(handler.getPowerOnMode()).toBe(0);
  });

  test.each([
    ['cool', 'Auto then Active', 0, true],
    ['cool', 'Active then Auto', 0, false],
    ['heat', 'Auto then Active', 1, true],
    ['heat', 'Active then Auto', 1, false],
    ['auto', 'Auto then Active', 2, true],
    ['auto', 'Active then Auto', 2, false],
    ['last', 'Auto then Active', 1, true],
    ['last', 'Active then Auto', 1, false],
  ])('keeps the %s profile when Apple writes %s', (profile, _name, expectedMode, autoFirst) => {
    const remoteStatus = [
      { code: 'power', value: 0 },
      { code: 'mode', value: 4 },
      { code: 'temp', value: 25 },
    ];
    const handler = createHandler(undefined, remoteStatus, {
      irAirConditionerPowerOnMode: profile,
    }) as any;
    handler.device.remote_keys = {
      key_range: [{ mode: 0 }, { mode: 1 }, { mode: 2 }],
    };
    handler.lastClimateMode = 1;
    handler.getCachedTargetMode = jest.fn(() => undefined);
    handler.updateCurrentState = jest.fn();
    handler.debounceSendACCommands = jest.fn();

    const writeAuto = () => handler.setTargetMode(TargetHeaterCoolerState.AUTO);
    const writeActive = () => handler.setActive(handler.Characteristic.Active.ACTIVE);

    if (autoFirst) {
      writeAuto();
      writeActive();
    } else {
      writeActive();
      writeAuto();
    }

    expect(handler.getMode()).toBe(expectedMode);
  });

  test('preserves direct target-mode selection while already active', () => {
    const remoteStatus = [
      { code: 'power', value: 1 },
      { code: 'mode', value: 0 },
      { code: 'temp', value: 25 },
    ];
    const handler = createHandler(undefined, remoteStatus) as any;
    handler.device.remote_keys = {
      key_range: [{ mode: 0 }, { mode: 1 }, { mode: 2 }],
    };
    handler.updateCurrentState = jest.fn();
    handler.debounceSendACCommands = jest.fn();

    handler.setTargetMode(TargetHeaterCoolerState.HEAT);
    expect(handler.getMode()).toBe(1);

    handler.setTargetMode(TargetHeaterCoolerState.AUTO);
    expect(handler.getMode()).toBe(2);
  });

  test('suppresses a delayed Apple Auto replay after the IR debounce, then permits an explicit later change', async () => {
    let now = 10_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const remoteStatus = [
      { code: 'power', value: 0 },
      { code: 'mode', value: 2 },
      { code: 'temp', value: 25 },
      { code: 'wind', value: 0 },
    ];
    const handler = createHandler(undefined, remoteStatus, {
      irAirConditionerPowerOnMode: 'cool',
    }) as any;
    handler.device.remote_keys = {
      key_range: [{ mode: 0 }, { mode: 1 }, { mode: 2 }],
    };
    handler.updateCurrentState = jest.fn();
    handler.debounceSendACCommands = jest.fn();

    try {
      handler.setActive(handler.Characteristic.Active.ACTIVE);
      await handler.sendACCommands();
      expect(handler.getMode()).toBe(0);

      now += 500;
      handler.setTargetMode(TargetHeaterCoolerState.AUTO);
      expect(handler.getMode()).toBe(0);
      expect(handler.deviceManager.sendInfraredACCommands).toHaveBeenCalledTimes(1);

      now += 2000;
      handler.setTargetMode(TargetHeaterCoolerState.AUTO);
      expect(handler.getMode()).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
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
