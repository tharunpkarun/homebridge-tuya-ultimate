import debounce from 'debounce';
import BaseAccessory from './BaseAccessory';

const POWER_OFF = 0;
const POWER_ON = 1;

const AC_MODE_COOL = 0;
const AC_MODE_HEAT = 1;
const AC_MODE_AUTO = 2;
const TEMPERATURE_TOLERANCE = 0.5;
const POWER_ON_AUTO_REPLAY_GUARD_MS = 2000;

export type IRAirConditionerPowerOnMode = 'cool' | 'heat' | 'auto' | 'last';

const DEFAULT_POWER_ON_MODE: IRAirConditionerPowerOnMode = 'cool';
const POWER_ON_MODES: IRAirConditionerPowerOnMode[] = ['cool', 'heat', 'auto', 'last'];

export default class IRAirConditionerAccessory extends BaseAccessory {

  private lastClimateMode?: number;
  private pendingPowerOnMode?: number;
  private suppressDefaultAutoUntil = 0;

  configureServices() {
    this.rememberClimateMode(this.getMode());
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
        this.setActive(value);
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

  setActive(value) {
    const { ACTIVE } = this.Characteristic.Active;
    const isPoweringOn = value === ACTIVE && this.getPower() !== POWER_ON;

    if (isPoweringOn) {
      const powerOnMode = this.getPowerOnMode();
      this.pendingPowerOnMode = powerOnMode;
      this.suppressDefaultAutoUntil = powerOnMode === AC_MODE_AUTO
        ? 0
        : Date.now() + POWER_ON_AUTO_REPLAY_GUARD_MS;
      if (powerOnMode !== this.getMode()) {
        this.setMode(powerOnMode);
      }
    } else if (value !== ACTIVE) {
      this.pendingPowerOnMode = undefined;
      this.suppressDefaultAutoUntil = 0;
    }

    this.setPower((value === ACTIVE) ? POWER_ON : POWER_OFF);
  }

  getMode() {
    const value = this.getStatus('mode')?.value || '0';
    return parseInt(value.toString());
  }

  setMode(value) {
    this.getStatus('mode')!.value = value;
    this.rememberClimateMode(value);
    this.updateCurrentState();
    this.debounceSendACCommands();
  }

  getSupportedClimateModes() {
    const modes = this.device.remote_keys?.key_range
      ?.map(item => item.mode)
      .filter(mode => [AC_MODE_COOL, AC_MODE_HEAT, AC_MODE_AUTO].includes(mode)) || [];
    return [...new Set(modes)];
  }

  isSupportedClimateMode(mode: number | undefined): mode is number {
    return mode !== undefined && this.getSupportedClimateModes().includes(mode);
  }

  rememberClimateMode(mode: number | undefined) {
    if (this.isSupportedClimateMode(mode)) {
      this.lastClimateMode = mode;
    }
  }

  homeKitToTuyaMode(value) {
    const { AUTO, HEAT, COOL } = this.Characteristic.TargetHeaterCoolerState;
    return {
      [COOL.toString()]: AC_MODE_COOL,
      [HEAT.toString()]: AC_MODE_HEAT,
      [AUTO.toString()]: AC_MODE_AUTO,
    }[value?.toString()];
  }

  tuyaToHomeKitMode(mode: number) {
    const { AUTO, HEAT, COOL } = this.Characteristic.TargetHeaterCoolerState;
    return {
      [AC_MODE_COOL.toString()]: COOL,
      [AC_MODE_HEAT.toString()]: HEAT,
      [AC_MODE_AUTO.toString()]: AUTO,
    }[mode.toString()];
  }

  getCachedTargetMode() {
    const target = this.mainService().getCharacteristic(this.Characteristic.TargetHeaterCoolerState);
    const mode = this.homeKitToTuyaMode(target.value);
    // HAP initializes TargetHeaterCoolerState to AUTO before the first read.
    // An explicit HomeKit selection is already captured by setMode(), so an
    // otherwise uncorroborated cached AUTO must not become the power-on mode.
    return this.isSupportedClimateMode(mode) && mode !== AC_MODE_AUTO ? mode : undefined;
  }

  getActivationMode() {
    const cachedTarget = this.getCachedTargetMode();
    if (cachedTarget !== undefined) {
      return cachedTarget;
    }
    if (this.isSupportedClimateMode(this.lastClimateMode)) {
      return this.lastClimateMode;
    }

    const currentMode = this.getMode();
    if (this.isSupportedClimateMode(currentMode)) {
      return currentMode;
    }

    const supportedModes = this.getSupportedClimateModes();
    return supportedModes.find(mode => mode === AC_MODE_COOL)
      ?? supportedModes.find(mode => mode === AC_MODE_HEAT)
      ?? supportedModes.find(mode => mode === AC_MODE_AUTO)
      ?? AC_MODE_COOL;
  }

  getPowerOnModeProfile(): IRAirConditionerPowerOnMode {
    const configured = this.platform.getDeviceConfig(this.device)?.irAirConditionerPowerOnMode;
    const configuredMode = typeof configured === 'string'
      ? configured.trim().toLowerCase()
      : undefined;

    return POWER_ON_MODES.includes(configuredMode as IRAirConditionerPowerOnMode)
      ? configuredMode as IRAirConditionerPowerOnMode
      : DEFAULT_POWER_ON_MODE;
  }

  getFallbackClimateMode() {
    const supportedModes = this.getSupportedClimateModes();
    return supportedModes.find(mode => mode === AC_MODE_COOL)
      ?? supportedModes.find(mode => mode === AC_MODE_HEAT)
      ?? supportedModes.find(mode => mode === AC_MODE_AUTO)
      ?? AC_MODE_COOL;
  }

  getPowerOnMode() {
    const profile = this.getPowerOnModeProfile();
    const requestedMode = profile === 'last'
      ? this.getActivationMode()
      : {
        cool: AC_MODE_COOL,
        heat: AC_MODE_HEAT,
        auto: AC_MODE_AUTO,
      }[profile];

    return this.isSupportedClimateMode(requestedMode)
      ? requestedMode
      : this.getFallbackClimateMode();
  }

  setTargetMode(value) {
    const mode = this.homeKitToTuyaMode(value);
    if (!this.isSupportedClimateMode(mode)) {
      return;
    }

    // Apple Home can replay its default Auto target alongside a plain Active
    // write. While inactive, only the Auto profile treats that value as the
    // requested power-on mode. Last retains the last operating mode.
    if (mode === AC_MODE_AUTO
      && this.getPower() !== POWER_ON
      && this.getPowerOnModeProfile() !== 'auto') {
      return;
    }

    // Apple may replay its default Auto target after the 100 ms IR debounce
    // has already flushed. Keep a short activation guard so that delayed
    // writes from the same Turn On sequence cannot issue a second Auto IR
    // command. Explicit target changes work normally after the guard expires.
    if (mode === AC_MODE_AUTO
      && ((this.pendingPowerOnMode !== undefined
        && this.pendingPowerOnMode !== AC_MODE_AUTO)
        || Date.now() < this.suppressDefaultAutoUntil)) {
      return;
    }

    if (mode === AC_MODE_AUTO) {
      this.suppressDefaultAutoUntil = 0;
    }
    this.pendingPowerOnMode = undefined;
    this.setMode(mode);
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
      .onGet(() => {
        const currentMode = this.getMode();
        if (this.isSupportedClimateMode(currentMode)) {
          this.rememberClimateMode(currentMode);
          return this.tuyaToHomeKitMode(currentMode)!;
        }
        return this.tuyaToHomeKitMode(this.getActivationMode()) ?? COOL;
      })
      .onSet(async value => {
        this.setTargetMode(value);
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
    const mode = this.pendingPowerOnMode ?? this.getMode();
    if (mode !== this.getMode()) {
      this.getStatus('mode')!.value = mode;
      this.rememberClimateMode(mode);
      this.updateCurrentState();
    }
    this.pendingPowerOnMode = undefined;
    await this.deviceManager.sendInfraredACCommands(parent_id!, id, this.getPower(), mode, this.getTemp(), wind);
  }
}
