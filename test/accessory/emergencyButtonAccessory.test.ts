import EmergencyButtonAccessory from '../../src/accessory/EmergencyButtonAccessory';
import {
  configureEmergencyEvent,
  isEmergencyEvent,
} from '../../src/accessory/characteristic/EmergencyEvent';
import {
  TuyaDeviceSchema,
  TuyaDeviceSchemaMode,
  TuyaDeviceSchemaType,
} from '../../src/device/TuyaDevice';

const booleanSchema = (code = 'sos'): TuyaDeviceSchema => ({
  code,
  mode: TuyaDeviceSchemaMode.READ_ONLY,
  type: TuyaDeviceSchemaType.Boolean,
  property: {},
});

const integerSchema = (code = 'sos'): TuyaDeviceSchema => ({
  code,
  mode: TuyaDeviceSchemaMode.READ_ONLY,
  type: TuyaDeviceSchemaType.Integer,
  property: { min: 0, max: 1, scale: 0, step: 1, unit: '' },
});

const enumSchema = (range: string[], code = 'sos_state'): TuyaDeviceSchema => ({
  code,
  mode: TuyaDeviceSchemaMode.READ_ONLY,
  type: TuyaDeviceSchemaType.Enum,
  property: { range },
});

const createCharacteristic = () => ({
  value: undefined as unknown,
  setProps: jest.fn().mockReturnThis(),
  updateValue: jest.fn().mockReturnThis(),
  onGet: jest.fn().mockReturnThis(),
});

const createService = () => {
  const characteristics = new Map<string, ReturnType<typeof createCharacteristic>>();
  return {
    characteristics,
    getCharacteristic: jest.fn((key: { UUID?: string } | string) => {
      const id = typeof key === 'string' ? key : key.UUID ?? String(key);
      if (!characteristics.has(id)) {
        characteristics.set(id, createCharacteristic());
      }
      return characteristics.get(id)!;
    }),
    setCharacteristic: jest.fn().mockReturnThis(),
    testCharacteristic: jest.fn(() => false),
    addOptionalCharacteristic: jest.fn(),
  };
};

describe('EmergencyEvent', () => {
  test('accepts only explicit active boolean and integer reports', () => {
    expect(isEmergencyEvent(booleanSchema(), { code: 'sos', value: true })).toBe(true);
    expect(isEmergencyEvent(booleanSchema(), { code: 'sos', value: false })).toBe(false);
    expect(isEmergencyEvent(integerSchema(), { code: 'sos', value: 1 })).toBe(true);
    expect(isEmergencyEvent(integerSchema(), { code: 'sos', value: 0 })).toBe(false);
    expect(isEmergencyEvent(integerSchema(), { code: 'sos', value: -1 })).toBe(false);
  });

  test('allowlists declared alarm enum values and ignores reset or unknown states', () => {
    const schema = enumSchema(['normal', 'alarm', 'sos']);
    expect(isEmergencyEvent(schema, { code: 'sos_state', value: 'alarm' })).toBe(true);
    expect(isEmergencyEvent(schema, { code: 'SOS_STATE', value: 'SOS' })).toBe(true);
    expect(isEmergencyEvent(schema, { code: 'sos_state', value: 'normal' })).toBe(false);
    expect(isEmergencyEvent(schema, { code: 'sos_state', value: 'emergency' })).toBe(false);
    expect(isEmergencyEvent(enumSchema(['normal']), { code: 'sos_state', value: 'alarm' })).toBe(false);
    expect(isEmergencyEvent(schema, { code: 'another_event', value: 'alarm' })).toBe(false);
  });

  test('configures a single-press-only HomeKit event', () => {
    const service = createService();
    const accessory = {
      Characteristic: { ProgrammableSwitchEvent: { UUID: 'ProgrammableSwitchEvent' } },
    };

    configureEmergencyEvent(accessory as never, service as never, booleanSchema());

    const event = service.characteristics.get('ProgrammableSwitchEvent')!;
    expect(event.setProps).toHaveBeenLastCalledWith({
      minValue: 0,
      maxValue: 0,
      validValues: [0],
    });
  });
});

describe('EmergencyButtonAccessory', () => {
  test('maps sos and sos_state as alternative required datapoints', () => {
    const handler = Object.create(EmergencyButtonAccessory.prototype) as EmergencyButtonAccessory;
    expect(handler.requiredSchema()).toEqual([['sos', 'sos_state']]);
  });

  test('emits one press for an active update after initialization and never sends a command', async () => {
    const schema = booleanSchema();
    const service = createService();
    const sendCommands = jest.fn();
    const handler = Object.create(EmergencyButtonAccessory.prototype) as EmergencyButtonAccessory;
    Object.assign(handler, {
      intialized: true,
      device: { name: 'SOS Button' },
      accessory: {
        getService: jest.fn(() => service),
        addService: jest.fn(() => service),
      },
      Service: { StatelessProgrammableSwitch: 'StatelessProgrammableSwitch' },
      Characteristic: { ProgrammableSwitchEvent: { UUID: 'ProgrammableSwitchEvent' } },
      getSchema: jest.fn(() => schema),
      updateAllValues: jest.fn(),
      sendCommands,
      log: { info: jest.fn() },
    });

    await handler.onDeviceStatusUpdate([{ code: 'sos', value: false }]);
    expect(service.characteristics.has('ProgrammableSwitchEvent')).toBe(false);

    await handler.onDeviceStatusUpdate([{ code: 'sos', value: true }]);
    expect(service.characteristics.get('ProgrammableSwitchEvent')?.updateValue).toHaveBeenCalledWith(0);
    expect(sendCommands).not.toHaveBeenCalled();
  });

  test('suppresses cached startup state before the handler is initialized', async () => {
    const schema = booleanSchema();
    const service = createService();
    const handler = Object.create(EmergencyButtonAccessory.prototype) as EmergencyButtonAccessory;
    Object.assign(handler, {
      intialized: false,
      device: { name: 'SOS Button' },
      accessory: { getService: jest.fn(() => service) },
      Characteristic: { ProgrammableSwitchEvent: { UUID: 'ProgrammableSwitchEvent' } },
      getSchema: jest.fn(() => schema),
      updateAllValues: jest.fn(),
      log: { info: jest.fn() },
    });

    await handler.onDeviceStatusUpdate([{ code: 'sos', value: true }]);

    expect(service.characteristics.has('ProgrammableSwitchEvent')).toBe(false);
  });
});
