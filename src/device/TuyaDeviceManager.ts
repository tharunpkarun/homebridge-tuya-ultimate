import EventEmitter from 'events';
import TuyaOpenAPI from '../core/TuyaOpenAPI';
import TuyaOpenMQ from '../core/TuyaOpenMQ';
import { TuyaCloudAPI, TuyaMessageBus } from '../core/TuyaCloudAPI';
import { ExLogger, logger, PrefixLogger } from '../util/Logger';
import TuyaDevice, {
  TuyaDeviceSchema,
  TuyaDeviceSchemaMode,
  TuyaDeviceSchemaProperty,
  TuyaDeviceSchemaType,
  TuyaDeviceStatus,
  TuyaIRRemoteKeyListItem,
} from './TuyaDevice';
import { RTSPCameraConfig } from '../config';
import { uuidFromSeed } from '../util/util';
import TuyaLocalCommandRouter from '../local/TuyaLocalCommandRouter';
import RuntimeDiagnosticsStore, { CommandAttemptDiagnostic } from '../diagnostics/RuntimeDiagnosticsStore';

enum Events {
  DEVICE_ADD = 'DEVICE_ADD',
  DEVICE_INFO_UPDATE = 'DEVICE_INFO_UPDATE',
  DEVICE_STATUS_UPDATE = 'DEVICE_STATUS_UPDATE',
  DEVICE_DELETE = 'DEVICE_DELETE',
}

enum TuyaMQTTProtocol {
  DEVICE_STATUS_UPDATE = 4,
  DEVICE_INFO_UPDATE = 20,
}

const IR_AC_STATUS_CODES = ['power', 'mode', 'temp', 'wind'] as const;
const IR_AC_REQUIRED_STATUS_CODES = ['power', 'mode', 'temp'] as const;
const IR_AC_DEFAULT_MAX_AGE_MS = 2_000;
const IR_AC_PARENT_MAX_AGE_MS = 15_000;
const IR_AC_EVENT_REFRESH_DELAY_MS = 1_000;
const IR_AC_EVENT_RETRY_DURATION_MS = 60_000;
const IR_AC_WATCH_INTERVAL_MS = 5_000;
const IR_AC_WATCH_DURATION_MS = 30_000;
const IR_AC_WATCH_COOLDOWN_MS = 120_000;
const IR_AC_LOCAL_COMMAND_SETTLE_MS = 5_000;
const IR_AC_FAILURE_BACKOFF_CAP_MS = 60_000;

type InfraredACStatusSyncState = {
  inFlight?: Promise<boolean>;
  lastSuccess: number;
  revision: number;
  suppressUntil: number;
  failureCount: number;
  nextAllowedAt: number;
  eventTimer?: NodeJS.Timeout;
  eventTimerDueAt: number;
  eventDirty: boolean;
  eventGeneration: number;
  eventMaxAgeMs: number;
  eventExpiresAt: number;
  successSequence: number;
  localCommandGeneration: number;
  localCommandPending: boolean;
  localCommandsInFlight: Set<number>;
  localCommandOverlap: boolean;
  localCommandNeedsReconciliation: boolean;
  watchTimer?: NodeJS.Timeout;
  watchUntil: number;
  watchCooldownUntil: number;
};

export default class TuyaDeviceManager extends EventEmitter {

  static readonly Events = Events;

  public mq: TuyaMessageBus;
  public ownerIDs: string[] = [];
  public devices: TuyaDevice[] = [];
  public log: ExLogger;
  private localCommandRouter?: TuyaLocalCommandRouter;
  private productApiFallback?: TuyaDeviceManager;
  private runtimeDiagnostics?: RuntimeDiagnosticsStore;
  private readonly infraredACStatusSync = new Map<string, InfraredACStatusSyncState>();
  private infraredACStatusSyncStopped = false;

  constructor(
    public api: TuyaCloudAPI,
    public debug = false,
    messageBus?: TuyaMessageBus,
  ) {
    super();

    this.log = new PrefixLogger(logger(), TuyaDeviceManager.name, debug);

    this.mq = messageBus ?? new TuyaOpenMQ(api as TuyaOpenAPI);
    this.mq.addMessageListener(this.onMQTTMessage.bind(this));
  }

  createVirtualDevice(baseDevice: TuyaDevice, uuid: string): TuyaDevice {
    const cloneDevice = new TuyaDevice(baseDevice);
    const uniqueId = uuid || Date.now().toString(36) + Math.random().toString(36).substring(2);
    cloneDevice.id = `${uniqueId}`;
    cloneDevice.uuid = `${uniqueId}`;
    cloneDevice.name = 'Virtual Device';
    cloneDevice.product_id = `${uniqueId}`;
    cloneDevice.product_name = 'virtual product';
    cloneDevice.sub = true;
    cloneDevice.ip = '';
    cloneDevice.parent_id = baseDevice.id;
    cloneDevice.remote_keys = undefined;
    return cloneDevice;
  }

