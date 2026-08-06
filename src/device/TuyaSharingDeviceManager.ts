import TuyaSharingAPI, { TuyaSharingRequestError } from '../core/TuyaSharingAPI';
import TuyaSharingMQ from '../core/TuyaSharingMQ';
import { convertSharingStatus } from '../core/TuyaSharingStrategy';
import TuyaDevice, {
  TuyaDeviceSchema,
  TuyaDeviceSchemaMode,
  TuyaDeviceSchemaProperty,
  TuyaDeviceSchemaType,
  TuyaDeviceStatus,
  TuyaSharingLocalStrategy,
} from './TuyaDevice';
import TuyaDeviceManager from './TuyaDeviceManager';

type RawSpecification = {
  code: string;
  type: string;
  values?: string;
};

// Tuya returns product-specific extra fields whose shapes are not declared by the API.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawDevice = Record<string, any>;

const SHARING_IR_AC_REQUIRED_FUNCTIONS = ['M', 'PowerOff', 'PowerOn', 'T'] as const;
const SHARING_IR_AC_STATUS_CODES = ['power', 'mode', 'temp', 'wind'] as const;
const SHARING_IR_AC_DEFAULT_TEMPERATURE = 25;
const SHARING_IR_AC_MAX_RANGE_SIZE = 100;

export default class TuyaSharingDeviceManager extends TuyaDeviceManager {
  public readonly sharingMq: TuyaSharingMQ;

  constructor(public readonly sharingApi: TuyaSharingAPI, debug = false) {
    const messageBus = new TuyaSharingMQ(sharingApi);
    super(sharingApi, debug, messageBus);
    this.sharingMq = messageBus;
  }

  async getHomeList() {
    const response = await this.api.get('/v1.0/m/life/users/homes');
    if (!response.success) {
      return response;
    }
    return {
      ...response,
      result: (response.result as RawDevice[]).map(home => ({
        home_id: String(home.ownerId),
        name: String(home.name ?? home.ownerId),
      })),
    };
  }

  async updateDevices(homeIDList: string[]): Promise<TuyaDevice[]> {
    this.ownerIDs = [...homeIDList];
    const devices: TuyaDevice[] = [];
    for (const homeId of homeIDList) {
      const response = await this.api.get('/v1.0/m/life/ha/home/devices', { homeId });
      if (!response.success) {
        throw new TuyaSharingRequestError(
          `Tuya account device inventory failed (${response.code}): ${response.msg}`,
          true,
        );
      }
      for (const raw of response.result as RawDevice[]) {
        devices.push(await this.normalizeDevice(raw, homeId));
      }
    }
    this.devices = deduplicateDevices(devices);
    this.updateSharingSubscriptions(homeIDList);
    return this.devices;
  }

  async updateInfraredRemotes(allDevices: TuyaDevice[]) {
    const infraredRemotes = allDevices.filter(device => device.category.startsWith('infrared_'));
    if (infraredRemotes.length === 0) {
      return;
    }

    const sharingAirConditioners = infraredRemotes.filter(isSharingInfraredAC);
    const sharingSchemas = new Map(sharingAirConditioners.map(device => [device, device.schema]));
    const sharingRemoteKeys = new Map(sharingAirConditioners.map(device => [device, device.remote_keys]));
    if (this.hasProductApiFallback()) {
      // Prefer the richer product API when the user configured it. If it does
      // not resolve an AC, the normal sharing functions remain a safe fallback.
      for (const device of sharingAirConditioners) {
        device.infrared_ac_command_mode = undefined;
      }
      await super.updateInfraredRemotes(allDevices);
    } else {
      const legacyRemotes = infraredRemotes.filter(device => !sharingAirConditioners.includes(device));
      if (legacyRemotes.length > 0) {
        const legacyDevices = allDevices.filter(device => !sharingAirConditioners.includes(device));
        await super.updateInfraredRemotes(legacyDevices);
      }
    }

    let configuredSharingAirConditioners = 0;
    for (const device of sharingAirConditioners) {
      const resolvedByProductApi = Boolean(
        device.infrared_ac_product_api_resolved
        && device.parent_id
        && hasUsableInfraredACKeyRange(device)
        && ['power', 'mode', 'temp'].every(code => device.status.some(item => item.code === code)),
      );
      if (resolvedByProductApi) {
        device.infrared_ac_command_mode = undefined;
        continue;
      }
      if (device.schema.length === 0) {
        device.schema = sharingSchemas.get(device) ?? [];
      }
      device.remote_keys = sharingRemoteKeys.get(device);
      configureSharingInfraredAC(device);
      configuredSharingAirConditioners += 1;
    }

    if (configuredSharingAirConditioners > 0) {
      this.log.info(
        'Enabled %d QR-authorized IR air conditioner(s) through Tuya device-sharing commands.',
        configuredSharingAirConditioners,
      );
    }

    const unresolved = infraredRemotes.filter(device => {
      if ((!device.parent_id && device.infrared_ac_command_mode !== 'device-sharing') || !device.remote_keys) {
        return true;
      }
      if (device.category !== 'infrared_ac') {
        return false;
      }
      return !hasUsableInfraredACKeyRange(device)
        || !['power', 'mode', 'temp'].every(code => device.status.some(item => item.code === code));
    });
    if (unresolved.length === 0) {
      this.updateSharingSubscriptions(this.ownerIDs);
      return;
    }

    for (const device of unresolved) {
      const index = allDevices.indexOf(device);
      if (index >= 0) {
        allDevices.splice(index, 1);
      }
    }
    this.log.warn(
      'Skipped %d QR-authorized IR accessory(s) without a supported sharing command schema. '
      + 'Tuya Developer Cloud fallback is still required for those remotes.',
      unresolved.length,
    );
    this.updateSharingSubscriptions(this.ownerIDs);
  }

