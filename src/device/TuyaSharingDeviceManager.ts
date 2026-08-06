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
    this.sharingMq.updateSubscriptions(
      homeIDList,
      this.devices.filter(device => device.id && device.set_up !== false).map(device => ({
        id: device.id,
        supportLocal: device.support_local === true,
      })),
    );
    return this.devices;
  }

  async updateInfraredRemotes(allDevices: TuyaDevice[]) {
    const infraredRemotes = allDevices.filter(device => device.category.startsWith('infrared_'));
    if (infraredRemotes.length === 0) {
      return;
    }

    await super.updateInfraredRemotes(allDevices);

    // Tuya's account-sharing identity currently rejects the product-specific
    // /v2.0/infrareds APIs. Do not register a thermostat whose required
    // parent, mode table, state, and command endpoint are therefore missing:
    // HomeKit would otherwise display a misleading 0 °C accessory that cannot
    // send commands. If Tuya grants these endpoints later, fully resolved
    // remotes will pass through unchanged.
    const unresolved = infraredRemotes.filter(device => {
      if (!device.parent_id || !device.remote_keys) {
        return true;
      }
      if (device.category !== 'infrared_ac') {
        return false;
      }
      return !['power', 'mode', 'temp'].every(code => device.status.some(item => item.code === code));
    });
    if (unresolved.length === 0) {
      return;
    }

    for (const device of unresolved) {
      const index = allDevices.indexOf(device);
      if (index >= 0) {
        allDevices.splice(index, 1);
      }
    }
    this.log.warn(
      'Tuya QR authorization does not expose IR remote metadata/control; skipped %d unresolved IR accessory(s). '
      + 'Use Tuya Developer Cloud mode for IR hubs and remotes.',
      unresolved.length,
    );
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
    return device;
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
      parent_id: raw.parent_id ? String(raw.parent_id) : undefined,
      node_id: raw.node_id ? String(raw.node_id) : undefined,
      support_local: supportLocal,
      local_strategy: supportLocal ? localStrategy : {},
    });
    device.set_up = raw.set_up !== false;
    return device;
  }
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
