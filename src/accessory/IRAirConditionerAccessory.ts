import debounce from 'debounce';
import BaseAccessory from './BaseAccessory';

const POWER_OFF = 0;
const POWER_ON = 1;

const AC_MODE_COOL = 0;
const AC_MODE_HEAT = 1;
const AC_MODE_AUTO = 2;
const TEMPERATURE_TOLERANCE = 0.5;

export default class IRAirConditionerAccessory extends BaseAccessory {

  configureServices() {
    this.removeUnusedModeServices();
    this.configureAirConditioner();
    this.configureAmbientHumidity();
  }

  removeUnusedModeServices() {
    for (const serviceType of [this.Service.HumidifierDehumidifier, this.Service.Fanv2]) {
      const service = this.accessory.getService(serviceType);
      if (service) {
        this.accessory.removeService(service);
      }
    }
  }

  configureAirConditioner() {

    const service = this.mainService();
    const { INACTIVE, ACTIVE } = this.Characteristic.Active;

    // Required Characteristics
    service.getCharacteristic(this.Characteristic.Active)
      .onGet(() => {
        return ([AC_MODE_COOL, AC_MODE_HEAT, AC_MODE_AUTO].includes(this.getMode()) && this.getPower() === POWER_ON) ? ACTIVE : INACTIVE;
      })
      .onSet(async value => {
        if (value === ACTIVE && ![AC_MODE_COOL, AC_MODE_HEAT, AC_MODE_AUTO].includes(this.getMode())) {
          this.setMode(AC_MODE_AUTO);
        }
        this.setPower((value === ACTIVE) ? POWER_ON : POWER_OFF);
      });

    this.configureCurrentState();
    this.configureTargetState();
    this.configureCurrentTemperature();

    this.removeRotationSpeed(service);

    const key_range = this.device.remote_keys?.key_range || [];
    if (key_range.find(item => item.mode === AC_MODE_HEAT)) {
      const [minValue, maxValue] = this.getTempRange(AC_MODE_HEAT)!;
      service.getCharacteristic(this.Characteristic.HeatingThresholdTemperature)
        .onGet(() => {
          if (this.getMode() === AC_MODE_AUTO) {
            return minValue;
          }
          return this.getTemp();
        })
        .onSet(async value => {
          if (this.getMode() === AC_MODE_AUTO) {
            return;
          }
          this.setTemp(value);
        })
        .setProps({ minValue, maxValue, minStep: 1 });
    }
    if (key_range.find(item => item.mode === AC_MODE_COOL)) {
      const [minValue, maxValue] = this.getTempRange(AC_MODE_COOL)!;
      service.getCharacteristic(this.Characteristic.CoolingThresholdTemperature)
        .onGet(this.getTemp.bind(this))
        .onSet(this.setTemp.bind(this))
        .setProps({ minValue, maxValue, minStep: 1 });
    }
  }

  mainService() {
    return this.accessory.getService(this.Service.HeaterCooler)
      || this.accessory.addService(this.Service.HeaterCooler);
  }

  removeRotationSpeed(service) {
    if (service.testCharacteristic(this.Characteristic.RotationSpeed)) {
      service.removeCharacteristic(service.getCharacteristic(this.Characteristic.RotationSpeed));
    }
  }

  getPower() {
    const value = this.getStatus('power')?.value || '0';
    return (value === true || parseInt(value.toString()) === 1) ? POWER_ON : POWER_OFF;
  }

  setPower(value) {
    this.getStatus('power')!.value = value;
    this.updateCurrentState();
    this.debounceSendACCommands();
  }

  getMode() {
    const value = this.getStatus('mode')?.value || '0';
    return parseInt(value.toString());
  }

  setMode(value) {
    this.getStatus('mode')!.value = value;
    this.updateCurrentState();
    this.debounceSendACCommands();
  }

  getTemp() {
    const value = this.getStatus('temp')?.value || '0';
    return parseInt(value.toString());
  }

  setTemp(value) {
    this.getStatus('temp')!.value = value;
    this.updateCurrentState();
    this.debounceSendACCommands();
  }

  getKeyRangeItem(mode: number) {
    const key_range = this.device.remote_keys?.key_range || [];
    return key_range.find(item => item.mode === mode);
  }

  getTempRange(mode: number) {
    const keyRangeItem = this.getKeyRangeItem(mode);
    if (!keyRangeItem || !keyRangeItem.temp_list || keyRangeItem.temp_list.length === 0) {
      return undefined;
    }

    const tempList = keyRangeItem.temp_list.map((temp) => temp.temp);

    const min = Math.min(...tempList);
    const max = Math.max(...tempList);
    return [min, max];
  }

  getParentDevice() {
    return this.deviceManager.getDevice(this.device.parent_id!);
  }