  async getInfraredACStatus(infraredID: string, remoteID: string) {
    const device = this.getDevice(remoteID);
    if (device?.infrared_ac_command_mode !== 'device-sharing') {
      return super.getInfraredACStatus(infraredID, remoteID);
    }

    return {
      success: true as const,
      result: Object.fromEntries(SHARING_IR_AC_STATUS_CODES.map(code => [
        code,
        device.status.find(item => item.code === code)?.value,
      ])),
      t: Date.now(),
      tid: `device-sharing-${remoteID}`,
    };
  }

  async sendInfraredACCommands(
    infraredID: string,
    remoteID: string,
    power: number,
    mode: number,
    temp: number,
    wind: number,
  ) {
    const device = this.getDevice(remoteID);
    if (device?.infrared_ac_command_mode !== 'device-sharing') {
      return super.sendInfraredACCommands(infraredID, remoteID, power, mode, temp, wind);
    }

    const commands: TuyaDeviceStatus[] = power === 1
      ? [
        { code: 'M', value: mode },
        { code: 'T', value: temp },
        ...(hasWritableNumericSchema(device, 'F') ? [{ code: 'F', value: wind }] : []),
        { code: 'PowerOn', value: sharingStringFunctionValue(device, 'PowerOn') },
      ]
      : [{ code: 'PowerOff', value: sharingStringFunctionValue(device, 'PowerOff') }];
    const response = await this.sharingApi.postWithQuery(
      `/v1.1/m/thing/${remoteID}/commands`,
      undefined,
      { commands },
    );
    if (!response.success) {
      this.log.info('Send QR-authorized IR AC command failed. code = %s, msg = %s', response.code, response.msg);
    }
    return response;
  }

  async updateDevice(deviceID: string): Promise<TuyaDevice | null> {
    const response = await this.api.get('/v1.0/m/life/ha/devices/detail', { devIds: deviceID });
    if (!response.success || !Array.isArray(response.result) || response.result.length === 0) {
      return null;
    }
    const old = this.getDevice(deviceID);
    const device = await this.normalizeDevice(response.result[0], old?.owner_id ?? '');
    if (old) {
      this.devices.splice(this.devices.indexOf(old), 1);
    }
    this.devices.push(device);
    if (device.category.startsWith('infrared_')) {
      await this.updateInfraredRemotes(this.devices);
    }
    this.updateSharingSubscriptions(this.ownerIDs);
    return this.getDevice(deviceID) ?? null;
  }

  async getSceneList(homeID: string) {
    const response = await this.api.get('/v1.0/m/scene/ha/home/scenes', { homeId: homeID });
    if (!response.success) {
      throw new TuyaSharingRequestError(
        `Tuya account scene inventory failed (${response.code}): ${response.msg}`,
        true,
      );
    }
    return (response.result as RawDevice[])
      .filter(scene => scene.enabled !== false)
      .map(scene => new TuyaDevice({
        id: String(scene.scene_id),
        uuid: String(scene.scene_id),
        name: String(scene.name ?? scene.scene_id),
        owner_id: homeID,
        product_id: 'scene',
        product_name: 'Scene',
        category: 'scene',
        schema: [],
        status: [],
        online: true,
        icon: '', ip: '', lat: '', lon: '', time_zone: '',
        create_time: 0, active_time: 0, update_time: 0, sub: false,
      }));
  }

