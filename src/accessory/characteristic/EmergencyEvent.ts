import { CharacteristicProps, PartialAllowingNull, Service } from 'homebridge';

import {
  TuyaDeviceSchema,
  TuyaDeviceSchemaEnumProperty,
  TuyaDeviceSchemaType,
  TuyaDeviceStatus,
} from '../../device/TuyaDevice';
import BaseAccessory from '../BaseAccessory';
import { configureProgrammableSwitchEvent } from './ProgrammableSwitchEvent';

const SINGLE_PRESS = 0;
const ACTIVE_ENUM_VALUES = new Set(['1', 'alarm', 'sos']);

export function configureEmergencyEvent(
  accessory: BaseAccessory,
  service: Service,
  schema?: TuyaDeviceSchema,
) {
  if (!schema) {
    return;
  }

  configureProgrammableSwitchEvent(accessory, service, schema);
  const props: PartialAllowingNull<CharacteristicProps> = {
    minValue: SINGLE_PRESS,
    maxValue: SINGLE_PRESS,
    validValues: [SINGLE_PRESS],
  };
  service.getCharacteristic(accessory.Characteristic.ProgrammableSwitchEvent)
    .setProps(props);
}

export function onEmergencyEvent(
  accessory: BaseAccessory,
  service: Service,
  schema: TuyaDeviceSchema,
  status: TuyaDeviceStatus,
) {
  if (!accessory.intialized || !isEmergencyEvent(schema, status)) {
    return;
  }

  accessory.log.info('Emergency button event detected.');
  service.getCharacteristic(accessory.Characteristic.ProgrammableSwitchEvent)
    .updateValue(SINGLE_PRESS);
}

/**
 * Accept only explicit active values. In particular, a normal/reset report is
 * never converted into another HomeKit press event.
 */
export function isEmergencyEvent(schema: TuyaDeviceSchema, status: TuyaDeviceStatus): boolean {
  if (status.code.toLowerCase() !== schema.code.toLowerCase()) {
    return false;
  }

  switch (schema.type) {
    case TuyaDeviceSchemaType.Boolean:
      return status.value === true;
    case TuyaDeviceSchemaType.Integer:
      return typeof status.value === 'number' && Number.isFinite(status.value) && status.value > 0;
    case TuyaDeviceSchemaType.Enum: {
      if (typeof status.value !== 'string') {
        return false;
      }
      const value = status.value.toLowerCase();
      const range = (schema.property as TuyaDeviceSchemaEnumProperty).range;
      return ACTIVE_ENUM_VALUES.has(value)
        && Array.isArray(range)
        && range.some(item => item.toLowerCase() === value);
    }
    default:
      return false;
  }
}
