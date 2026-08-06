import ElectricityMeterAccessory from '../../src/accessory/ElectricityMeterAccessory';
import TuyaDevice, {
  TuyaDeviceSchema,
  TuyaDeviceSchemaMode,
  TuyaDeviceSchemaType,
} from '../../src/device/TuyaDevice';

const ENERGY_UUID = {
  CURRENT: 'E863F126-079E-48FF-8F27-9C2605A29F52',
  POWER: 'E863F10D-079E-48FF-8F27-9C2605A29F52',
  VOLTAGE: 'E863F10A-079E-48FF-8F27-9C2605A29F52',
  TOTAL: 'E863F10C-079E-48FF-8F27-9C2605A29F52',
};

class TestCharacteristic {
  static readonly UUID = 'test-characteristic';
  public value?: unknown;
  public getHandler?: () => unknown;
  public setHandler?: (value: unknown) => unknown;
  public props: Record<string, unknown>;

  constructor(
    public readonly displayName = '',
    public readonly UUID = TestCharacteristic.UUID,
    props: Record<string, unknown> = {},
  ) {
    this.props = props;
  }

  onGet(handler: () => unknown) {
    this.getHandler = handler;
    return this;
  }

  onSet(handler: (value: unknown) => unknown) {
    this.setHandler = handler;
    return this;
  }

  setProps(props: Record<string, unknown>) {
    this.props = { ...this.props, ...props };
    return this;
  }

  updateValue(value: unknown) {
    this.value = value;
    return this;
  }
}

class TestService {
  public readonly characteristics = new Map<string, TestCharacteristic>();

  constructor(
    public readonly type: string,
    public readonly name: string,
    public readonly subtype: string,
  ) {}

  getCharacteristic(characteristic: unknown) {
    const key = characteristicKey(characteristic);
    if (!this.characteristics.has(key)) {
      this.characteristics.set(key, new TestCharacteristic(key, key));
    }
    return this.characteristics.get(key)!;
  }

  testCharacteristic(characteristic: unknown) {
    return this.characteristics.has(characteristicKey(characteristic));
  }

  addCharacteristic(characteristic: unknown) {
    const CharacteristicConstructor = characteristic as new () => TestCharacteristic;
    const instance = typeof characteristic === 'function'
      ? new CharacteristicConstructor()
      : characteristic as TestCharacteristic;
    this.characteristics.set(characteristicKey(characteristic), instance);
    return instance;
  }

  addOptionalCharacteristic(characteristic: unknown) {
    this.getCharacteristic(characteristic);
  }

  setCharacteristic(characteristic: unknown, value: unknown) {
    this.getCharacteristic(characteristic).updateValue(value);
    return this;
  }
}

function characteristicKey(characteristic: unknown): string {
  if (typeof characteristic === 'string') {
    return characteristic;
  }
  return (characteristic as { UUID?: string }).UUID ?? String(characteristic);
}

function integerSchema(code: string, scale: number, unit: string): TuyaDeviceSchema {
  return {
    code,
    mode: TuyaDeviceSchemaMode.READ_ONLY,
    type: TuyaDeviceSchemaType.Integer,
    property: { min: 0, max: 1_000_000, scale, step: 1, unit },
  };
}