  async executeScene(homeID: string | number, sceneID: string) {
    return this.sharingApi.postWithQuery('/v1.0/m/scene/ha/trigger', undefined, {
      homeId: String(homeID),
      sceneId: sceneID,
    });
  }

  protected async sendCloudCommands(deviceID: string, commands: TuyaDeviceStatus[]) {
    const response = await this.sharingApi.postWithQuery(
      `/v1.1/m/thing/${deviceID}/commands`,
      undefined,
      { commands },
    );
    return response.success ? response.result : false;
  }

  async onMQTTMessage(topic: string, protocol: number, message: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (protocol === 20) {
      const normalizedMessage = message?.devId || !message?.bizData?.devId
        ? message
        : { ...message, devId: String(message.bizData.devId) };
      if (normalizedMessage?.bizData?.ownerId !== undefined) {
        normalizedMessage.bizData = {
          ...normalizedMessage.bizData,
          ownerId: String(normalizedMessage.bizData.ownerId),
        };
      }
      return super.onMQTTMessage(topic, protocol, normalizedMessage);
    }
    if (protocol !== 4 || !Array.isArray(message?.status)) {
      return super.onMQTTMessage(topic, protocol, message);
    }
    const device = this.getDevice(String(message.devId));
    if (!device) {
      return;
    }

    const normalized: TuyaDeviceStatus[] = [];
    for (const item of message.status) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      if ('code' in item && 'value' in item) {
        normalized.push({ code: String(item.code), value: item.value });
        continue;
      }
      if (!('dpId' in item) || !('value' in item)) {
        continue;
      }
      const strategy = device.local_strategy?.[Number(item.dpId)];
      if (!strategy) {
        continue;
      }
      try {
        const converted = convertSharingStatus(strategy.value_convert, item.value, strategy.config_item);
        const schema = device.schema.find(entry => entry.code === converted.code);
        const enumRange = schema?.type === TuyaDeviceSchemaType.Enum
          && typeof schema.property === 'object'
          && schema.property !== null
          && 'range' in schema.property
          ? schema.property.range
          : undefined;
        if (Array.isArray(enumRange) && !enumRange.includes(String(converted.value))) {
          continue;
        }
        normalized.push(converted as TuyaDeviceStatus);
      } catch (error) {
        this.log.warn('Failed to convert %s DP %s: %s', device.name, item.dpId, String(error));
      }
    }

    return super.onMQTTMessage(topic, protocol, { ...message, status: normalized });
  }

  private async normalizeDevice(raw: RawDevice, homeId: string): Promise<TuyaDevice> {
    const [specResponse, strategyResponse, customTypeResponse, reportTypesResponse] = await Promise.all([
      this.api.get(`/v1.1/m/life/${raw.id}/specifications`),
      this.api.get(`/v1.0/m/life/devices/${raw.id}/status`),
      this.api.get(`/v1.0/m/life/ha/${raw.id}/code/custom-type`),
      this.api.get(`/v1.0/m/life/ha/${raw.id}/dp-report-types`),
    ]);
    const specification = specResponse.success ? specResponse.result as RawDevice : {};
    const strategyResult = strategyResponse.success ? strategyResponse.result as RawDevice : {};
    const localStrategy: Record<number, TuyaSharingLocalStrategy> = {};
    let supportLocal = true;
    for (const relation of strategyResult.dpStatusRelationDTOS ?? []) {
      if (relation.supportLocal === false) {
        supportLocal = false;
      }
      localStrategy[Number(relation.dpId)] = {
        value_convert: String(relation.valueConvert),
        status_code: String(relation.statusCode),
        config_item: {
          statusFormat: String(relation.statusFormat),
          valueDesc: String(relation.valueDesc),
          valueType: String(relation.valueType),
          enumMappingMap: relation.enumMappingMap ?? {},
          pid: String(strategyResult.productKey ?? raw.product_id ?? ''),
        },
      };
    }
    if ((strategyResult.dpStatusRelationDTOS ?? []).length === 0) {
      supportLocal = false;
    }
    if (customTypeResponse.success && isEnabledCustomType(customTypeResponse.result)) {
      supportLocal = false;
    }

    const reportTypes = new Map<string, string>();
    if (reportTypesResponse.success && Array.isArray(reportTypesResponse.result)) {
      for (const item of reportTypesResponse.result) {
        if (item?.dp_code && item?.report_type) {
          reportTypes.set(String(item.dp_code), String(item.report_type));
        }
      }
    }

    const status = Array.isArray(raw.status)
      ? raw.status.filter(item => item?.code !== undefined).map(item => ({ code: String(item.code), value: item.value }))
      : Object.entries(raw.status ?? {}).map(([code, value]) => ({ code, value }));
    const device = new TuyaDevice({
      id: String(raw.id),
      uuid: String(raw.uuid ?? raw.id),
      name: String(raw.name ?? raw.id),
      online: raw.online !== false,
      owner_id: String(raw.owner_id ?? raw.asset_id ?? homeId),
      product_id: String(raw.product_id ?? strategyResult.productKey ?? ''),
      product_name: String(raw.product_name ?? ''),
      model: raw.model ? String(raw.model) : undefined,
      icon: String(raw.icon ?? ''),
      category: String(raw.category ?? ''),
      schema: mergeSchema(specification.functions ?? [], specification.status ?? [], reportTypes),
      status,
      ip: String(raw.ip ?? ''),
      lat: String(raw.lat ?? ''),
      lon: String(raw.lon ?? ''),
      time_zone: String(raw.time_zone ?? ''),
      create_time: Number(raw.create_time ?? 0),
      active_time: Number(raw.active_time ?? 0),
      update_time: Number(raw.update_time ?? 0),
      sub: raw.sub === true,
      parent_id: raw.parent_id || raw.parent ? String(raw.parent_id ?? raw.parent) : undefined,
      node_id: raw.node_id ? String(raw.node_id) : undefined,
      support_local: supportLocal,
      local_strategy: supportLocal ? localStrategy : {},
    });
    // Tuya marks virtual IR remotes as not set up even though their normal
    // sharing specification exposes a complete, writable AC command surface.
    // Include compatible remotes in MQTT subscriptions so owner/device reports
    // can refresh the optimistic one-way IR state when Tuya publishes them.
    device.set_up = raw.set_up !== false || isSharingInfraredAC(device);
    if (isSharingInfraredAC(device)) {
      configureSharingInfraredAC(device);
    }
    return device;
  }

  private updateSharingSubscriptions(homeIDs: string[]) {
    this.sharingMq.updateSubscriptions(
      homeIDs,
      this.devices.filter(device => device.id && device.set_up !== false).map(device => ({
        id: device.id,
        supportLocal: device.support_local === true,
      })),
    );
  }
}

