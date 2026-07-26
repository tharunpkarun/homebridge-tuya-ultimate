import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';

const DEFAULT_LOGIN_ENDPOINT = 'https://apigw.iotbing.com';
const DEFAULT_CLIENT_ID = 'HA_3y9q4ak7g4ephrvke';
const DEFAULT_SCHEMA = 'haauthorize';

function credentialFilename(userCode: string): string {
  const id = createHash('sha256').update(userCode).digest('hex').slice(0, 16);
  return `TuyaSharing.${id}.json`;
}

export function sharingCredentialFile(storagePath: string, userCode: string): string {
  return path.join(storagePath, 'persist', credentialFilename(userCode));
}

export function legacySharingCredentialFile(storagePath: string, userCode: string): string {
  return path.join(storagePath, credentialFilename(userCode));
}

export type TuyaSharingCredentials = {
  client_id: string;
  user_code: string;
  app_schema: 'smartlife' | 'tuyaSmart';
  terminal_id: string;
  endpoint: string;
  username?: string;
  token_info: {
    t: number;
    uid: string;
    expire_time: number;
    access_token: string;
    refresh_token: string;
  };
};

type TuyaQrResponse = {
  success: boolean;
  code?: string;
  msg?: string;
  t?: number;
  result?: Record<string, unknown>;
};

export type TuyaQrCode = {
  token: string;
  /** Accepted by the QR scanner in both Smart Life and Tuya Smart. */
  content: string;
};

export class TuyaSharingLogin {
  constructor(
    private readonly clientId = DEFAULT_CLIENT_ID,
    private readonly loginEndpoint = DEFAULT_LOGIN_ENDPOINT,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly qrSchema = DEFAULT_SCHEMA,
  ) {}

  async createQrCode(userCode: string): Promise<TuyaQrCode> {
    const query = new URLSearchParams({
      clientid: this.clientId,
      usercode: userCode,
      schema: this.qrSchema,
    });
    const response = await this.request(`/v1.0/m/life/home-assistant/qrcode/tokens?${query}`, 'POST');
    const token = response.result?.qrcode;
    if (!response.success || typeof token !== 'string' || token.length === 0) {
      throw new Error(`Tuya QR creation failed (${response.code ?? 'unknown'}): ${response.msg ?? 'unknown error'}`);
    }

    return {
      token,
      content: `tuyaSmart--qrLogin?token=${token}`,
    };
  }

  async loginResult(
    qrToken: string,
    userCode: string,
    appSchema: 'smartlife' | 'tuyaSmart',
  ): Promise<TuyaSharingCredentials | null> {
    const query = new URLSearchParams({ clientid: this.clientId, usercode: userCode });
    const response = await this.request(
      `/v1.0/m/life/home-assistant/qrcode/tokens/${encodeURIComponent(qrToken)}?${query}`,
      'GET',
    );
    if (!response.success) {
      const pending = `${response.code ?? ''} ${response.msg ?? ''}`.toLowerCase();
      if (pending.includes('scan') || pending.includes('pending') || pending.includes('confirm')) {
        return null;
      }
      throw new Error(`Tuya QR login failed (${response.code ?? 'unknown'}): ${response.msg ?? 'unknown error'}`);
    }

    const result = response.result ?? {};
    const required = ['uid', 'access_token', 'refresh_token', 'expire_time', 'terminal_id', 'endpoint'];
    for (const key of required) {
      if (result[key] === undefined || result[key] === null || result[key] === '') {
        throw new Error(`Tuya QR login response is missing ${key}`);
      }
    }

    return {
      client_id: this.clientId,
      user_code: userCode,
      app_schema: appSchema,
      terminal_id: String(result.terminal_id),
      endpoint: String(result.endpoint),
      username: typeof result.username === 'string' ? result.username : undefined,
      token_info: {
        t: Number(response.t ?? Date.now()),
        uid: String(result.uid),
        expire_time: Number(result.expire_time),
        access_token: String(result.access_token),
        refresh_token: String(result.refresh_token),
      },
    };
  }

  private async request(pathAndQuery: string, method: 'GET' | 'POST'): Promise<TuyaQrResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetchImpl(`${this.loginEndpoint}${pathAndQuery}`, {
        method,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Tuya QR service returned HTTP ${response.status}`);
      }
      return await response.json() as TuyaQrResponse;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class TuyaSharingCredentialStore {
  constructor(public readonly file: string) {}

  async load(): Promise<TuyaSharingCredentials | null> {
    try {
      return JSON.parse(await fs.promises.readFile(this.file, 'utf8')) as TuyaSharingCredentials;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async save(credentials: TuyaSharingCredentials): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporary, JSON.stringify(credentials, null, 2), { mode: 0o600 });
      await fs.promises.chmod(temporary, 0o600);
      await fs.promises.rename(temporary, this.file);
    } catch (error) {
      await fs.promises.rm(temporary, { force: true });
      throw error;
    }
  }
}

export { DEFAULT_CLIENT_ID, DEFAULT_LOGIN_ENDPOINT, DEFAULT_SCHEMA };