  createRTSPCameraDevice(cameraConfig: RTSPCameraConfig): TuyaDevice {
    const device = new TuyaDevice({
      id: cameraConfig.deviceId ?? uuidFromSeed(cameraConfig.rtspUrl),
      uuid: cameraConfig.deviceId ?? uuidFromSeed(cameraConfig.rtspUrl),
      name: cameraConfig.deviceName ?? 'RTSP Camera',
      online: true,
      owner_id: '',
      product_id: 'rstp-camera-product',
      product_name: 'RTSP Camera',
      icon: '',
      category: 'sp',
      schema: [
        {
          code: 'motion_switch', // camera accessory requires a motion sensor service, so we add a dummy schema for it
          mode: TuyaDeviceSchemaMode.READ_WRITE,
          type: TuyaDeviceSchemaType.Boolean,
          property: {},
        },
      ],
      status: [],
      ip: '',
      lat: '',
      lon: '',
      time_zone: '',
      create_time: 0,
      active_time: 0,
      update_time: 0,
    });
    this.devices.push(device);
    return device;
  }

  getDevice(deviceID: string) {
    return Array.from(this.devices).find(device => device.id === deviceID);
  }

  setLocalCommandRouter(router: TuyaLocalCommandRouter) {
    this.localCommandRouter = router;
  }

  setProductApiFallback(manager: TuyaDeviceManager) {
    this.productApiFallback = manager;
  }

  setRuntimeDiagnostics(diagnostics: RuntimeDiagnosticsStore) {
    this.runtimeDiagnostics = diagnostics;
  }

