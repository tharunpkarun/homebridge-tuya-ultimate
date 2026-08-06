import fs from 'fs';
import path from 'path';

import TuyaDevice, { TuyaDeviceSchemaIntegerProperty, TuyaDeviceStatus } from '../device/TuyaDevice';

export type EnergyMetric = {
  raw: number;
  value: number;
  scale: number;
  unit: string;
};

export type EnergySample = {
  timestamp: number;
  metrics: Record<string, EnergyMetric>;
};

type StoredDeviceHistory = {
  name: string;
  category: string;
  samples: EnergySample[];
};

type EnergyHistoryFile = {
  version: 1;
  devices: Record<string, StoredDeviceHistory>;
};

export type EnergyHistoryOptions = {
  enabled?: boolean;
  retentionDays?: number;
  sampleIntervalMinutes?: number;
};

const ENERGY_CODE = new RegExp(
  '^(?:cur_(?:current|power|voltage)|add_ele|forward_energy_total|reverse_energy_total'
  + '|phase_[abc]_(?:current|power|voltage))$',
  'i',
);
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_SAMPLE_INTERVAL_MINUTES = 5;
const MAX_HISTORY_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TRACKED_DEVICES = 512;
const MAX_TOTAL_SAMPLES = 100_000;

export default class EnergyHistoryStore {
  private data: EnergyHistoryFile = { version: 1, devices: {} };
  private writeTimer?: NodeJS.Timeout;
  private writePromise: Promise<void> = Promise.resolve();
  private readonly retentionMs: number;
  private readonly sampleIntervalMs: number;

  constructor(
    private readonly file: string,
    options: EnergyHistoryOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    this.retentionMs = Math.min(365, Math.max(1, options.retentionDays ?? DEFAULT_RETENTION_DAYS))
      * 24 * 60 * 60 * 1000;
    this.sampleIntervalMs = Math.min(1440, Math.max(1, options.sampleIntervalMinutes ?? DEFAULT_SAMPLE_INTERVAL_MINUTES))
      * 60 * 1000;
    this.load();
  }

  record(device: TuyaDevice, statuses: TuyaDeviceStatus[] = device.status): boolean {
    const metrics = this.extractMetrics(device, statuses);
    if (Object.keys(metrics).length === 0) {
      return false;
    }

    const timestamp = this.now();
    const history = this.data.devices[device.id] ?? {
      name: device.name,
      category: device.category,
      samples: [],
    };
    history.name = device.name;
    history.category = device.category;

    const last = history.samples.at(-1);
    if (last && timestamp - last.timestamp < this.sampleIntervalMs) {
      last.metrics = { ...last.metrics, ...metrics };
    } else {
      history.samples.push({ timestamp, metrics });
    }
    this.data.devices[device.id] = history;
    this.prune(timestamp);
    this.scheduleWrite();
    return true;
  }