function isSharingInfraredAC(device: TuyaDevice): boolean {
  if (device.category !== 'infrared_ac') {
    return false;
  }
  return SHARING_IR_AC_REQUIRED_FUNCTIONS.every(code => {
    const schema = device.schema.find(item => item.code === code);
    if (!schema || !isWritableSchema(schema.mode)) {
      return false;
    }
    if (code === 'PowerOn' || code === 'PowerOff') {
      return String(schema.type).toLowerCase() === 'string' && schema.property === code;
    }
    if (code === 'M') {
      return hasNumericProperty(schema)
        && numericPropertyValues(schema)!.some(value => [0, 1, 2].includes(value));
    }
    return hasNumericProperty(schema);
  });
}

function configureSharingInfraredAC(device: TuyaDevice) {
  const modes = numericSchemaValues(device, ['M', 'mode'], [0, 1, 2]);
  const temperatures = numericSchemaValues(device, ['T', 'temp'], [SHARING_IR_AC_DEFAULT_TEMPERATURE]);
  const fans = numericSchemaValues(device, ['F', 'wind'], [0]);
  const defaultTemperature = temperatures.includes(SHARING_IR_AC_DEFAULT_TEMPERATURE)
    ? SHARING_IR_AC_DEFAULT_TEMPERATURE
    : temperatures[0];
  const defaultMode = [0, 1, 2].find(mode => modes.includes(mode))!;

  ensureStatus(device, 'power', false);
  ensureStatus(device, 'mode', defaultMode);
  ensureStatus(device, 'temp', defaultTemperature);
  ensureStatus(device, 'wind', fans.includes(0) ? 0 : fans[0]);

  if (!hasUsableInfraredACKeyRange(device)) {
    device.remote_keys = {
      category_id: 5,
      org_category_id: 5,
      brand_id: 0,
      remote_index: 0,
      single_air: true,
      duplicate_power: false,
      key_list: [],
      key_range: modes.map(mode => ({
        mode,
        mode_name: String(mode),
        temp_list: temperatures.map(temp => ({
          temp,
          temp_name: String(temp),
          fan_list: fans.map(fan => ({ fan, fan_name: String(fan) })),
        })),
      })),
    };
  }
  device.infrared_ac_command_mode = 'device-sharing';
  device.infrared_ac_product_api_resolved = undefined;
}