  stop() {
    this.infraredACStatusSyncStopped = true;
    for (const state of this.infraredACStatusSync.values()) {
      if (state.eventTimer) {
        clearTimeout(state.eventTimer);
      }
      if (state.watchTimer) {
        clearTimeout(state.watchTimer);
      }
      state.eventTimer = undefined;
      state.eventTimerDueAt = 0;
      state.eventDirty = false;
      state.eventExpiresAt = 0;
      state.watchTimer = undefined;
    }
    this.mq.stop();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async updateDevices(ownerIDs: []): Promise<TuyaDevice[]> {
    return [];
  }

  async updateDevice(deviceID: string) {

    const res = await this.getDeviceInfo(deviceID);
    if (!res.success) {
      return null;
    }

    const device = new TuyaDevice(res.result);
    device.schema = await this.getDeviceSchema(deviceID);

    const oldDevice = this.getDevice(deviceID);
    if (oldDevice) {
      this.devices.splice(this.devices.indexOf(oldDevice), 1);
    }

    this.devices.push(device);

    return device;
  }

  async getDeviceInfo(deviceID: string) {
    const res = await this.api.get(`/v1.0/devices/${deviceID}`);
    return res;
  }

  async getDeviceListInfo(deviceIDs: string[] = []) {
    const res = await this.api.get('/v1.0/devices', { 'device_ids': deviceIDs.join(',') });
    return res;
  }

  async getDeviceSchema(deviceID: string) {
    // const res = await this.api.get(`/v1.2/iot-03/devices/${deviceID}/specification`);
    const res = await this.api.get(`/v1.0/devices/${deviceID}/specifications`);
    if (res.success === false) {
      this.log.warn('Get device specification failed. devId = %s, code = %s, msg = %s', deviceID, res.code, res.msg);
      return [];
    }

    // Combine functions and status together, as it used to be.
    const schemas = new Map<string, TuyaDeviceSchema>();
    for (const { code, type, values } of [...res.result.status, ...res.result.functions]) {
      if (schemas[code]) {
        continue;
      }

      const read = (res.result.status).find(schema => schema.code === code) !== undefined;
      const write = (res.result.functions).find(schema => schema.code === code) !== undefined;
      let mode = TuyaDeviceSchemaMode.UNKNOWN;
      if (read && write) {
        mode = TuyaDeviceSchemaMode.READ_WRITE;
      } else if (read && !write) {
        mode = TuyaDeviceSchemaMode.READ_ONLY;
      } else if (!read && write) {
        mode = TuyaDeviceSchemaMode.WRITE_ONLY;
      }
      let property: TuyaDeviceSchemaProperty;
      try {
        property = JSON.parse(values);
        schemas[code] = { code, mode, type, property };
      } catch (error) {
        // ignore infrared remote's invalid schema because it's not used.
      }
    }

    return Object.values(schemas).sort((a, b) => a.code > b.code ? 1 : -1) as TuyaDeviceSchema[];
  }

  async getInfraredRemotes(infraredID: string) {
    if (this.productApiFallback) {
      return this.productApiFallback.getInfraredRemotes(infraredID);
    }
    const res = await this.api.get(`/v2.0/infrareds/${infraredID}/remotes`);
    return res;
  }

  async getInfraredKeys(infraredID: string, remoteID: string) {
    if (this.productApiFallback) {
      return this.productApiFallback.getInfraredKeys(infraredID, remoteID);
    }
    const res = await this.api.get(`/v2.0/infrareds/${infraredID}/remotes/${remoteID}/keys`);
    return res;
  }

  async getInfraredACStatus(infraredID: string, remoteID: string) {
    if (this.productApiFallback) {
      return this.productApiFallback.getInfraredACStatus(infraredID, remoteID);
    }
    const res = await this.api.get(`/v2.0/infrareds/${infraredID}/remotes/${remoteID}/ac/status`);
    return res;
  }

  async ensureInfraredACStatusFresh(
    deviceID: string,
    maxAgeMs = IR_AC_DEFAULT_MAX_AGE_MS,
  ): Promise<boolean> {
    if (this.infraredACStatusSyncStopped) {
      return false;
    }
    const device = this.getDevice(deviceID);
    if (!device || !this.isResolvedInfraredAC(device)) {
      return false;
    }

    const state = this.getInfraredACStatusSyncState(deviceID);
    if (state.inFlight) {
      return state.inFlight;
    }
    const now = Date.now();
    const boundedMaxAgeMs = Math.max(0, Number.isFinite(maxAgeMs) ? maxAgeMs : IR_AC_DEFAULT_MAX_AGE_MS);
    if ((state.lastSuccess > 0 && now - state.lastSuccess < boundedMaxAgeMs)
      || this.hasActiveInfraredACLocalCommand(state)
      || now < state.suppressUntil
      || now < state.nextAllowedAt) {
      return false;
    }

    const requestRevision = state.revision;
    const request = this.fetchAndMergeInfraredACStatus(device, state, requestRevision);
    state.inFlight = request;
    try {
      return await request;
    } finally {
      if (state.inFlight === request) {
        state.inFlight = undefined;
      }
    }
  }

  watchInfraredACStatus(deviceID: string) {
    if (this.infraredACStatusSyncStopped) {
      return;
    }
    const device = this.getDevice(deviceID);
    if (!device || !this.isResolvedInfraredAC(device)) {
      return;
    }
    const state = this.getInfraredACStatusSyncState(deviceID);
    const now = Date.now();
    if (state.watchTimer || now < state.watchUntil || now < state.watchCooldownUntil) {
      return;
    }
    state.watchUntil = now + IR_AC_WATCH_DURATION_MS;
    state.watchCooldownUntil = state.watchUntil + IR_AC_WATCH_COOLDOWN_MS;
    this.scheduleInfraredACWatch(deviceID, state);
  }

  noteInfraredACLocalCommand(deviceID: string) {
    const device = this.getDevice(deviceID);
    if (!device || !this.isResolvedInfraredAC(device)) {
      return 0;
    }
    const state = this.getInfraredACStatusSyncState(deviceID);
    state.localCommandGeneration += 1;
    state.localCommandPending = true;
    state.revision += 1;
    state.lastSuccess = Date.now();
    state.suppressUntil = state.lastSuccess + IR_AC_LOCAL_COMMAND_SETTLE_MS;
    state.failureCount = 0;
    state.nextAllowedAt = 0;
    return state.localCommandGeneration;
  }

  beginInfraredACLocalCommand(deviceID: string, commandGeneration: number) {
    const device = this.getDevice(deviceID);
    if (!device || !this.isResolvedInfraredAC(device) || commandGeneration <= 0) {
      return;
    }
    const state = this.getInfraredACStatusSyncState(deviceID);
    state.localCommandsInFlight.add(commandGeneration);
    if (state.localCommandsInFlight.size > 1) {
      state.localCommandOverlap = true;
    }
  }

  completeInfraredACLocalCommand(deviceID: string, commandGeneration: number, successful: boolean) {
    const device = this.getDevice(deviceID);
    if (!device || !this.isResolvedInfraredAC(device)) {
      return;
    }
    const state = this.getInfraredACStatusSyncState(deviceID);
    state.localCommandsInFlight.delete(commandGeneration);
    const isLatestCommand = commandGeneration === state.localCommandGeneration;
    if (isLatestCommand) {
      state.localCommandPending = false;
    }
    if (!successful) {
      state.localCommandNeedsReconciliation = true;
    }
    const now = Date.now();
    state.suppressUntil = Math.max(state.suppressUntil, now + IR_AC_LOCAL_COMMAND_SETTLE_MS);
    if (this.hasActiveInfraredACLocalCommand(state)) {
      return;
    }

    state.failureCount = 0;
    state.nextAllowedAt = 0;
    if (state.localCommandOverlap || state.localCommandNeedsReconciliation || !isLatestCommand) {
      state.revision += 1;
      state.lastSuccess = 0;
      state.localCommandOverlap = false;
      state.localCommandNeedsReconciliation = false;
      this.queueInfraredACStatusRefresh(deviceID, 0);
      return;
    }

    state.lastSuccess = now;
    this.schedulePendingInfraredACStatusRefresh(deviceID, state, 0);
  }

  private getInfraredACStatusSyncState(deviceID: string) {
    let state = this.infraredACStatusSync.get(deviceID);
    if (!state) {
      state = {
        lastSuccess: 0,
        revision: 0,
        suppressUntil: 0,
        failureCount: 0,
        nextAllowedAt: 0,
        eventDirty: false,
        eventTimerDueAt: 0,
        eventGeneration: 0,
        eventMaxAgeMs: Number.POSITIVE_INFINITY,
        eventExpiresAt: 0,
        successSequence: 0,
        localCommandGeneration: 0,
        localCommandPending: false,
        localCommandsInFlight: new Set<number>(),
        localCommandOverlap: false,
        localCommandNeedsReconciliation: false,
        watchUntil: 0,
        watchCooldownUntil: 0,
      };
      this.infraredACStatusSync.set(deviceID, state);
    }
    return state;
  }

  private isResolvedInfraredAC(device: TuyaDevice) {
    return Boolean(
      device.parent_id
      && device.isIRRemoteControl()
      && IR_AC_REQUIRED_STATUS_CODES.every(code => device.status.some(status => status.code === code)),
    );
  }

  private hasActiveInfraredACLocalCommand(state: InfraredACStatusSyncState) {
    return state.localCommandPending || state.localCommandsInFlight.size > 0;
  }

  private async fetchAndMergeInfraredACStatus(
    device: TuyaDevice,
    state: InfraredACStatusSyncState,
    requestRevision: number,
  ) {
    try {
      const response = await this.getInfraredACStatus(device.parent_id!, device.id);
      if (this.infraredACStatusSyncStopped || state.revision !== requestRevision) {
        return false;
      }
      if (!response.success
        || !response.result
        || typeof response.result !== 'object'
        || Array.isArray(response.result)
        || !IR_AC_REQUIRED_STATUS_CODES.every(code => this.isSafeInfraredACStatusValue(response.result[code]))) {
        this.recordInfraredACStatusRefreshFailure(state);
        this.log.debug('Get infrared AC status refresh failed. deviceId = %s, code = %s, msg = %s',
          device.id, response.success ? 'invalid-result' : response.code, response.success ? '' : response.msg);
        return false;
      }

      const changed: TuyaDeviceStatus[] = [];
      for (const code of IR_AC_STATUS_CODES) {
        const value = response.result[code];
        if (!this.isSafeInfraredACStatusValue(value)) {
          continue;
        }
        const current = device.status.find(status => status.code === code);
        if (current) {
          if (current.value !== value) {
            current.value = value;
            changed.push({ code, value });
          }
        } else {
          device.status.push({ code, value });
          changed.push({ code, value });
        }
      }

      state.lastSuccess = Date.now();
      state.failureCount = 0;
      state.nextAllowedAt = 0;
      state.successSequence += 1;
      if (changed.length > 0) {
        state.revision += 1;
        device.status.sort((a, b) => a.code > b.code ? 1 : -1);
        this.emit(Events.DEVICE_STATUS_UPDATE, device, changed);
      }
      return changed.length > 0;
    } catch (error) {
      if (!this.infraredACStatusSyncStopped && state.revision === requestRevision) {
        this.recordInfraredACStatusRefreshFailure(state);
        this.log.debug('Get infrared AC status refresh failed. deviceId = %s, error = %s', device.id, String(error));
      }
      return false;
    }
  }

  private isSafeInfraredACStatusValue(value: unknown): value is string | number | boolean {
    return typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))
      || (typeof value === 'string' && value.length <= 64);
  }

  private recordInfraredACStatusRefreshFailure(state: InfraredACStatusSyncState) {
    state.failureCount = Math.min(state.failureCount + 1, 16);
    const delay = Math.min(1_000 * Math.pow(2, state.failureCount - 1), IR_AC_FAILURE_BACKOFF_CAP_MS);
    state.nextAllowedAt = Date.now() + delay;
  }

  private markInfraredACStatusFresh(deviceID: string, complete: boolean) {
    const state = this.getInfraredACStatusSyncState(deviceID);
    state.revision += 1;
    state.lastSuccess = Date.now();
    state.failureCount = 0;
    state.nextAllowedAt = 0;
    state.successSequence += 1;
    if (complete) {
      this.clearPendingInfraredACStatusRefresh(state);
    }
  }

  private clearPendingInfraredACStatusRefresh(state: InfraredACStatusSyncState) {
    if (state.eventTimer) {
      clearTimeout(state.eventTimer);
    }
    state.eventTimer = undefined;
    state.eventTimerDueAt = 0;
    state.eventDirty = false;
    state.eventMaxAgeMs = Number.POSITIVE_INFINITY;
    state.eventExpiresAt = 0;
  }

  private queueInfraredACStatusRefresh(
    deviceID: string,
    maxAgeMs: number,
    delayMs = IR_AC_EVENT_REFRESH_DELAY_MS,
    invalidateInFlight = false,
  ) {
    if (this.infraredACStatusSyncStopped) {
      return;
    }
    const state = this.getInfraredACStatusSyncState(deviceID);
    const invalidatesCurrentRead = invalidateInFlight && state.inFlight !== undefined;
    if (invalidatesCurrentRead) {
      state.revision += 1;
    }
    const now = Date.now();
    state.eventDirty = true;
    state.eventGeneration += 1;
    state.eventMaxAgeMs = Math.min(state.eventMaxAgeMs, invalidatesCurrentRead ? 0 : Math.max(0, maxAgeMs));
    state.eventExpiresAt = Math.max(state.eventExpiresAt, now + IR_AC_EVENT_RETRY_DURATION_MS);
    this.schedulePendingInfraredACStatusRefresh(deviceID, state, delayMs);
  }

  private schedulePendingInfraredACStatusRefresh(
    deviceID: string,
    state: InfraredACStatusSyncState,
    delayMs: number,
  ) {
    if (!state.eventDirty || this.infraredACStatusSyncStopped) {
      return;
    }
    const now = Date.now();
    const requestedDueAt = now + Math.max(0, delayMs);
    const dueAt = state.eventExpiresAt > 0
      ? Math.min(requestedDueAt, state.eventExpiresAt)
      : requestedDueAt;
    if (state.eventTimer) {
      if (state.eventTimerDueAt <= dueAt) {
        return;
      }
      clearTimeout(state.eventTimer);
      state.eventTimer = undefined;
    }
    state.eventTimerDueAt = dueAt;
    state.eventTimer = setTimeout(() => {
      state.eventTimer = undefined;
      state.eventTimerDueAt = 0;
      void this.processPendingInfraredACStatusRefresh(deviceID, state);
    }, Math.max(0, dueAt - Date.now()));
    state.eventTimer.unref?.();
  }

  private async processPendingInfraredACStatusRefresh(deviceID: string, state: InfraredACStatusSyncState) {
    if (this.infraredACStatusSyncStopped || !state.eventDirty) {
      return;
    }
    const now = Date.now();
    if (state.eventExpiresAt > 0 && now >= state.eventExpiresAt) {
      this.clearPendingInfraredACStatusRefresh(state);
      return;
    }
    const device = this.getDevice(deviceID);
    if (!device || !this.isResolvedInfraredAC(device)) {
      this.clearPendingInfraredACStatusRefresh(state);
      return;
    }
    if (this.hasActiveInfraredACLocalCommand(state)) {
      return;
    }
    if (state.inFlight) {
      const inFlight = state.inFlight;
      void inFlight.finally(() => {
        this.schedulePendingInfraredACStatusRefresh(deviceID, state, 0);
      });
      return;
    }

    const freshnessDelayUntil = state.lastSuccess > 0 && Number.isFinite(state.eventMaxAgeMs)
      ? state.lastSuccess + state.eventMaxAgeMs
      : 0;
    const eligibleAt = Math.max(state.suppressUntil, state.nextAllowedAt, freshnessDelayUntil);
    if (now < eligibleAt) {
      this.schedulePendingInfraredACStatusRefresh(deviceID, state, eligibleAt - now);
      return;
    }

    const generation = state.eventGeneration;
    const successSequence = state.successSequence;
    await this.ensureInfraredACStatusFresh(deviceID, 0);
    if (this.infraredACStatusSyncStopped || !state.eventDirty) {
      return;
    }
    if (state.successSequence > successSequence && state.eventGeneration === generation) {
      this.clearPendingInfraredACStatusRefresh(state);
      return;
    }
    this.schedulePendingInfraredACStatusRefresh(deviceID, state, 0);
  }

  private scheduleInfraredACWatch(deviceID: string, state: InfraredACStatusSyncState) {
    if (state.watchTimer || this.infraredACStatusSyncStopped || Date.now() >= state.watchUntil) {
      return;
    }
    state.watchTimer = setTimeout(() => {
      state.watchTimer = undefined;
      if (this.infraredACStatusSyncStopped || Date.now() >= state.watchUntil) {
        return;
      }
      void this.ensureInfraredACStatusFresh(deviceID, 0).finally(() => {
        this.scheduleInfraredACWatch(deviceID, state);
      });
    }, IR_AC_WATCH_INTERVAL_MS);
    state.watchTimer.unref?.();
  }

  private reconcileInfraredACStatusAfterMQTT(device: TuyaDevice, status: TuyaDeviceStatus[]) {
    if (this.isResolvedInfraredAC(device)) {
      const reportedCodes = new Set(status.map(item => item.code));
      const hasKnownStatus = IR_AC_STATUS_CODES.some(code => reportedCodes.has(code));
      const hasCompleteStatus = IR_AC_REQUIRED_STATUS_CODES.every(code => reportedCodes.has(code));
      if (hasKnownStatus) {
        this.markInfraredACStatusFresh(device.id, hasCompleteStatus);
      }
      if (!hasCompleteStatus) {
        this.queueInfraredACStatusRefresh(device.id, 0);
      }
      return;
    }

    for (const child of this.devices.filter(candidate => candidate.parent_id === device.id && this.isResolvedInfraredAC(candidate))) {
      this.queueInfraredACStatusRefresh(child.id, IR_AC_PARENT_MAX_AGE_MS, IR_AC_EVENT_REFRESH_DELAY_MS, true);
    }
  }

  private filterInfraredACStatusDuringLocalCommand(device: TuyaDevice, status: TuyaDeviceStatus[]) {
    if (!this.isResolvedInfraredAC(device)) {
      return status;
    }
    const state = this.getInfraredACStatusSyncState(device.id);
    const hasActiveLocalCommand = this.hasActiveInfraredACLocalCommand(state);
    if (!hasActiveLocalCommand && Date.now() >= state.suppressUntil) {
      return status;
    }
    const acceptedStatus = status.filter(item => !IR_AC_STATUS_CODES.some(code => code === item.code));
    if (hasActiveLocalCommand && acceptedStatus.length !== status.length) {
      state.localCommandNeedsReconciliation = true;
    }
    return acceptedStatus;
  }

  async getInfraredDIYKeys(infraredID: string, remoteID: string) {
    if (this.productApiFallback) {
      return this.productApiFallback.getInfraredDIYKeys(infraredID, remoteID);
    }
    const res = await this.api.get(`/v2.0/infrareds/${infraredID}/remotes/${remoteID}/learning-codes`);
    return res;
  }

  resolveInfraredRemotes(parentDevice: TuyaDevice, allDevices: TuyaDevice[]) {
    const isInfraredRemoteDevice = (parent:TuyaDevice, target:TuyaDevice) => {
      if (!target.sub || !target.category.startsWith('infrared_')) {
        return false;
      }
      if (parent.lat === target.lat && parent.lon === target.lon) {
        return true;
      }
      if (parent.update_time === target.update_time) {
        return true;
      }
      return false;
    };
    const infraredRemotes = allDevices.filter(device => {
      return isInfraredRemoteDevice(parentDevice, device);
    }).map(device => {
      return {
        'category_id': 999,
        'remote_id': device.id,
        'resolved': true,
      };
    });
    return infraredRemotes;
  }

  fixInfraredDevice(subDevice: TuyaDevice) {
    subDevice.remote_keys!.org_category_id = subDevice.remote_keys!.category_id;
    subDevice.remote_keys!.category_id = this.resolveHAPCategoryID(subDevice);
  }

  resolveHAPCategoryID(subDevice: TuyaDevice) {
    this.log.debug(`resolve HAP category ID. subDevice category:${subDevice.category}, categoryID:${subDevice.remote_keys?.category_id}`);
    let category_id;
    switch(subDevice.product_id) {
      case 'prsgoryjfdtb42r4':
        category_id = 8; // Fan
        break;
      case 'k6ozylayfgnskuq6':
        category_id = 999; // DIY
        break;
      default:
        category_id = subDevice.remote_keys?.category_id || 999; // DIY;
    }
    this.log.debug(`resolved HAP category ID:${category_id}`);
    return category_id;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dump(obj:any) {
    for (const key in obj) {
      try {
        if ((typeof obj[key]) === 'function') {
          this.log.warn(`\t function ${key}:${obj[key].name}`);
        } else {
          this.log.warn(`\t ${key}:${obj[key]}`);
        }
      } catch (e) {
        this.dump(e);
      }
      if ((typeof obj[key]) !== 'string') {
        for (const key2 in obj[key]) {
          try {
            if ((typeof obj[key][key2]) === 'function') {
              this.log.warn(`\t function ${key2}:${obj[key][key2].name}`);
            } else {
              this.log.warn(`\t ${key2}:${obj[key][key2]}`);
            }
          } catch (e) {
            this.dump(e);
          }
        }
      }
    }
  }

  async updateInfraredRemotes(allDevices: TuyaDevice[]) {
    const irDevices = allDevices.filter(device => device.isIRControlHub());
    for (const irDevice of irDevices) {
      const res = await this.getInfraredRemotes(irDevice.id);

      if (!res.success) {
        this.log.warn('Get infrared remotes failed. deviceId = %s, code = %s, msg = %s', irDevice.id, res.code, res.msg);
        continue;
      }
      let resResult = res.result;
      for (const resolvedRemoteDevice of this.resolveInfraredRemotes(irDevice, allDevices)) {
        resResult.forEach(remoteDevice => {
          if (remoteDevice.remote_id === resolvedRemoteDevice.remote_id) {
            remoteDevice.org_category_id = remoteDevice.category_id;
            remoteDevice.category_id = resolvedRemoteDevice.category_id;
            remoteDevice.resolved = true;
          }
        });
      }
      if (resResult.length === 0) {
        // for legacy devices
        this.log.warn('no result for Get infrared remotes.');
        this.log.info('resolving infrared remotes from device list...');
        resResult = this.resolveInfraredRemotes(irDevice, allDevices);
        this.log.success(`${resResult.length} infrared remote device found.`);
      }

      for (const { category_id, remote_id, resolved } of resResult) {
        const subDevice = allDevices.find(device => device.id === remote_id);
        if (!subDevice) {
          continue;
        }
        subDevice.parent_id = irDevice.id;
        subDevice.schema = [];
        const res = await this.getInfraredKeys(irDevice.id, subDevice.id);
        if (!res.success) {
          this.log.warn('Get infrared remote keys failed. deviceId = %s, code = %s, msg = %s', subDevice.id, res.code, res.msg);
          continue;
        }
        subDevice.remote_keys = res.result || {};
        this.log.debug(`infrared keys lengh:${subDevice.remote_keys?.key_list?.length}`);

        if (resolved) {
          this.fixInfraredDevice(subDevice);
        }

        if (subDevice.category === 'infrared_ac') { // AC Device
          const res = await this.getInfraredACStatus(irDevice.id, subDevice.id);
          if (!res.success) {
            this.log.warn('Get infrared ac status failed. deviceId = %s, code = %s, msg = %s', subDevice.id, res.code, res.msg);
            continue;
          }
          subDevice.status = Object.entries(res.result).map(([key, value]) => ({code: key, value} as TuyaDeviceStatus));
        } else if (category_id === 999) { // DIY Device
          const res = await this.getInfraredDIYKeys(irDevice.id, subDevice.id);
          if (!res.success) {
            this.log.warn('Get infrared diy keys failed. deviceId = %s, code = %s, msg = %s', subDevice.id, res.code, res.msg);
            continue;
          }
          const key_list = subDevice.remote_keys?.key_list || [];
          this.log.debug(`key list length:${key_list.length}`);
          const ignoreList:TuyaIRRemoteKeyListItem[] = [];
          for (const key of key_list) {
            if (key.standard_key) {
              if (resolved) {
                ignoreList.push(key);
              }
              continue;
            }
            const item = (res.result as []).find(item => item['id'] === key.key_id && item['key'] === key.key);
            if (!item) {
              if (resolved) {
                ignoreList.push(key);
              }
              continue;
            }
            this.log.debug('learning_code:', item['code']);
            key.learning_code = item['code'];
          }
          if (subDevice.remote_keys && ignoreList.length !== 0) {
            this.log.debug('remove standard instructions. not need for DIY Device');
            subDevice.remote_keys.key_list = subDevice.remote_keys?.key_list.filter(item => !ignoreList.includes(item));
            this.log.debug(`new key list length:${subDevice.remote_keys?.key_list.length}`);
          }
        }
      }
    }
  }

  async sendInfraredCommands(infraredID: string, remoteID: string, category_id: number, remote_index: number, key: string, key_id: number) {
    if (this.productApiFallback) {
      return this.productApiFallback.sendInfraredCommands(infraredID, remoteID, category_id, remote_index, key, key_id);
    }
    const res = await this.api.post(`/v2.0/infrareds/${infraredID}/remotes/${remoteID}/raw/command`, {
      category_id, remote_index, key, key_id,
    });
    return res;
  }

  async sendInfraredACCommands(infraredID: string, remoteID: string, power: number, mode: number, temp: number, wind: number) {
    if (this.productApiFallback) {
      return this.productApiFallback.sendInfraredACCommands(infraredID, remoteID, power, mode, temp, wind);
    }
    const commands = (power === 1) ? { power, mode, temp, wind } : { power };
    const res = await this.api.post(`/v2.0/infrareds/${infraredID}/air-conditioners/${remoteID}/scenes/command`, commands);
    if (!res.success) {
      this.log.info('Send AC command failed. code = %d, msg = %s', res.code, res.msg);
    }
    return res;
  }

  async sendInfraredDIYCommands(infraredID: string, remoteID: string, code: string) {
    if (this.productApiFallback) {
      return this.productApiFallback.sendInfraredDIYCommands(infraredID, remoteID, code);
    }
    const res = await this.api.post(`/v2.0/infrareds/${infraredID}/remotes/${remoteID}/learning-codes`, { code });
    // const res = await this.api.post(`/v1.0/infrareds/${infraredID}/remotes/${remoteID}/learning-codes`, { code });
    return res;
  }


  async getLockTemporaryKey(deviceID: string) {
    if (this.productApiFallback) {
      return this.productApiFallback.getLockTemporaryKey(deviceID);
    }
    // const res = await this.api.post(`/v1.0/smart-lock/devices/${deviceID}/door-lock/password-ticket`);
    const res = await this.api.post(`/v1.0/smart-lock/devices/${deviceID}/password-ticket`);
    if (res.success === false) {
      this.log.warn('Get Temporary Pass failed. devID = %s, code = %s, msg = %s', deviceID, res.code, res.msg);
    }
    return res;
  }

  async sendLockCommands(deviceID: string, ticketID: string, open: boolean) {
    if (this.productApiFallback) {
      return this.productApiFallback.sendLockCommands(deviceID, ticketID, open);
    }
    const res = await this.api.post(`/v1.0/smart-lock/devices/${deviceID}/password-free/door-operate`, {
      device_id: deviceID,
      ticket_id: ticketID,
      open,
    });
    return res;
  }


  async sendCommands(deviceID: string, commands: TuyaDeviceStatus[]) {
    const sendCloud = () => this.sendCloudCommands(deviceID, commands);
    const device = this.getDevice(deviceID);
    const observe = (attempt: CommandAttemptDiagnostic) => {
      this.runtimeDiagnostics?.recordCommand(deviceID, commands.map(command => command.code), attempt);
    };
    return device && this.localCommandRouter
      ? this.localCommandRouter.send(device, commands, sendCloud, observe)
      : this.sendObservedCloud(sendCloud, observe);
  }

  private async sendObservedCloud(
    sendCloud: () => Promise<unknown>,
    observe: (attempt: CommandAttemptDiagnostic) => void,
  ) {
    const startedAt = Date.now();
    try {
      const result = await sendCloud();
      if (result === false) {
        observe({
          requestedRoute: 'cloud',
          attemptedRoute: 'cloud',
          outcome: 'failure',
          durationMs: Date.now() - startedAt,
          error: new Error('Tuya Cloud rejected the command.'),
        });
        return result;
      }
      observe({
        requestedRoute: 'cloud',
        attemptedRoute: 'cloud',
        outcome: 'success',
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      observe({
        requestedRoute: 'cloud',
        attemptedRoute: 'cloud',
        outcome: 'failure',
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  }

  protected async sendCloudCommands(deviceID: string, commands: TuyaDeviceStatus[]) {
    const res = await this.api.post(`/v1.0/devices/${deviceID}/commands`, { commands });
    return res.success ? res.result : false;
  }

  async getCurrentWeather(lat: string, lon: string) {
    const res = await this.api.get(`/v2.0/iot-03/weather/current?lat=${lat}&lon=${lon}`);
    return res.result;
  }

  async getCurrentWeatherByOpenMeteo(lat: string, lon: string) {
    /** <a href="https://open-meteo.com/">Weather data by Open-Meteo.com</a> */
    // eslint-disable-next-line max-len
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m`, { cache: 'no-cache' });
    return await res.json();
  }

  async retrieveDeviceRTSP(device: TuyaDevice): Promise<string> {
    if (device['camera'] && device['camera'].rtspUrl) {
      const cameraConfig = device['camera'] as RTSPCameraConfig;
      const rtspUrl = cameraConfig.rtspUrl;
      if (rtspUrl.includes('@') || !cameraConfig.username) {
        return rtspUrl;
      } else {
        return `rtsp://${cameraConfig.username}:${cameraConfig.password}@${rtspUrl.substring('rtsp://'.length)}`;
      }
    }
    if (this.productApiFallback) {
      return this.productApiFallback.retrieveDeviceRTSP(device);
    }
    const data = await this.api.post(`/v1.0/devices/${device.id}/stream/actions/allocate`, { type: 'rtsp' });
    return data.result.url;
  }


  async onMQTTMessage(topic: string, protocol: TuyaMQTTProtocol, message) {
    this.runtimeDiagnostics?.recordMqtt(
      protocol,
      typeof message?.devId === 'string' ? message.devId : undefined,
    );
    switch(protocol) {
      case TuyaMQTTProtocol.DEVICE_STATUS_UPDATE: {
        const { devId, status } = message;
        const device = this.getDevice(devId);
        if (!device) {
          return;
        }
        const acceptedStatus = this.filterInfraredACStatusDuringLocalCommand(device, status);

        for (const item of device.status) {
          const _item = acceptedStatus.find(_item => _item.code === item.code);
          if (!_item) {
            continue;
          }
          item.value = _item.value;
        }

        this.reconcileInfraredACStatusAfterMQTT(device, acceptedStatus);
        if (acceptedStatus.length > 0) {
          this.emit(Events.DEVICE_STATUS_UPDATE, device, acceptedStatus);
        }
        break;
      }
      case TuyaMQTTProtocol.DEVICE_INFO_UPDATE: {
        const { bizCode, bizData, devId } = message;
        if (bizCode === 'bindUser') {
          const { ownerId } = bizData;
          if (!this.ownerIDs.includes(ownerId)) {
            this.log.warn('Update devId = %s not included in your ownerIDs. Skip.', devId);
            return;
          }

          // TODO failed if request to quickly
          await new Promise(resolve => setTimeout(resolve, 10000));

          const device = await this.updateDevice(devId);
          if (!device) {
            return;
          }
          this.mq.start(); // Force reconnect, unless new device status update won't get received
          this.emit(Events.DEVICE_ADD, device);
        } else if (bizCode === 'nameUpdate') {
          const { name } = bizData;
          const device = this.getDevice(devId);
          if (!device) {
            return;
          }
          device.name = name;
          this.emit(Events.DEVICE_INFO_UPDATE, device, bizData);
        } else if (bizCode === 'online' || bizCode === 'offline') {
          const device = this.getDevice(devId);
          if (!device) {
            return;
          }
          device.online = (bizCode === 'online') ? true : false;
          this.emit(Events.DEVICE_INFO_UPDATE, device, bizData);
        } else if (bizCode === 'delete') {
          const { ownerId } = bizData;
          if (!this.ownerIDs.includes(ownerId)) {
            this.log.warn('Remove devId = %s not included in your ownerIDs. Skip.', devId);
            return;
          }

          const device = this.getDevice(devId);
          if (!device) {
            return;
          }
          this.devices.splice(this.devices.indexOf(device), 1);
          this.emit(Events.DEVICE_DELETE, devId);
        } else if (bizCode === 'event_notify') {
          // doorbell event
        } else if (bizCode === 'p2pSignal') {
          // p2p signal
        } else {
          this.log.warn('Unhandled mqtt message: bizCode = %s, bizData = %o', bizCode, bizData);
        }
        break;
      }
      default:
        this.log.warn('Unhandled mqtt message: protocol = %s, message = %o', protocol, message);
        break;
    }
  }

}
