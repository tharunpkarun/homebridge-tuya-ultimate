import TuyaSharingAPI, { TuyaSharingRequestError } from '../core/TuyaSharingAPI';
import TuyaSharingMQ from '../core/TuyaSharingMQ';
import { convertSharingStatus } from '../core/TuyaSharingStrategy';
import TuyaLanProtocol33Client from '../local/TuyaLanProtocol33';
import { TuyaLocalClient } from '../local/TuyaLocalCommandRouter';
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
const SHARING_IR_AC_OPTIONAL_FUNCTIONS = ['F'] as const;
const SHARING_IR_AC_STATUS_CODES = ['power', 'mode', 'temp', 'wind'] as const;
const SHARING_IR_REMOTE_CATEGORIES = new Set([
  'infrared_airpurifier',
  'infrared_amplifier',
  'infrared_box',
  'infrared_fan',
  'infrared_humidifier',
  'infrared_light',
  'infrared_projector',
  'infrared_stb',
  'infrared_tv',
  'infrared_waterheater',
]);
const SHARING_IR_AC_DEFAULT_TEMPERATURE = 25;
const SHARING_IR_AC_MAX_RANGE_SIZE = 100;
const SHARING_IR_MAX_MAPPING_ENTRIES = 256;
const DIRECT_IR_THERMOSTAT_CATEGORY = 'hwktwkq';
const DIRECT_IR_THERMOSTAT_PRODUCTS = new Set(['aqlyorlybbtn6ox7']);
const DIRECT_IR_THERMOSTAT_DEFAULT_CODES = {
  power: 'switch',
  temperature: 'temp_set',
  mode: 'mode',
  fan: 'fan_speed_enum',
} as const;
const DIRECT_IR_THERMOSTAT_MODES = ['cold', 'warm', 'auto', 'air', 'dehumidify'] as const;
const DIRECT_IR_THERMOSTAT_FANS = ['auto', 'low', 'middle', 'high'] as const;

type SharingLanClient = TuyaLocalClient & {
  query?: (device: { id: string; ip: string; localKey: string; timeoutMs?: number }) => Promise<Record<string, unknown>>;
};

export default class TuyaSharingDeviceManager extends TuyaDeviceManager {
  public readonly sharingMq: TuyaSharingMQ;
  private readonly sharingLocalKeys = new Map<string, string>();

  constructor(
    public readonly sharingApi: TuyaSharingAPI,
    debug = false,
    private readonly sharingLanClient: SharingLanClient = new TuyaLanProtocol33Client(),
  ) {
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
    const discoveredIDs = new Set(this.devices.map(device => device.id));
    for (const deviceID of this.sharingLocalKeys.keys()) {
      if (!discoveredIDs.has(deviceID)) {
        this.sharingLocalKeys.delete(deviceID);
      }
    }
    this.updateSharingSubscriptions(homeIDList);
    return this.devices;
  }