function hasUsableInfraredACKeyRange(device: TuyaDevice): boolean {
  const keyRange = device.remote_keys?.key_range;
  if (!Array.isArray(keyRange) || keyRange.length === 0) {
    return false;
  }
  if (!keyRange.every(item => item && Number.isFinite(item.mode))) {
    return false;
  }

  const supportedRanges = keyRange.filter(item => [0, 1, 2].includes(item.mode));
  return supportedRanges.length > 0 && supportedRanges.every(item => (
    Array.isArray(item.temp_list)
    && item.temp_list.length > 0
    && item.temp_list.every(temp => (
      Number.isFinite(temp?.temp)
      && Array.isArray(temp.fan_list)
      && temp.fan_list.length > 0
      && temp.fan_list.every(fan => Number.isFinite(fan?.fan))
    ))
  ));
}

function ensureStatus(device: TuyaDevice, code: string, value: TuyaDeviceStatus['value']) {
  if (!device.status.some(item => item.code === code)) {
    device.status.push({ code, value });
    device.status.sort((left, right) => left.code.localeCompare(right.code));
  }
}

function numericSchemaValues(device: TuyaDevice, codes: string[], fallback: number[]): number[] {
  for (const code of codes) {
    const schema = device.schema.find(item => item.code === code);
    const values = numericPropertyValues(schema);
    if (values) {
      return values;
    }
  }
  return fallback;
}

function hasWritableNumericSchema(device: TuyaDevice, code: string): boolean {
  const schema = device.schema.find(item => item.code === code);
  return Boolean(schema && isWritableSchema(schema.mode) && hasNumericProperty(schema));
}

function sharingStringFunctionValue(device: TuyaDevice, code: 'PowerOn' | 'PowerOff'): string {
  const property = device.schema.find(item => item.code === code)?.property;
  return typeof property === 'string' ? property : code;
}

function isWritableSchema(mode: TuyaDeviceSchemaMode): boolean {
  return mode === TuyaDeviceSchemaMode.WRITE_ONLY || mode === TuyaDeviceSchemaMode.READ_WRITE;
}

function hasNumericProperty(schema: TuyaDeviceSchema): boolean {
  return numericPropertyValues(schema) !== undefined;
}

function numericPropertyValues(schema: TuyaDeviceSchema | undefined): number[] | undefined {
  if (!schema || typeof schema.property !== 'object' || schema.property === null) {
    return undefined;
  }
  const property = schema.property as Record<string, unknown>;
  // The observed IR command schema is externally labelled Enum, but its
  // descriptor explicitly declares scale-0 Integer values. Do not generalize
  // that wire format to ordinary string enums or scaled datapoints.
  if (String(schema.type).toLowerCase() !== 'enum'
    || String(property.type).toLowerCase() !== 'integer'
    || Number(property.scale) !== 0) {
    return undefined;
  }
  const min = Number(property.min);
  const max = Number(property.max);
  const step = Number(property.step);
  if (!Number.isInteger(min) || !Number.isInteger(max) || !Number.isInteger(step) || step <= 0 || max < min) {
    return undefined;
  }
  const rangeSize = Math.floor((max - min) / step) + 1;
  if (rangeSize > SHARING_IR_AC_MAX_RANGE_SIZE) {
    return undefined;
  }
  return Array.from({ length: rangeSize }, (_, index) => min + index * step);
}

function mergeSchema(
  functions: RawSpecification[],
  statuses: RawSpecification[],
  reportTypes: Map<string, string>,
): TuyaDeviceSchema[] {
  const codes = new Set([...functions, ...statuses].map(item => item.code));
  return [...codes].map(code => {
    const readable = statuses.find(item => item.code === code);
    const writable = functions.find(item => item.code === code);
    const source = readable ?? writable!;
    const mode = readable && writable
      ? TuyaDeviceSchemaMode.READ_WRITE
      : readable ? TuyaDeviceSchemaMode.READ_ONLY : TuyaDeviceSchemaMode.WRITE_ONLY;
    return {
      code,
      mode,
      type: source.type as TuyaDeviceSchemaType,
      property: parseProperty(source.values),
      report_type: reportTypes.get(code),
    };
  }).sort((left, right) => left.code.localeCompare(right.code));
}

function parseProperty(value?: string): TuyaDeviceSchemaProperty {
  if (!value) {
    return {} as TuyaDeviceSchemaProperty;
  }
  try {
    return JSON.parse(value) as TuyaDeviceSchemaProperty;
  } catch {
    return value as TuyaDeviceSchemaProperty;
  }
}

function deduplicateDevices(devices: TuyaDevice[]): TuyaDevice[] {
  return [...new Map(devices.map(device => [device.id, device])).values()];
}

function isEnabledCustomType(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.toLowerCase() === 'true');
}
