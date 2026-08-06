import { PlatformConfig } from 'homebridge';
import { TuyaDeviceSchemaProperty, TuyaDeviceSchemaType } from './device/TuyaDevice';

export interface TuyaPlatformDeviceSchemaConfig {
  code: string;
  newCode?: string;
  type?: TuyaDeviceSchemaType;
  property?: TuyaDeviceSchemaProperty;
  onGet?: string;
  onSet?: string;
  hidden?: boolean;
}

export interface TuyaPlatformDeviceConfig {
  id: string;
  hidden?: boolean;
  category?: string;
  schema?: Array<TuyaPlatformDeviceSchemaConfig>;
  unbridged?: boolean;
  adaptiveLighting?: boolean;
  garageDoorUseContactSensorForState?: boolean;
  irAirConditionerPowerOnMode?: 'cool' | 'heat' | 'auto' | 'last';
  irAirConditionerLocalIp?: string;
  localControl?: TuyaPlatformLocalControlConfig;
}

export interface TuyaPlatformLocalControlConfig {
  mode: 'cloud' | 'hybrid' | 'local';
  ip?: string;
  localKey: string;
  protocolVersion?: '3.3';
  timeoutMs?: number;
  dpMap: Array<{ code: string; dpId: number }>;
}

export interface TuyaPlatformEnergyHistoryConfig {
  enabled?: boolean;
  retentionDays?: number;
  sampleIntervalMinutes?: number;
}

export interface TuyaPlatformServiceInformationConfig {
  device_id: string;
  index: number;
  manifacturer?: string;
  model?: string;
  firmwareRevision?: string;
  configuredName?: string;
}

export interface TuyaPlatformCustomConfigOptions {
  projectType: '1';
  endpoint: string;
  accessId: string;
  accessKey: string;
  username: string;
  password: string;
  deviceOverrides?: Array<TuyaPlatformDeviceConfig>;
  capabilityAutoDetection?: boolean;
  energyHistory?: TuyaPlatformEnergyHistoryConfig;
  serviceInformationOverrides?: Array<TuyaPlatformServiceInformationConfig>;
  generateWeatherAccessory: boolean;
  weatherAPI: string;
  debug?: boolean;
  debugLevel?: string;
  forceIPv4: boolean;
}

export interface TuyaPlatformHomeConfigOptions {
  projectType: '2';
  endpoint?: string;
  accessId: string;
  accessKey: string;
  countryCode: number;
  username: string;
  password: string;
  appSchema: string;
  homeWhitelist?: Array<number>;
  deviceOverrides?: Array<TuyaPlatformDeviceConfig>;
  capabilityAutoDetection?: boolean;
  energyHistory?: TuyaPlatformEnergyHistoryConfig;
  serviceInformationOverrides?: Array<TuyaPlatformServiceInformationConfig>;
  generateWeatherAccessory: boolean;
  weatherAPI: string;
  debug?: boolean;
  debugLevel?: string;
  forceIPv4: boolean;
}

/**
 * Tuya's account-sharing API is the QR flow used by the official Home
 * Assistant integration. The integration owns one public client id; individual
 * users only provide the user code shown by Smart Life or Tuya Smart and scan a
 * QR code in that app.
 */
export interface TuyaPlatformAccountConfigOptions {
  projectType: '3';
  userCode: string;
  appSchema: 'smartlife' | 'tuyaSmart';
  clientId?: string;
  qrSchema?: string;
  endpoint?: string;
  homeWhitelist?: Array<string>;
  deviceOverrides?: Array<TuyaPlatformDeviceConfig>;
  capabilityAutoDetection?: boolean;
  energyHistory?: TuyaPlatformEnergyHistoryConfig;
  serviceInformationOverrides?: Array<TuyaPlatformServiceInformationConfig>;
  generateWeatherAccessory: boolean;
  weatherAPI: string;
  debug?: boolean;
  debugLevel?: string;
  forceIPv4: boolean;
  developerCloudFallback?: TuyaDeveloperCloudFallbackConfig;
}

export interface TuyaDeveloperCloudFallbackConfig {
  enabled?: boolean;
  endpoint?: string;
  accessId: string;
  accessKey: string;
  /** Retained for configurations created before direct project-token support. */
  countryCode?: number;
  /** @deprecated Project-token authentication does not use app credentials. */
  username?: string;
  /** @deprecated Project-token authentication does not use app credentials. */
  password?: string;
  /** @deprecated Project-token authentication does not use app credentials. */
  appSchema?: string;
}

export interface RTSPCameraConfig {
  deviceId: string;
  deviceName?: string;
  rtspUrl: string;
  username?: string;
  password?: string;
}

export type TuyaPlatformConfigOptions = TuyaPlatformCustomConfigOptions
  | TuyaPlatformHomeConfigOptions
  | TuyaPlatformAccountConfigOptions;

export interface TuyaPlatformConfig extends PlatformConfig {
  options: TuyaPlatformConfigOptions;
  cameras?: Array<RTSPCameraConfig>;
}

export const customOptionsSchema = {
  properties: {
    endpoint: { type: 'string', format: 'url', required: true },
    accessId: { type: 'string', required: true },
    accessKey: { type: 'string', required: true },
    deviceOverrides: { 'type': 'array' },
    debug: { type: 'boolean' },
    debugLevel: { 'type': 'string' },
  },
};

export const homeOptionsSchema = {
  properties: {
    accessId: { type: 'string', required: true },
    accessKey: { type: 'string', required: true },
    endpoint: { type: 'string', format: 'url' },
    countryCode: { 'type': 'integer', 'minimum': 1, required: true },
    username: { type: 'string', required: true },
    password: { type: 'string', required: true },
    appSchema: { 'type': 'string', required: true },
    homeWhitelist: { 'type': 'array' },
    deviceOverrides: { 'type': 'array' },
    debug: { type: 'boolean' },
    debugLevel: { 'type': 'string' },
  },
};

export const accountOptionsSchema = {
  properties: {
    userCode: { type: 'string', minLength: 1, required: true },
    appSchema: { type: 'string', enum: ['smartlife', 'tuyaSmart'], required: true },
    clientId: { type: 'string' },
    qrSchema: { type: 'string' },
    endpoint: { type: 'string', format: 'url' },
    homeWhitelist: { type: 'array', items: { type: 'string' } },
    developerCloudFallback: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        endpoint: { type: 'string', format: 'url' },
        accessId: { type: 'string' },
        accessKey: { type: 'string' },
        countryCode: { type: 'integer', minimum: 1 },
      },
    },
    deviceOverrides: { type: 'array' },
    debug: { type: 'boolean' },
    debugLevel: { type: 'string' },
  },
};