  async updateInfraredRemotes(allDevices: TuyaDevice[]) {
    const infraredRemotes = allDevices.filter(device => device.category.startsWith('infrared_'));
    if (infraredRemotes.length === 0) {
      return;
    }

    const sharingAirConditioners = infraredRemotes.filter(isSharingInfraredAC);
    const sharingGenericRemotes = infraredRemotes.filter(isSharingInfraredRemote);
    const sharingRemotes = [...sharingAirConditioners, ...sharingGenericRemotes];
    const sharingSchemas = new Map(sharingRemotes.map(device => [device, device.schema]));
    const sharingRemoteKeys = new Map(sharingRemotes.map(device => [device, device.remote_keys]));
    for (const device of sharingAirConditioners.filter(device => !device.parent_id)) {
      const thermostat = this.findDirectInfraredThermostat(device);
      if (thermostat) {
        device.parent_id = thermostat.id;
        this.log.info(
          'Linked QR-authorized IR air conditioner %s to physical thermostat %s.',
          device.name,
          thermostat.name,
        );
      }
    }
    if (this.hasProductApiFallback()) {
      // Prefer the richer product API when the user configured it. If it does
      // not resolve a remote, the normal sharing functions remain a safe fallback.
      for (const device of sharingAirConditioners) {
        device.infrared_ac_command_mode = undefined;
      }
      await super.updateInfraredRemotes(allDevices);
    } else {
      const legacyRemotes = infraredRemotes.filter(device => !sharingRemotes.includes(device));
      if (legacyRemotes.length > 0) {
        const legacyDevices = allDevices.filter(device => !sharingRemotes.includes(device));
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

    let configuredSharingRemotes = 0;
    for (const device of sharingGenericRemotes) {
      const initialRemoteKeys = sharingRemoteKeys.get(device);
      const resolvedByProductApi = Boolean(
        this.hasProductApiFallback()
        && device.parent_id
        && device.remote_keys !== initialRemoteKeys
        && device.remote_keys?.key_list?.length,
      );
      if (resolvedByProductApi) {
        device.infrared_remote_command_mode = undefined;
        continue;
      }
      if (device.schema.length === 0) {
        device.schema = sharingSchemas.get(device) ?? [];
      }
      device.remote_keys = initialRemoteKeys;
      configureSharingInfraredRemote(device);
      configuredSharingRemotes += 1;
    }

    if (configuredSharingRemotes > 0) {
      this.log.info(
        'Enabled %d QR-authorized IR button remote(s) through Tuya device-sharing commands.',
        configuredSharingRemotes,
      );
    }

    const unresolved = infraredRemotes.filter(device => {
      const usesSharingCommands = device.infrared_ac_command_mode === 'device-sharing'
        || device.infrared_remote_command_mode === 'device-sharing';
      if ((!device.parent_id && !usesSharingCommands) || !device.remote_keys) {
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

    const thermostat = this.findDirectInfraredThermostat(device, infraredID);
    const connection = thermostat && this.getInfraredThermostatLANConnection(device, thermostat);
    if (thermostat && connection && this.sharingLanClient.query) {
      try {
        const dps = await this.sharingLanClient.query(connection);
        this.mergeDirectInfraredThermostatLANStatus(device, thermostat, dps);
      } catch (error) {
        this.log.debug('Local QR-authorized IR thermostat status read failed: %s', String(error));
      }
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
    if (response.success || String(response.code) !== '1109') {
      if (!response.success) {
        this.log.info('Send QR-authorized IR AC command failed. code = %s, msg = %s', response.code, response.msg);
      }
      return response;
    }

    const directTarget = this.getDirectInfraredThermostatCommands(device, infraredID, power, mode, temp, wind);
    if (!directTarget) {
      this.log.info(
        'Send QR-authorized IR AC command failed because no physical hwktwkq thermostat could be resolved. '
        + 'code = %s, msg = %s',
        response.code,
        response.msg,
      );
      return response;
    }

    this.log.info(
      'Tuya rejected the virtual IR AC command; retrying through physical IR thermostat %s.',
      directTarget.thermostat.id,
    );
    const lanResponse = await this.sendDirectInfraredThermostatLAN(directTarget);
    if (lanResponse) {
      return lanResponse;
    }
    const directResponse = await this.sharingApi.postWithQuery(
      `/v1.1/m/thing/${directTarget.thermostat.id}/commands`,
      undefined,
      { commands: directTarget.commands },
    );
    if (!directResponse.success) {
      this.log.info(
        'Send QR-authorized IR thermostat command failed. code = %s, msg = %s',
        directResponse.code,
        directResponse.msg,
      );
    }
    return directResponse;
  }

  private async sendDirectInfraredThermostatLAN(
    target: { remote: TuyaDevice; thermostat: TuyaDevice; commands: TuyaDeviceStatus[] },
  ) {
    const localKey = this.sharingLocalKeys.get(target.thermostat.id);
    if (!localKey) {
      this.log.info('Local IR thermostat retry unavailable: QR inventory did not provide a valid local key.');
      return undefined;
    }
    const connection = this.getInfraredThermostatLANConnection(target.remote, target.thermostat);
    if (!connection) {
      this.log.info('Local IR thermostat retry unavailable: QR inventory did not provide a private LAN address.');
      return undefined;
    }

    const commandDPs = new Map(target.commands.map(command => [command.code, command.value]));
    const dpCode = (dpID: number, fallback: string) => target.thermostat.sharing_dp_codes?.[dpID] || fallback;
    const dps: Record<string, unknown> = {};
    for (const [dpID, fallback] of [
      [1, DIRECT_IR_THERMOSTAT_DEFAULT_CODES.power],
      [3, DIRECT_IR_THERMOSTAT_DEFAULT_CODES.temperature],
      [4, DIRECT_IR_THERMOSTAT_DEFAULT_CODES.mode],
      [5, DIRECT_IR_THERMOSTAT_DEFAULT_CODES.fan],
    ] as const) {
      const value = commandDPs.get(dpCode(dpID, fallback));
      if (value !== undefined) {
        dps[String(dpID)] = value;
      }
    }

    this.log.info('Sending QR-authorized IR thermostat command over the local network.');
    try {
      await this.sharingLanClient.send({
        ...connection,
      }, dps);
      return {
        success: true as const,
        result: true,
        t: Date.now(),
        tid: `device-sharing-lan-${target.thermostat.id}`,
      };
    } catch (error) {
      this.log.warn('Local QR-authorized IR thermostat command failed: %s', String(error));
      return undefined;
    }
  }

  private getInfraredThermostatLANConnection(remote: TuyaDevice, thermostat: TuyaDevice) {
    const localKey = this.sharingLocalKeys.get(thermostat.id);
    const configuredIP = remote.infrared_ac_local_ip?.trim()
      || thermostat.infrared_ac_local_ip?.trim();
    const ip = configuredIP || thermostat.ip.trim();
    if (!localKey || !isPrivateIPv4(ip)) {
      return undefined;
    }
    return { id: thermostat.id, ip, localKey };
  }

  private mergeDirectInfraredThermostatLANStatus(
    remote: TuyaDevice,
    thermostat: TuyaDevice,
    dps: Record<string, unknown>,
  ) {
    const updateRemote = (code: string, value: string | number | boolean | undefined) => {
      if (value === undefined) {
        return;
      }
      const status = remote.status.find(item => item.code === code);
      if (status) {
        status.value = value;
      } else {
        remote.status.push({ code, value });
      }
    };
    const updateThermostat = (code: string, value: number | undefined) => {
      if (value === undefined || !Number.isFinite(value)) {
        return;
      }
      const status = thermostat.status.find(item => item.code === code);
      if (status) {
        status.value = value;
      } else {
        thermostat.status.push({ code, value });
      }
    };

    if (dps['1'] !== undefined) {
      updateRemote('power', dps['1'] === true || Number(dps['1']) === 1 ? 1 : 0);
    }
    const mode = DIRECT_IR_THERMOSTAT_MODES.indexOf(String(dps['4']) as typeof DIRECT_IR_THERMOSTAT_MODES[number]);
    updateRemote('mode', mode >= 0 ? mode : undefined);
    const targetTemperature = Number(dps['3']);
    updateRemote('temp', Number.isFinite(targetTemperature) ? targetTemperature : undefined);
    const fan = DIRECT_IR_THERMOSTAT_FANS.indexOf(String(dps['5']) as typeof DIRECT_IR_THERMOSTAT_FANS[number]);
    updateRemote('wind', fan >= 0 ? fan : undefined);
    const currentTemperature = Number(dps['2']);
    updateThermostat('temp_current', Number.isFinite(currentTemperature) ? currentTemperature / 10 : undefined);
    const humidity = Number(dps['12']);
    updateThermostat('humidity_current', Number.isFinite(humidity) ? humidity : undefined);
  }

  private getDirectInfraredThermostatCommands(
    remote: TuyaDevice,
    infraredID: string,
    power: number,
    mode: number,
    temp: number,
    wind: number,
  ): { remote: TuyaDevice; thermostat: TuyaDevice; commands: TuyaDeviceStatus[] } | undefined {
    const thermostat = this.findDirectInfraredThermostat(remote, infraredID);
    if (!thermostat) {
      return undefined;
    }

    const code = (dpID: number, fallback: string) => thermostat.sharing_dp_codes?.[dpID]
      || fallback;
    const powerCode = code(1, DIRECT_IR_THERMOSTAT_DEFAULT_CODES.power);
    if (power !== 1) {
      return { remote, thermostat, commands: [{ code: powerCode, value: false }] };
    }

    const temperatureCode = code(3, DIRECT_IR_THERMOSTAT_DEFAULT_CODES.temperature);
    const modeCode = code(4, DIRECT_IR_THERMOSTAT_DEFAULT_CODES.mode);
    const modeValue = DIRECT_IR_THERMOSTAT_MODES[mode];
    if (!temperatureCode || !modeCode || !modeValue) {
      return undefined;
    }
    const fanCode = code(5, DIRECT_IR_THERMOSTAT_DEFAULT_CODES.fan);
    const fanValue = DIRECT_IR_THERMOSTAT_FANS[wind];

    return {
      remote,
      thermostat,
      commands: [
        { code: modeCode, value: modeValue },
        { code: temperatureCode, value: temp },
        ...(fanCode && fanValue ? [{ code: fanCode, value: fanValue }] : []),
        { code: powerCode, value: true },
      ],
    };
  }

  private findDirectInfraredThermostat(remote: TuyaDevice, infraredID?: string) {
    const linkedIDs = [infraredID, remote.parent_id].filter((id): id is string => Boolean(id));
    for (const id of linkedIDs) {
      const linkedDevice = this.getDevice(id);
      if (linkedDevice?.category === DIRECT_IR_THERMOSTAT_CATEGORY) {
        return linkedDevice;
      }
    }

    const candidates = this.devices.filter(device => device.category === DIRECT_IR_THERMOSTAT_CATEGORY
      && device.owner_id === remote.owner_id);
    const preferredCandidates = candidates.filter(device => DIRECT_IR_THERMOSTAT_PRODUCTS.has(device.product_id)
      || [1, 3, 4].every(dpID => Boolean(device.sharing_dp_codes?.[dpID])));
    if (preferredCandidates.length === 1) {
      return preferredCandidates[0];
    }
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  async sendInfraredCommands(
    infraredID: string,
    remoteID: string,
    categoryID: number,
    remoteIndex: number,
    key: string,
    keyID: number,
  ) {
    const device = this.getDevice(remoteID);
    if (device?.infrared_remote_command_mode !== 'device-sharing') {
      return super.sendInfraredCommands(infraredID, remoteID, categoryID, remoteIndex, key, keyID);
    }

    const schema = device.schema.find(item => item.code === key);
    const value = staticSharingInfraredFunctionValue(schema) ?? key;
    const response = await this.sharingApi.postWithQuery(
      `/v1.1/m/thing/${remoteID}/commands`,
      undefined,
      { commands: [{ code: key, value }] },
    );
    if (!response.success) {
      this.log.info('Send QR-authorized IR command failed. code = %s, msg = %s', response.code, response.msg);
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
    const rawLocalKey = typeof raw.local_key === 'string' ? raw.local_key : '';
    if (Buffer.byteLength(rawLocalKey, 'utf8') === 16) {
      this.sharingLocalKeys.set(String(raw.id), rawLocalKey);
    } else {
      this.sharingLocalKeys.delete(String(raw.id));
    }
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
    const embeddedSpecification = embeddedDeviceSpecification(raw);
    const mappedInfraredSpecification = sharingInfraredMappingSpecification(raw);
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
      schema: mergeSchema(
        [
          ...(specification.functions ?? []),
          ...embeddedSpecification.functions,
          ...mappedInfraredSpecification.functions,
        ],
        [
          ...(specification.status ?? []),
          ...embeddedSpecification.status,
          ...mappedInfraredSpecification.status,
        ],
        reportTypes,
      ),
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
      sharing_dp_codes: Object.fromEntries(
        Object.entries(localStrategy).map(([dpID, strategy]) => [dpID, strategy.status_code]),
      ),
    });
    // Tuya marks virtual IR remotes as not set up even though their normal
    // sharing specification can expose a complete writable command surface.
    // Include compatible remotes in MQTT subscriptions so owner/device reports
    // can refresh the optimistic one-way IR state when Tuya publishes them.
    device.set_up = raw.set_up !== false || isSharingInfraredAC(device) || isSharingInfraredRemote(device);
    if (isSharingInfraredAC(device)) {
      configureSharingInfraredAC(device);
    } else if (isSharingInfraredRemote(device)) {
      configureSharingInfraredRemote(device);
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

function isPrivateIPv4(value: string) {
  const octets = value.split('.').map(Number);
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function embeddedDeviceSpecification(raw: RawDevice): {
  functions: RawSpecification[];
  status: RawSpecification[];
} {
  return {
    functions: normalizeEmbeddedSpecifications(raw.function),
    status: normalizeEmbeddedSpecifications(raw.status_range),
  };
}

function normalizeEmbeddedSpecifications(value: unknown): RawSpecification[] {
  return specificationEntries(value).flatMap(([mappingCode, entry]) => {
    const code = typeof entry.code === 'string' ? entry.code : mappingCode;
    const type = normalizeMappingSchemaType(entry.type);
    if (!code || !type) {
      return [];
    }
    return [{ code, type, values: serializeMappingValues(entry.values ?? entry.value, code, type) }];
  });
}

function sharingInfraredMappingSpecification(raw: RawDevice): {
  functions: RawSpecification[];
  status: RawSpecification[];
} {
  const result = { functions: [] as RawSpecification[], status: [] as RawSpecification[] };
  const isAirConditioner = raw.category === 'infrared_ac';
  const isButtonRemote = SHARING_IR_REMOTE_CATEGORIES.has(raw.category);
  if (!isAirConditioner && !isButtonRemote) {
    return result;
  }

  const functionCodes = new Set<string>([
    ...SHARING_IR_AC_REQUIRED_FUNCTIONS,
    ...SHARING_IR_AC_OPTIONAL_FUNCTIONS,
  ]);
  const statusCodes = new Set<string>(SHARING_IR_AC_STATUS_CODES);
  for (const [mappingCode, entry] of specificationEntries(raw.mapping)) {
    const code = typeof entry.code === 'string' ? entry.code : mappingCode;
    if (isAirConditioner && !functionCodes.has(code) && !statusCodes.has(code)) {
      continue;
    }
    const type = normalizeMappingSchemaType(entry.type);
    if (!type) {
      continue;
    }
    const rawValues = entry.values ?? entry.value;
    const values = serializeMappingValues(rawValues, code, type);
    const specification = { code, type, values };
    if (isAirConditioner && functionCodes.has(code)) {
      result.functions.push(specification);
    }
    if (isAirConditioner && statusCodes.has(code)) {
      result.status.push(specification);
    }
    if (isButtonRemote && isStaticInfraredMappingFunction(type, rawValues)) {
      result.functions.push(specification);
    }
  }
  return result;
}

function specificationEntries(value: unknown): Array<[string, RawDevice]> {
  let source = value;
  if (typeof source === 'string' && source.length <= 100_000) {
    try {
      source = JSON.parse(source);
    } catch {
      return [];
    }
  }
  if (Array.isArray(source)) {
    return source.slice(0, SHARING_IR_MAX_MAPPING_ENTRIES).flatMap((entry, index) => (
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? [[typeof (entry as RawDevice).code === 'string' ? (entry as RawDevice).code : String(index), entry as RawDevice]]
        : []
    ));
  }
  if (!source || typeof source !== 'object') {
    return [];
  }
  return Object.entries(source as Record<string, unknown>)
    .slice(0, SHARING_IR_MAX_MAPPING_ENTRIES)
    .flatMap(([code, entry]) => (
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? [[code, entry as RawDevice]]
        : []
    ));
}

function serializeMappingValues(value: unknown, code: string, type: string): string {
  if (typeof value === 'string') {
    return value;
  }
  const normalizedValue = value ?? (type === TuyaDeviceSchemaType.String ? code : {});
  return JSON.stringify(normalizedValue);
}

function isStaticInfraredMappingFunction(type: string, value: unknown): boolean {
  return type === TuyaDeviceSchemaType.String
    && (value === undefined || ['string', 'number', 'boolean'].includes(typeof value));
}

function normalizeMappingSchemaType(value: unknown): string | undefined {
  switch (String(value ?? '').toLowerCase()) {
    case 'bool':
    case 'boolean':
      return TuyaDeviceSchemaType.Boolean;
    case 'value':
    case 'integer':
    case 'number':
      return TuyaDeviceSchemaType.Integer;
    case 'enum':
      return TuyaDeviceSchemaType.Enum;
    case 'string':
      return TuyaDeviceSchemaType.String;
    case 'json':
      return TuyaDeviceSchemaType.Json;
    case 'raw':
      return TuyaDeviceSchemaType.Raw;
    default:
      return undefined;
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

function isSharingInfraredRemote(device: TuyaDevice): boolean {
  return SHARING_IR_REMOTE_CATEGORIES.has(device.category)
    && device.schema.some(schema => (
      isWritableSchema(schema.mode)
      && staticSharingInfraredFunctionValue(schema) !== undefined
    ));
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

function configureSharingInfraredRemote(device: TuyaDevice) {
  const functions = device.schema.filter(schema => (
    isWritableSchema(schema.mode)
    && staticSharingInfraredFunctionValue(schema) !== undefined
  ));
  device.remote_keys = {
    category_id: 999,
    org_category_id: 999,
    brand_id: 0,
    remote_index: 0,
    single_air: false,
    duplicate_power: false,
    key_list: functions.map((schema, index) => ({
      key: schema.code,
      key_id: index,
      key_name: schema.code,
      standard_key: true,
    })),
    key_range: [],
  };
  device.infrared_remote_command_mode = 'device-sharing';
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

function staticSharingInfraredFunctionValue(schema: TuyaDeviceSchema | undefined): TuyaDeviceStatus['value'] | undefined {
  if (!schema || String(schema.type).toLowerCase() !== 'string') {
    return undefined;
  }
  if (['string', 'number', 'boolean'].includes(typeof schema.property)) {
    return schema.property as string | number | boolean;
  }
  return undefined;
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