function createHandler(schema: TuyaDeviceSchema[], values: Record<string, number | string>) {
  const services = new Map<string, TestService>();
  const Service = { Outlet: 'Outlet' };
  const Characteristic = {
    Name: 'Name',
    ConfiguredName: 'ConfiguredName',
    On: 'On',
    OutletInUse: 'OutletInUse',
  };
  const device = new TuyaDevice({
    id: 'meter-1',
    uuid: 'meter-uuid',
    name: 'Main Meter',
    online: true,
    category: 'zndb',
    product_id: 'meter-product',
    product_name: 'Electricity Meter',
    schema,
    status: Object.entries(values).map(([code, value]) => ({ code, value })),
    sub: false,
  });
  const accessory = {
    services: [] as TestService[],
    getService: jest.fn((subtype: string) => services.get(subtype)),
    addService: jest.fn((type: string, name: string, subtype: string) => {
      const service = new TestService(type, name, subtype);
      services.set(subtype, service);
      accessory.services.push(service);
      return service;
    }),
  };
  const platform = {
    api: {
      hap: {
        Characteristic: TestCharacteristic,
        Formats: { FLOAT: 'float' },
        Perms: { NOTIFY: 'ev', PAIRED_READ: 'pr', PAIRED_WRITE: 'pw' },
        HapStatusError: class HapStatusError extends Error {},
        HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
      },
    },
    getDeviceSchemaConfig: jest.fn(() => undefined),
  };

  const handler = Object.create(ElectricityMeterAccessory.prototype) as ElectricityMeterAccessory;
  Object.assign(handler, {
    platform,
    accessory,
    device,
    Service,
    Characteristic,
    log: { warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
    intialized: true,
  });

  return { handler, accessory, device, services };
}

describe('ElectricityMeterAccessory', () => {
  test('exposes scaled aggregate readings without a writable control', () => {
    const { handler, device, services } = createHandler([
      integerSchema('cur_current', 0, 'mA'),
      integerSchema('cur_power', 1, 'W'),
      integerSchema('cur_voltage', 1, 'V'),
      integerSchema('forward_energy_total', 2, 'kWh'),
    ], {
      cur_current: 1250,
      cur_power: 4321,
      cur_voltage: 2304,
      forward_energy_total: 12345,
    });

    handler.configureServices();

    const service = services.get('electricity-meter')!;
    const on = service.getCharacteristic('On');
    expect(on.getHandler?.()).toBe(true);
    expect(on.setHandler).toBeUndefined();
    expect(on.props.perms).toEqual(['pr', 'ev']);
    expect((on.props.perms as string[])).not.toContain('pw');
    expect(service.getCharacteristic('OutletInUse').getHandler?.()).toBe(true);

    expect(service.getCharacteristic(ENERGY_UUID.CURRENT).getHandler?.()).toBe(1.25);
    expect(service.getCharacteristic(ENERGY_UUID.POWER).getHandler?.()).toBe(432.1);
    expect(service.getCharacteristic(ENERGY_UUID.VOLTAGE).getHandler?.()).toBe(230.4);
    expect(service.getCharacteristic(ENERGY_UUID.TOTAL).getHandler?.()).toBe(123.45);

    device.status.find(status => status.code === 'cur_current')!.value = 0;
    device.status.find(status => status.code === 'cur_power')!.value = 0;
    expect(service.getCharacteristic('OutletInUse').getHandler?.()).toBe(false);
  });

  test('creates stable per-phase services only for numeric scalar datapoints', () => {
    const rawPhase: TuyaDeviceSchema = {
      code: 'phase_b',
      mode: TuyaDeviceSchemaMode.READ_ONLY,
      type: TuyaDeviceSchemaType.Raw,
      property: {},
    };
    const { handler, accessory, services } = createHandler([
      integerSchema('phase_a_current', 3, 'A'),
      rawPhase,
    ], {
      phase_a_current: 2500,
      phase_b: 'unverified-raw-payload',
    });

    handler.configureServices();

    expect(accessory.addService).toHaveBeenCalledTimes(1);
    expect(services.has('electricity-meter')).toBe(false);
    expect(services.has('electricity-meter-phase-a')).toBe(true);
    expect(services.has('electricity-meter-phase-b')).toBe(false);
    expect(services.get('electricity-meter-phase-a')!
      .getCharacteristic(ENERGY_UUID.CURRENT).getHandler?.()).toBe(2.5);
  });

  test('does not treat reverse energy as total household consumption', () => {
    const { handler, accessory } = createHandler([
      integerSchema('reverse_energy_total', 2, 'kWh'),
    ], {
      reverse_energy_total: 1200,
    });

    handler.configureServices();

    expect(accessory.addService).not.toHaveBeenCalled();
    expect(handler.requiredSchema()[0]).not.toContain('reverse_energy_total');
  });
});
