import { describe, expect, jest, test } from '@jest/globals';
import IRAirConditionerAccessory from '../../src/accessory/IRAirConditionerAccessory';

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