  getParentSensorValue(code: string) {
    const parent = this.getParentDevice();
    const status = parent?.status?.find(item => item.code === code);
    if (status?.value === undefined || status.value === null) {
      return undefined;
    }

    const schema = parent?.schema?.find(item => item.code === code);
    const property = schema?.property;
    const scale = property && typeof property === 'object' && 'scale' in property
      ? Number(property.scale)
      : 0;
    const divisor = Math.pow(10, scale || 0);
    const value = Number(status.value) / divisor;
    return Number.isFinite(value) ? value : undefined;
  }

  getAmbientTemperature() {
    return this.getParentSensorValue('temp_current') ?? this.getTemp();
  }

  getAmbientHumidity() {
    return this.getParentSensorValue('humidity_current') ?? 0;
  }

  configureAmbientHumidity() {
    const service = this.accessory.getService(this.Service.HumiditySensor)
      || this.accessory.addService(this.Service.HumiditySensor, this.accessory.displayName + ' Humidity');
    service.getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.getAmbientHumidity());
  }

  configureTargetState() {
    const { AUTO, HEAT, COOL } = this.Characteristic.TargetHeaterCoolerState;

    const validValues: number[] = [];
    const key_range = this.device.remote_keys?.key_range || [];
    if (key_range.find(item => item.mode === AC_MODE_AUTO)) {
      validValues.push(AUTO);
    }
    if (key_range.find(item => item.mode === AC_MODE_HEAT)) {
      validValues.push(HEAT);
    }
    if (key_range.find(item => item.mode === AC_MODE_COOL)) {
      validValues.push(COOL);
    }

    if (validValues.length === 0) {
      this.log.warn('Invalid mode range for TargetHeaterCoolerState:', key_range);
      return;
    }

    this.mainService().getCharacteristic(this.Characteristic.TargetHeaterCoolerState)
      .onGet(() => ({
        [AC_MODE_COOL.toString()]: COOL,
        [AC_MODE_HEAT.toString()]: HEAT,
        [AC_MODE_AUTO.toString()]: AUTO,
      }[this.getMode().toString()] || AUTO))
      .onSet(async value => {
        this.setMode({
          [COOL.toString()]: AC_MODE_COOL,
          [HEAT.toString()]: AC_MODE_HEAT,
          [AUTO.toString()]: AC_MODE_AUTO,
        }[value.toString()]);
      })
      .setProps({ validValues });
  }

  configureCurrentTemperature() {
    this.mainService().getCharacteristic(this.Characteristic.CurrentTemperature)
      .onGet(() => this.getAmbientTemperature());
  }

  configureCurrentState() {
    this.mainService().getCharacteristic(this.Characteristic.CurrentHeaterCoolerState)
      .onGet(() => this.getCurrentState());
  }

  getCurrentState() {
    const { INACTIVE, IDLE, HEATING, COOLING } = this.Characteristic.CurrentHeaterCoolerState;
    const mode = this.getMode();
    if (this.getPower() !== POWER_ON || ![AC_MODE_COOL, AC_MODE_HEAT, AC_MODE_AUTO].includes(mode)) {
      return INACTIVE;
    }

    const currentTemperature = this.getParentSensorValue('temp_current');
    const targetTemperature = this.getTemp();
    if (currentTemperature === undefined) {
      if (mode === AC_MODE_COOL) {
        return COOLING;
      }
      if (mode === AC_MODE_HEAT) {
        return HEATING;
      }
      return IDLE;
    }

    if (mode === AC_MODE_COOL) {
      return currentTemperature > targetTemperature + TEMPERATURE_TOLERANCE ? COOLING : IDLE;
    }
    if (mode === AC_MODE_HEAT) {
      return currentTemperature < targetTemperature - TEMPERATURE_TOLERANCE ? HEATING : IDLE;
    }
    if (currentTemperature > targetTemperature + TEMPERATURE_TOLERANCE) {
      return COOLING;
    }
    if (currentTemperature < targetTemperature - TEMPERATURE_TOLERANCE) {
      return HEATING;
    }
    return IDLE;
  }

  updateCurrentState() {
    const service = this.accessory.getService(this.Service.HeaterCooler);
    if (service) {
      service.getCharacteristic(this.Characteristic.CurrentHeaterCoolerState)
        .updateValue(this.getCurrentState());
    }
  }

  debounceSendACCommands = debounce(this.sendACCommands, 100);

  async sendACCommands() {
    const { parent_id, id } = this.device;
    const wind = parseInt((this.getStatus('wind')?.value || '0').toString());
    await this.deviceManager.sendInfraredACCommands(parent_id!, id, this.getPower(), this.getMode(), this.getTemp(), wind);
  }
}
