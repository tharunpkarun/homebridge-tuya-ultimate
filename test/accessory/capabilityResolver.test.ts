import { inferAccessoryCapabilities } from '../../src/accessory/CapabilityResolver';
import TuyaDevice, { TuyaDeviceSchemaMode, TuyaDeviceSchemaType } from '../../src/device/TuyaDevice';

const createDevice = (schema: Array<{ code: string; type?: TuyaDeviceSchemaType; property?: object }> = []) => ({
  schema: schema.map(item => ({
    code: item.code,
    mode: TuyaDeviceSchemaMode.READ_WRITE,
    type: item.type ?? TuyaDeviceSchemaType.Boolean,
    property: item.property ?? {},
  })),
  status: schema.map(item => ({ code: item.code, value: false })),
} as TuyaDevice);

describe('capability-based accessory inference', () => {
  test('recognizes an unknown air conditioner from its standard datapoints', () => {
    const device = createDevice([
      { code: 'switch' },
      { code: 'mode', type: TuyaDeviceSchemaType.Enum, property: { range: ['auto', 'cold', 'hot'] } },
      { code: 'temp_current', type: TuyaDeviceSchemaType.Integer },
      { code: 'temp_set', type: TuyaDeviceSchemaType.Integer },
    ]);

    expect(inferAccessoryCapabilities(device)).toEqual({
      category: 'kt',
      profile: 'air-conditioner',
      matchedCodes: ['switch', 'mode', 'temp_current'],
    });
  });

  test('recognizes safety and environmental sensors without guessing from a generic switch', () => {
    expect(inferAccessoryCapabilities(createDevice([{ code: 'smoke_sensor_status' }]))?.category).toBe('ywbj');
    expect(inferAccessoryCapabilities(createDevice([{ code: 'doorcontact_state' }]))?.category).toBe('mcs');
    expect(inferAccessoryCapabilities(createDevice([
      { code: 'va_temperature', type: TuyaDeviceSchemaType.Integer },
      { code: 'va_humidity', type: TuyaDeviceSchemaType.Integer },
    ]))?.category).toBe('wsdcg');
  });

  test('distinguishes a metered outlet from a generic switch', () => {
    expect(inferAccessoryCapabilities(createDevice([
      { code: 'switch' },
      { code: 'cur_power', type: TuyaDeviceSchemaType.Integer },
    ]))?.category).toBe('cz');
    expect(inferAccessoryCapabilities(createDevice([{ code: 'switch_1' }]))?.category).toBe('kg');
  });

  test('recognizes standalone meters and emergency buttons', () => {
    expect(inferAccessoryCapabilities(createDevice([
      { code: 'cur_power', type: TuyaDeviceSchemaType.Integer },
    ]))?.category).toBe('zndb');
    expect(inferAccessoryCapabilities(createDevice([{ code: 'sos_state' }]))?.category).toBe('sos');
  });

  test('does not guess when no conservative profile matches', () => {
    expect(inferAccessoryCapabilities(createDevice([
      { code: 'mystery_value', type: TuyaDeviceSchemaType.Integer },
    ]))).toBeUndefined();
  });

  test('does not infer numeric profiles from same-named datapoints with incompatible types', () => {
    expect(inferAccessoryCapabilities(createDevice([{ code: 'cur_power' }]))).toBeUndefined();
    expect(inferAccessoryCapabilities(createDevice([{ code: 'temp_set' }]))).toBeUndefined();
    expect(inferAccessoryCapabilities(createDevice([{ code: 'va_temperature' }]))).toBeUndefined();
  });

  test('does not infer a thermostat from an integer setpoint alone', () => {
    expect(inferAccessoryCapabilities(createDevice([
      { code: 'temp_set', type: TuyaDeviceSchemaType.Integer },
    ]))).toBeUndefined();
  });
});
