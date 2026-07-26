import mqtt, { MqttClient } from 'mqtt';
import { v4 as uuidv4 } from 'uuid';

import { TuyaMessageBus, TuyaMessageCallback } from './TuyaCloudAPI';
import TuyaSharingAPI from './TuyaSharingAPI';

export type SharingSubscriptionDevice = {
  id: string;
  supportLocal: boolean;
};

type SharingMQConfig = {
  url: string;
  clientId: string;
  username: string;
  password: string;
  expireTime: number;
  topic: {
    ownerId: { sub: string };
    devId: { sub: string };
  };
};

export default class TuyaSharingMQ implements TuyaMessageBus {
  private client?: MqttClient;
  private reconnectTimer?: NodeJS.Timeout;
  private renewalTimer?: NodeJS.Timeout;
  private stopped = true;
  private reconnectDelay = 1_000;
  private readonly listeners = new Set<TuyaMessageCallback>();

  constructor(
    private readonly api: TuyaSharingAPI,
    public ownerIds: string[] = [],
    public devices: SharingSubscriptionDevice[] = [],
  ) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
    }
    this.reconnectTimer = undefined;
    this.renewalTimer = undefined;
    if (this.client) {
      this.client.removeAllListeners();
      this.client.end(true);
      this.client = undefined;
    }
  }

  addMessageListener(listener: TuyaMessageCallback): void {
    this.listeners.add(listener);
  }

  removeMessageListener(listener: TuyaMessageCallback): void {
    this.listeners.delete(listener);
  }

  updateSubscriptions(ownerIds: string[], devices: SharingSubscriptionDevice[]): void {
    this.ownerIds = ownerIds;
    this.devices = devices;
  }

  private async connect(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      const response = await this.api.post('/v1.0/m/life/ha/access/config', {
        linkId: `homebridge-tuya-account.${uuidv4()}`,
      });
      if (!response.success) {
        throw new Error(`MQTT configuration failed (${response.code}): ${response.msg}`);
      }
      const config = response.result as SharingMQConfig;
      this.openClient(config);
      this.reconnectDelay = 1_000;
    } catch {
      this.scheduleReconnect();
    }
  }

  private openClient(config: SharingMQConfig): void {
    if (this.client) {
      this.client.removeAllListeners();
      this.client.end(true);
    }
    const url = normalizeMqttUrl(config.url);
    const client = mqtt.connect(url, {
      clientId: config.clientId,
      username: config.username,
      password: config.password,
      reconnectPeriod: 0,
      connectTimeout: 15_000,
    });
    this.client = client;

    client.on('connect', () => {
      for (const ownerId of this.ownerIds) {
        client.subscribe(config.topic.ownerId.sub.replace('{ownerId}', ownerId));
      }
      const topics = Object.fromEntries(this.devices.map(device => [
        `${config.topic.devId.sub.replace('{devId}', device.id)}/${device.supportLocal ? 'pen' : 'sta'}`,
        { qos: 0 as const },
      ]));
      if (Object.keys(topics).length > 0) {
        client.subscribe(topics);
      }
    });
    client.on('message', (topic, payload) => {
      try {
        const message = JSON.parse(payload.toString('utf8'));
        for (const listener of this.listeners) {
          listener(topic, Number(message.protocol ?? 0), message.data ?? {});
        }
      } catch {
        // Ignore one malformed report and leave the stream alive.
      }
    });
    client.on('error', () => {
      client.end(true);
    });
    client.on('close', () => {
      if (!this.stopped && this.client === client) {
        this.scheduleReconnect();
      }
    });

    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
    }
    this.renewalTimer = setTimeout(() => {
      if (!this.stopped) {
        void this.connect();
      }
    }, Math.max(30, config.expireTime - 60) * 1000);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
  }
}

function normalizeMqttUrl(value: string): string {
  if (value.startsWith('ssl://')) {
    return `mqtts://${value.slice('ssl://'.length)}`;
  }
  if (value.startsWith('tcp://')) {
    return `mqtt://${value.slice('tcp://'.length)}`;
  }
  return value;
}
