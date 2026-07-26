import Crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

import { TuyaCloudAPI, TuyaCloudResponse, TuyaCloudTokenInfo } from './TuyaCloudAPI';
import { TuyaSharingCredentials } from './TuyaSharingAuth';

const NONCE_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

type SharingTokenUpdate = TuyaSharingCredentials['token_info'];

type TuyaSharingAPIOptions = {
  credentials: TuyaSharingCredentials;
  onTokenUpdate?: (token: SharingTokenUpdate) => void | Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
  requestId?: () => string;
  nonce?: () => string;
};

/**
 * Node port of Tuya's MIT-licensed tuya-device-sharing-sdk CustomerApi.
 * It intentionally exposes the same get/post shape as TuyaOpenAPI so the
 * official Homebridge accessory mappings can be reused unchanged.
 */
export default class TuyaSharingAPI implements TuyaCloudAPI {
  public tokenInfo: TuyaCloudTokenInfo;
  public readonly endpoint: string;

  private tokenIssuedAt: number;
  private tokenExpiresInSeconds: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly requestId: () => string;
  private readonly nonce: () => string;
  private refreshPromise?: Promise<void>;

  constructor(private readonly options: TuyaSharingAPIOptions) {
    const token = options.credentials.token_info;
    this.endpoint = options.credentials.endpoint.replace(/\/$/, '');
    this.tokenIssuedAt = token.t;
    this.tokenExpiresInSeconds = token.expire_time;
    this.tokenInfo = {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      uid: token.uid,
      expire: token.t + token.expire_time * 1000,
    };
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.requestId = options.requestId ?? uuidv4;
    this.nonce = options.nonce ?? (() => randomNonce(12));
  }

  async get(path: string, params?: Record<string, unknown>): Promise<TuyaCloudResponse> {
    return this.request('GET', path, params);
  }

  async post(path: string, body?: Record<string, unknown>): Promise<TuyaCloudResponse> {
    return this.request('POST', path, undefined, body);
  }

  async postWithQuery(
    path: string,
    params?: Record<string, unknown>,
    body?: Record<string, unknown>,
  ): Promise<TuyaCloudResponse> {
    return this.request('POST', path, params, body);
  }

  private async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    params?: Record<string, unknown>,
    body?: Record<string, unknown>,
    skipRefresh = false,
  ): Promise<TuyaCloudResponse> {
    if (!skipRefresh) {
      await this.refreshAccessTokenIfNeeded();
    }

    const requestId = this.requestId();
    const hashKey = Crypto.createHash('md5')
      .update(requestId + this.tokenInfo.refresh_token)
      .digest('hex');
    const secret = generateSecret(requestId, hashKey);

    let queryEncdata = '';
    if (params && Object.keys(params).length > 0) {
      queryEncdata = encryptRequestPayload(JSON.stringify(params), secret, this.nonce());
    }
    let bodyEncdata = '';
    if (body && Object.keys(body).length > 0) {
      bodyEncdata = encryptRequestPayload(JSON.stringify(body), secret, this.nonce());
    }

    const timestamp = this.now();
    const signedHeaders: Record<string, string> = {
      'X-appKey': this.options.credentials.client_id,
      'X-requestId': requestId,
      'X-sid': '',
      'X-time': String(timestamp),
      'X-token': this.tokenInfo.access_token,
    };
    const sign = signRequest(hashKey, signedHeaders, queryEncdata, bodyEncdata);
    const headers = {
      ...signedHeaders,
      'X-sign': sign,
      'content-type': 'application/json',
    };

    const query = queryEncdata ? `?${new URLSearchParams({ encdata: queryEncdata })}` : '';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetchImpl(`${this.endpoint}${path}${query}`, {
        method,
        headers,
        body: bodyEncdata ? JSON.stringify({ encdata: bodyEncdata }) : undefined,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Tuya account API returned HTTP ${response.status}`);
      }

      const result = await response.json() as TuyaCloudResponse;
      if (result.success && typeof result.result === 'string' && result.result.length > 0) {
        const decoded = decryptResponsePayload(result.result, secret);
        try {
          result.result = JSON.parse(decoded);
        } catch {
          result.result = decoded;
        }
      }
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async refreshAccessTokenIfNeeded(): Promise<void> {
    if (this.tokenInfo.expire - 60_000 > this.now()) {
      return;
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshAccessToken().finally(() => {
        this.refreshPromise = undefined;
      });
    }
    await this.refreshPromise;
  }

  private async refreshAccessToken(): Promise<void> {
    const response = await this.request(
      'GET',
      `/v1.0/m/token/${encodeURIComponent(this.tokenInfo.refresh_token)}`,
      undefined,
      undefined,
      true,
    );
    if (!response.success) {
      throw new Error(`Tuya token refresh failed (${response.code}): ${response.msg}`);
    }

    const result = response.result as Record<string, unknown>;
    const issuedAt = Number(response.t ?? this.now());
    const expiresIn = Number(result.expireTime);
    const token: SharingTokenUpdate = {
      t: issuedAt,
      uid: String(result.uid),
      expire_time: expiresIn,
      access_token: String(result.accessToken),
      refresh_token: String(result.refreshToken),
    };
    this.tokenIssuedAt = issuedAt;
    this.tokenExpiresInSeconds = expiresIn;
    this.tokenInfo = {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      uid: token.uid,
      expire: issuedAt + expiresIn * 1000,
    };
    await this.options.onTokenUpdate?.(token);
  }

  getPersistedToken(): SharingTokenUpdate {
    return {
      t: this.tokenIssuedAt,
      uid: this.tokenInfo.uid,
      expire_time: this.tokenExpiresInSeconds,
      access_token: this.tokenInfo.access_token,
      refresh_token: this.tokenInfo.refresh_token,
    };
  }
}

function randomNonce(length: number): string {
  let value = '';
  for (let index = 0; index < length; index++) {
    value += NONCE_ALPHABET[Crypto.randomInt(NONCE_ALPHABET.length)];
  }
  return value;
}

function generateSecret(requestId: string, hashKey: string): string {
  return Crypto.createHmac('sha256', requestId).update(hashKey).digest('hex').slice(0, 16);
}

function encryptRequestPayload(raw: string, secret: string, nonce: string): string {
  const cipher = Crypto.createCipheriv('aes-128-gcm', Buffer.from(secret, 'utf8'), Buffer.from(nonce, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  // The customer API expects two concatenated base64 strings for requests.
  return Buffer.from(nonce, 'utf8').toString('base64') + ciphertext.toString('base64');
}

function decryptResponsePayload(encoded: string, secret: string): string {
  const payload = Buffer.from(encoded, 'base64');
  const nonce = payload.subarray(0, 12);
  const ciphertext = payload.subarray(12, -16);
  const tag = payload.subarray(-16);
  const decipher = Crypto.createDecipheriv('aes-128-gcm', Buffer.from(secret, 'utf8'), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function signRequest(
  hashKey: string,
  headers: Record<string, string>,
  queryEncdata: string,
  bodyEncdata: string,
): string {
  const names = ['X-appKey', 'X-requestId', 'X-sid', 'X-time', 'X-token'];
  const headerText = names
    .filter(name => headers[name] !== '')
    .map(name => `${name}=${headers[name]}`)
    .join('||');
  return Crypto.createHmac('sha256', hashKey)
    .update(headerText + queryEncdata + bodyEncdata)
    .digest('hex');
}

export const sharingCrypto = {
  decryptResponsePayload,
  encryptRequestPayload,
  generateSecret,
  signRequest,
};
