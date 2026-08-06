import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type CommandRoute = 'cloud' | 'local' | 'hybrid';
export type CommandAttemptRoute = 'cloud' | 'local';
export type CommandOutcome = 'success' | 'failure';

export type CommandAttemptDiagnostic = {
  requestedRoute: CommandRoute;
  attemptedRoute: CommandAttemptRoute;
  outcome: CommandOutcome;
  durationMs: number;
  error?: unknown;
};

type StoredCommandDiagnostic = {
  timestamp: number;
  deviceRef: string;
  codes: string[];
  requestedRoute: CommandRoute;
  attemptedRoute: CommandAttemptRoute;
  outcome: CommandOutcome;
  durationMs: number;
  errorKind?: 'configuration' | 'connection' | 'rejected' | 'timeout' | 'unknown';
};

export type RuntimeDiagnosticsFile = {
  version: 1;
  mqtt: {
    messageCount: number;
    lastMessageAt?: number;
    lastProtocol?: number;
    lastDeviceRef?: string;
    protocols: Record<string, number>;
  };
  commands: StoredCommandDiagnostic[];
};

const MAX_COMMANDS = 100;
const MAX_CODES = 16;
const CODE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/;

function blankDiagnostics(): RuntimeDiagnosticsFile {
  return {
    version: 1,
    mqtt: { messageCount: 0, protocols: {} },
    commands: [],
  };
}

function deviceReference(deviceId: string) {
  return crypto.createHash('sha256').update(deviceId).digest('hex').slice(0, 16);
}

function errorKind(error: unknown): StoredCommandDiagnostic['errorKind'] {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/timed?\s*out|timeout/i.test(message)) {
    return 'timeout';
  }
  if (/mapping|protocol version|local key|ip address|config/i.test(message)) {
    return 'configuration';
  }
  if (/reject|denied|forbidden|unauthor/i.test(message)) {
    return 'rejected';
  }
  if (/connect|network|socket|econn|host|unreach/i.test(message)) {
    return 'connection';
  }
  return 'unknown';
}

/**
 * Persists bounded operational metadata without command values, raw device
 * identifiers, topics, endpoints, payloads, or exception messages.
 */
export default class RuntimeDiagnosticsStore {
  private data = blankDiagnostics();
  private writeTimer?: NodeJS.Timeout;
  private writePromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  recordMqtt(protocol: number, deviceId?: string) {
    const safeProtocol = Number.isInteger(protocol) && protocol >= 0 ? protocol : 0;
    const key = String(safeProtocol);
    this.data.mqtt.messageCount = Math.min(Number.MAX_SAFE_INTEGER, this.data.mqtt.messageCount + 1);
    this.data.mqtt.lastMessageAt = this.now();
    this.data.mqtt.lastProtocol = safeProtocol;
    this.data.mqtt.protocols[key] = Math.min(
      Number.MAX_SAFE_INTEGER,
      (this.data.mqtt.protocols[key] ?? 0) + 1,
    );
    if (deviceId) {
      this.data.mqtt.lastDeviceRef = deviceReference(deviceId);
    }
    this.scheduleWrite();
  }

  recordCommand(deviceId: string, codes: string[], attempt: CommandAttemptDiagnostic) {
    const safeCodes = [...new Set(codes)]
      .filter(code => CODE_PATTERN.test(code))
      .slice(0, MAX_CODES);
    const entry: StoredCommandDiagnostic = {
      timestamp: this.now(),
      deviceRef: deviceReference(deviceId),
      codes: safeCodes,
      requestedRoute: attempt.requestedRoute,
      attemptedRoute: attempt.attemptedRoute,
      outcome: attempt.outcome,
      durationMs: Math.max(0, Math.min(Math.round(attempt.durationMs), 300_000)),
    };
    if (attempt.outcome === 'failure') {
      entry.errorKind = errorKind(attempt.error);
    }
    this.data.commands.push(entry);
    this.data.commands = this.data.commands.slice(-MAX_COMMANDS);
    this.scheduleWrite();
  }

  snapshot(): RuntimeDiagnosticsFile {
    return JSON.parse(JSON.stringify(this.data)) as RuntimeDiagnosticsFile;
  }

  async flush() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    await this.enqueueWrite();
  }

  private load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<RuntimeDiagnosticsFile>;
      if (parsed.version !== 1 || !parsed.mqtt || !Array.isArray(parsed.commands)) {
        return;
      }
      const mqtt = parsed.mqtt;
      const protocols = Object.fromEntries(Object.entries(mqtt.protocols ?? {})
        .filter(([protocol, count]) => /^\d{1,5}$/.test(protocol)
          && typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
        .slice(0, 32));
      this.data.mqtt = {
        messageCount: typeof mqtt.messageCount === 'number' && Number.isSafeInteger(mqtt.messageCount)
          ? Math.max(0, mqtt.messageCount)
          : 0,
        protocols,
      };
      if (typeof mqtt.lastMessageAt === 'number' && Number.isFinite(mqtt.lastMessageAt)) {
        this.data.mqtt.lastMessageAt = mqtt.lastMessageAt;
      }
      if (typeof mqtt.lastProtocol === 'number' && Number.isInteger(mqtt.lastProtocol)) {
        this.data.mqtt.lastProtocol = mqtt.lastProtocol;
      }
      if (typeof mqtt.lastDeviceRef === 'string' && /^[a-f0-9]{16}$/.test(mqtt.lastDeviceRef)) {
        this.data.mqtt.lastDeviceRef = mqtt.lastDeviceRef;
      }
      // Command history is intentionally session-local on reload. This avoids
      // trusting arbitrary strings from a manually modified diagnostics file.
      this.data.commands = [];
    } catch {
      this.data = blankDiagnostics();
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
