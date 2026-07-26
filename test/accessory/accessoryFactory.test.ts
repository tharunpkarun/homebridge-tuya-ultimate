import { PlatformAccessory } from 'homebridge';
import AccessoryFactory from '../../src/accessory/AccessoryFactory';
import IRAirConditionerAccessory from '../../src/accessory/IRAirConditionerAccessory';
import TuyaDevice from '../../src/device/TuyaDevice';
import { TuyaPlatform } from '../../src/platform';

jest.mock('../../src/accessory/IRAirConditionerAccessory', () => ({
  __esModule: true,
  default: class MockIRAirConditionerAccessory {
    intialized = false;

    checkRequirements() {
      return true;
    }

    configureServices() {
      // No-op: this test verifies category routing, not HomeKit service behavior.
    }

    configureStatusActive() {
      // No-op: this test verifies category routing, not HomeKit service behavior.
    }

    updateAllValues() {
      // No-op: this test verifies category routing, not HomeKit service behavior.
    }
  },
}));

describe('AccessoryFactory', () => {
  test('maps infrared_ac virtual remotes to the IR thermostat-style accessory', () => {
    const platform = {
      log: {
        warn: jest.fn(),
      },
    } as unknown as TuyaPlatform;
    const accessory = {} as PlatformAccessory;
    const device = {
      product_id: 'virtual-ir-ac',
      category: 'infrared_ac',
      isIRRemoteControl: () => true,
    } as TuyaDevice;

    const handler = AccessoryFactory.createAccessory(platform, accessory, device);

    expect(handler).toBeInstanceOf(IRAirConditionerAccessory);
    expect(handler.intialized).toBe(true);
  });
});
