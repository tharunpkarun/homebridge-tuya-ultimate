export type TuyaCloudResponseSuccess = {
  success: true;
  // Tuya responses vary by endpoint.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
  t: number;
  tid: string;
};

export type TuyaCloudResponseError = {
  success: false;
  result: unknown;
  code: number;
  msg: string;
  t: number;
  tid: string;
};

export type TuyaCloudResponse = TuyaCloudResponseSuccess | TuyaCloudResponseError;

export type TuyaCloudTokenInfo = {
  access_token: string;
  refresh_token: string;
  uid: string;
  /** Absolute expiry time in milliseconds since the Unix epoch. */
  expire: number;
};

/** The common surface consumed by the existing official device mappings. */
export interface TuyaCloudAPI {
  tokenInfo: TuyaCloudTokenInfo;
  get(path: string, params?: Record<string, unknown>): Promise<TuyaCloudResponse>;
  post(path: string, body?: Record<string, unknown>): Promise<TuyaCloudResponse>;
}

export type TuyaMessageCallback = (topic: string, protocol: number, data: unknown) => void;

export interface TuyaMessageBus {
  version?: string;
  /** Legacy hooks kept optional for TuyaOpenMQ API compatibility. */
  _onConnect?: () => void;
  _onError?: (error: Error) => void;
  start(): void;
  stop(): void;
  addMessageListener(listener: TuyaMessageCallback): void;
  removeMessageListener(listener: TuyaMessageCallback): void;
}
