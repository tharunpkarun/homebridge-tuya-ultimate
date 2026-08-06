import { Service } from 'homebridge';

import {
  TuyaDeviceSchema,
  TuyaDeviceSchemaIntegerProperty,
  TuyaDeviceSchemaType,
} from '../device/TuyaDevice';
import BaseAccessory from './BaseAccessory';
import { configureEnergyUsage } from './characteristic/EnergyUsage';
import { configureName } from './characteristic/Name';
import { sanitizeName } from '../util/util';

const SCHEMA_CODE = {
  CURRENT: ['cur_current'],
  POWER: ['cur_power'],
  VOLTAGE: ['cur_voltage'],
  TOTAL: ['forward_energy_total', 'add_ele'],
  PHASE_A_CURRENT: ['phase_a_current'],
  PHASE_A_POWER: ['phase_a_power'],
  PHASE_A_VOLTAGE: ['phase_a_voltage'],
  PHASE_B_CURRENT: ['phase_b_current'],
  PHASE_B_POWER: ['phase_b_power'],
  PHASE_B_VOLTAGE: ['phase_b_voltage'],
  PHASE_C_CURRENT: ['phase_c_current'],
  PHASE_C_POWER: ['phase_c_power'],
  PHASE_C_VOLTAGE: ['phase_c_voltage'],
};

const ALL_SUPPORTED_CODES = Object.values(SCHEMA_CODE).flat();
const MAIN_SERVICE_SUBTYPE = 'electricity-meter';

type MeterMetrics = {
  current?: TuyaDeviceSchema;
  power?: TuyaDeviceSchema;
  voltage?: TuyaDeviceSchema;
  total?: TuyaDeviceSchema;
};

/**
 * A non-commanding representation of a standalone electricity meter.
 *
 * HomeKit does not define a native electricity-meter service. An Outlet is
 * used so the existing Eve-compatible energy characteristics remain visible,
 * but its On characteristic is explicitly read-only and never sends a Tuya
 * command. Raw, compound phase payloads are intentionally not decoded here;
 * only numeric datapoints with schema-provided scale information are exposed.
 */
export default class ElectricityMeterAccessory extends BaseAccessory {

  requiredSchema() {
    // A meter may report only a cumulative total, only instantaneous values,
    // or scalar values for one or more phases.
    return [ALL_SUPPORTED_CODES];
  }

  configureServices() {
    this.configureMeterService(MAIN_SERVICE_SUBTYPE, this.device.name, {
      current: this.currentSchema(...SCHEMA_CODE.CURRENT),
      power: this.schemaWithUnit(['W'], ...SCHEMA_CODE.POWER),
      voltage: this.schemaWithUnit(['V'], ...SCHEMA_CODE.VOLTAGE),
      total: this.schemaWithUnit(['kWh', ''], ...SCHEMA_CODE.TOTAL),
    });

    this.configurePhaseService('a', {
      current: this.currentSchema(...SCHEMA_CODE.PHASE_A_CURRENT),
      power: this.schemaWithUnit(['W'], ...SCHEMA_CODE.PHASE_A_POWER),
      voltage: this.schemaWithUnit(['V'], ...SCHEMA_CODE.PHASE_A_VOLTAGE),
    });
    this.configurePhaseService('b', {
      current: this.currentSchema(...SCHEMA_CODE.PHASE_B_CURRENT),
      power: this.schemaWithUnit(['W'], ...SCHEMA_CODE.PHASE_B_POWER),
      voltage: this.schemaWithUnit(['V'], ...SCHEMA_CODE.PHASE_B_VOLTAGE),
    });
    this.configurePhaseService('c', {
      current: this.currentSchema(...SCHEMA_CODE.PHASE_C_CURRENT),
      power: this.schemaWithUnit(['W'], ...SCHEMA_CODE.PHASE_C_POWER),
      voltage: this.schemaWithUnit(['V'], ...SCHEMA_CODE.PHASE_C_VOLTAGE),
    });
  }

  private configurePhaseService(phase: 'a' | 'b' | 'c', metrics: MeterMetrics) {
    this.configureMeterService(
      `${MAIN_SERVICE_SUBTYPE}-phase-${phase}`,
      `${this.device.name} Phase ${phase.toUpperCase()}`,
      metrics,
    );
  }

  private configureMeterService(subtype: string, name: string, metrics: MeterMetrics) {
    if (!Object.values(metrics).some(Boolean)) {
      return;
    }

    const serviceName = sanitizeName(name) ?? 'Electricity Meter';
    const service = this.accessory.getService(subtype)
      || this.accessory.addService(this.Service.Outlet, serviceName, subtype);

    configureName(this, service, name);
    this.configureReadOnlyOutlet(service, metrics.current, metrics.power);
    configureEnergyUsage(
      this.platform.api,
      this,
      service,
      metrics.current,
      metrics.power,
      metrics.voltage,
      metrics.total,
    );
  }

  private configureReadOnlyOutlet(
    service: Service,
    currentSchema?: TuyaDeviceSchema,
    powerSchema?: TuyaDeviceSchema,
  ) {
    service.getCharacteristic(this.Characteristic.On)
      .onGet(() => {
        this.checkOnlineStatus();
        return true;
      })
      .setProps({
        perms: [
          this.platform.api.hap.Perms.PAIRED_READ,
          this.platform.api.hap.Perms.NOTIFY,
        ],
      });

    service.getCharacteristic(this.Characteristic.OutletInUse)
      .onGet(() => {
        this.checkOnlineStatus();
        return [powerSchema, currentSchema].some(schema => {
          if (!schema) {
            return false;
          }
          const value = this.getStatus(schema.code)?.value;
          return typeof value === 'number' && Number.isFinite(value) && value > 0;
        });
      });
  }

  private numericSchema(...codes: string[]) {
    const schema = this.getSchema(...codes);
    if (!schema || schema.type !== TuyaDeviceSchemaType.Integer) {
      return undefined;
    }

    const property = schema.property as Partial<TuyaDeviceSchemaIntegerProperty>;
    const value = this.getStatus(schema.code)?.value;
    return (Number.isInteger(property.scale)
      && typeof property.unit === 'string'
      && typeof value === 'number'
      && Number.isFinite(value)) ? schema : undefined;
  }

  private schemaWithUnit(units: string[], ...codes: string[]) {
    const schema = this.numericSchema(...codes);
    if (!schema) {
      return undefined;
    }
    const property = schema.property as TuyaDeviceSchemaIntegerProperty;
    return units.includes(property.unit) ? schema : undefined;
  }

  private currentSchema(...codes: string[]) {
    const schema = this.numericSchema(...codes);
    if (!schema) {
      return undefined;
    }

    const property = schema.property as TuyaDeviceSchemaIntegerProperty;
    if (property.unit === 'mA') {
      return schema;
    }
    if (property.unit !== 'A') {
      return undefined;
    }

    // EnergyUsage accepts milliamperes. Preserve an ampere schema's scale by
    // shifting it while keeping the status code and raw value unchanged.
    return {
      ...schema,
      property: {
        ...property,
        scale: property.scale - 3,
        unit: 'mA',
      },
    };
  }
}
