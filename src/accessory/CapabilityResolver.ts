import TuyaDevice, {
  TuyaDeviceSchema,
  TuyaDeviceSchemaEnumProperty,
  TuyaDeviceSchemaType,
} from '../device/TuyaDevice';

export type CapabilityMatch = {
  category: string;
  profile: string;
  matchedCodes: string[];
};

type DeviceCapabilities = {
  codes: Set<string>;
  schema: Map<string, TuyaDeviceSchema>;
};

const hasAny = (capabilities: DeviceCapabilities, ...codes: string[]) =>
  codes.some(code => capabilities.codes.has(code));

const hasAll = (capabilities: DeviceCapabilities, ...codes: string[]) =>
  codes.every(code => capabilities.codes.has(code));

const hasSchemaType = (capabilities: DeviceCapabilities, code: string, type: TuyaDeviceSchemaType) =>
  capabilities.schema.get(code)?.type === type;

function match(category: string, profile: string, matchedCodes: string[]): CapabilityMatch {
  return { category, profile, matchedCodes };
}

function enumIncludes(capabilities: DeviceCapabilities, code: string, values: string[]) {
  const schema = capabilities.schema.get(code);
  if (!schema || schema.type !== TuyaDeviceSchemaType.Enum) {
    return false;
  }
  const property = schema.property as TuyaDeviceSchemaEnumProperty;
  return Array.isArray(property?.range) && property.range.some(value => values.includes(value));
}

/**
 * Conservatively maps standard Tuya datapoints to an existing accessory
 * profile. It is used only when a product/category mapping does not exist and
 * the user explicitly enables capability-based discovery.
 */
export function inferAccessoryCapabilities(device: TuyaDevice): CapabilityMatch | undefined {
  const schema = new Map(device.schema.map(item => [item.code.toLowerCase(), item]));
  const capabilities = {
    codes: new Set([
      ...device.schema.map(item => item.code.toLowerCase()),
      ...device.status.map(item => item.code.toLowerCase()),
    ]),
    schema,
  };

  if (
    hasAll(capabilities, 'switch', 'mode', 'temp_current')
    && hasSchemaType(capabilities, 'switch', TuyaDeviceSchemaType.Boolean)
    && hasSchemaType(capabilities, 'temp_current', TuyaDeviceSchemaType.Integer)
    && enumIncludes(capabilities, 'mode', ['auto', 'cold', 'cool', 'hot', 'heat'])
  ) {
    return match('kt', 'air-conditioner', ['switch', 'mode', 'temp_current']);
  }

  if (hasSchemaType(capabilities, 'temp_set', TuyaDeviceSchemaType.Integer)
    && hasSchemaType(capabilities, 'temp_current', TuyaDeviceSchemaType.Integer)) {
    return match('wk', 'thermostat', ['temp_current', 'temp_set']);
  }

  if (hasSchemaType(capabilities, 'switch_fan', TuyaDeviceSchemaType.Boolean)
    || hasSchemaType(capabilities, 'fan_switch', TuyaDeviceSchemaType.Boolean)) {
    return match('fs', 'fan', [hasAny(capabilities, 'switch_fan') ? 'switch_fan' : 'fan_switch']);
  }

  if (hasSchemaType(capabilities, 'switch_led', TuyaDeviceSchemaType.Boolean)) {
    return match('dj', 'light', ['switch_led']);
  }

  if (hasAny(capabilities, 'smoke_sensor_status', 'smoke_sensor_state')) {
    return match('ywbj', 'smoke-sensor', [
      hasAny(capabilities, 'smoke_sensor_status') ? 'smoke_sensor_status' : 'smoke_sensor_state',
    ]);
  }

  if (hasAny(capabilities, 'co_status', 'co_state')) {
    return match('cobj', 'carbon-monoxide-sensor', [hasAny(capabilities, 'co_status') ? 'co_status' : 'co_state']);
  }

  if (hasAny(capabilities, 'co2_state')) {
    return match('co2bj', 'carbon-dioxide-sensor', ['co2_state']);
  }

  if (hasAny(capabilities, 'watersensor_state', 'gas_sensor_status', 'gas_sensor_state', 'ch4_sensor_state')) {
    const code = ['watersensor_state', 'gas_sensor_status', 'gas_sensor_state', 'ch4_sensor_state']
      .find(candidate => capabilities.codes.has(candidate))!;
    return match('sj', 'leak-or-gas-sensor', [code]);
  }

  if (hasAny(capabilities, 'doorcontact_state')) {
    return match('mcs', 'contact-sensor', ['doorcontact_state']);
  }

  if (hasAny(capabilities, 'sos', 'sos_state')) {
    return match('sos', 'emergency-button', [hasAny(capabilities, 'sos') ? 'sos' : 'sos_state']);
  }

  if (hasAny(capabilities, 'pir')) {
    return match('pir', 'motion-sensor', ['pir']);
  }

  const temperatureCode = ['va_temperature', 'temp_value']
    .find(code => hasSchemaType(capabilities, code, TuyaDeviceSchemaType.Integer));
  const humidityCode = ['va_humidity', 'humidity_value']
    .find(code => hasSchemaType(capabilities, code, TuyaDeviceSchemaType.Integer));
  if (temperatureCode || humidityCode) {
    return match('wsdcg', 'environment-sensor', [temperatureCode, humidityCode].filter(Boolean) as string[]);
  }

  const meterCode = [
    'cur_current',
    'cur_power',
    'cur_voltage',
    'forward_energy_total',
    'add_ele',
    'phase_a_current',
    'phase_a_power',
    'phase_a_voltage',
  ].find(code => hasSchemaType(capabilities, code, TuyaDeviceSchemaType.Integer));
  if (meterCode && !hasAny(capabilities, 'switch', 'switch_1')) {
    return match('zndb', 'electricity-meter', [meterCode]);
  }

  const switchSchema = device.schema.find(item =>
    item.type === TuyaDeviceSchemaType.Boolean
    && (item.code === 'switch' || /^switch_[1-9]\d*$/.test(item.code)),
  );
  if (switchSchema) {
    if (hasAny(capabilities, 'cur_current', 'cur_power', 'cur_voltage', 'add_ele')) {
      return match('cz', 'metered-outlet', [switchSchema.code]);
    }
    return match('kg', 'switch', [switchSchema.code]);
  }

  return undefined;
}