  snapshot(): EnergyHistoryFile {
    return JSON.parse(JSON.stringify(this.data)) as EnergyHistoryFile;
  }

  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    await this.enqueueWrite();
  }

  private extractMetrics(device: TuyaDevice, statuses: TuyaDeviceStatus[]) {
    const metrics: Record<string, EnergyMetric> = {};
    for (const status of statuses) {
      if (!ENERGY_CODE.test(status.code) || typeof status.value !== 'number' || !Number.isFinite(status.value)) {
        continue;
      }
      const schema = device.schema.find(item => item.code.toLowerCase() === status.code.toLowerCase());
      const property = schema?.property as Partial<TuyaDeviceSchemaIntegerProperty> | undefined;
      const scale = Number.isInteger(property?.scale) ? Number(property?.scale) : 0;
      const divisor = Math.pow(10, scale);
      metrics[status.code] = {
        raw: status.value,
        value: status.value / divisor,
        scale,
        unit: typeof property?.unit === 'string' ? property.unit : '',
      };
    }
    return metrics;
  }

  private load() {
    try {
      if (fs.statSync(this.file).size > MAX_HISTORY_FILE_BYTES) {
        return;
      }
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<EnergyHistoryFile>;
      if (parsed.version === 1 && parsed.devices && typeof parsed.devices === 'object') {
        const devices: EnergyHistoryFile['devices'] = {};
        let sampleBudget = MAX_TOTAL_SAMPLES;
        for (const [deviceId, rawHistory] of Object.entries(parsed.devices).slice(0, MAX_TRACKED_DEVICES)) {
          if (!deviceId || deviceId.length > 256 || !rawHistory || typeof rawHistory !== 'object'
            || !Array.isArray(rawHistory.samples)) {
            continue;
          }
          const samples = rawHistory.samples
            .slice(-sampleBudget)
            .flatMap(sample => this.sanitizeSample(sample));
          sampleBudget -= samples.length;
          if (samples.length === 0) {
            continue;
          }
          devices[deviceId] = {
            name: typeof rawHistory.name === 'string' ? rawHistory.name.slice(0, 256) : '',
            category: typeof rawHistory.category === 'string' ? rawHistory.category.slice(0, 96) : '',
            samples: samples.sort((left, right) => left.timestamp - right.timestamp),
          };
          if (sampleBudget === 0) {
            break;
          }
        }
        this.data = { version: 1, devices };
        this.prune(this.now());
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A malformed history file is ignored; the next atomic write repairs it.
        this.data = { version: 1, devices: {} };
      }
    }
  }

  private sanitizeSample(sample: unknown): EnergySample[] {
    if (!sample || typeof sample !== 'object') {
      return [];
    }
    const candidate = sample as Partial<EnergySample>;
    if (typeof candidate.timestamp !== 'number' || !Number.isSafeInteger(candidate.timestamp)
      || candidate.timestamp < 0 || !candidate.metrics || typeof candidate.metrics !== 'object') {
      return [];
    }
    const metrics: Record<string, EnergyMetric> = {};
    for (const [code, rawMetric] of Object.entries(candidate.metrics)) {
      if (!ENERGY_CODE.test(code) || !rawMetric || typeof rawMetric !== 'object') {
        continue;
      }
      const metric = rawMetric as Partial<EnergyMetric>;
      const scale = metric.scale;
      if (typeof metric.raw !== 'number' || !Number.isFinite(metric.raw)
        || typeof metric.value !== 'number' || !Number.isFinite(metric.value)
        || typeof scale !== 'number' || !Number.isInteger(scale) || scale < -12 || scale > 12
        || typeof metric.unit !== 'string' || metric.unit.length > 24) {
        continue;
      }
      metrics[code] = {
        raw: metric.raw,
        value: metric.value,
        scale,
        unit: metric.unit,
      };
    }
    return Object.keys(metrics).length > 0
      ? [{ timestamp: candidate.timestamp, metrics }]
      : [];
  }

  private prune(timestamp: number) {
    for (const [deviceId, history] of Object.entries(this.data.devices)) {
      history.samples = history.samples.filter(sample => timestamp - sample.timestamp <= this.retentionMs);
      if (history.samples.length === 0) {
        delete this.data.devices[deviceId];
      }
    }

    const histories = Object.values(this.data.devices);
    const sampleCount = histories.reduce((total, history) => total + history.samples.length, 0);
    if (sampleCount <= MAX_TOTAL_SAMPLES) {
      return;
    }
    const samples = histories
      .flatMap(history => history.samples)
      .sort((left, right) => right.timestamp - left.timestamp);
    const retained = new Set(samples.slice(0, MAX_TOTAL_SAMPLES));
    for (const [deviceId, history] of Object.entries(this.data.devices)) {
      history.samples = history.samples.filter(sample => retained.has(sample));
      if (history.samples.length === 0) {
        delete this.data.devices[deviceId];
      }
    }
  }

  private scheduleWrite() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      void this.enqueueWrite().catch(() => undefined);
    }, 250);
    this.writeTimer.unref?.();
  }

  private enqueueWrite() {
    this.writePromise = this.writePromise
      .catch(() => undefined)
      .then(() => this.writeAtomic());
    return this.writePromise;
  }

  private async writeAtomic() {
    const directory = path.dirname(this.file);
    await fs.promises.mkdir(directory, { recursive: true });
    const temporary = `${this.file}.${process.pid}.${this.now()}.tmp`;
    try {
      await fs.promises.writeFile(temporary, JSON.stringify(this.data), { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(temporary, this.file);
      await fs.promises.chmod(this.file, 0o600);
    } finally {
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
