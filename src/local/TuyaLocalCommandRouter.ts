import { TuyaPlatformLocalControlConfig } from '../config';
import TuyaDevice, { TuyaDeviceStatus } from '../device/TuyaDevice';
import TuyaLanProtocol33Client from './TuyaLanProtocol33';
import { CommandAttemptDiagnostic, CommandAttemptRoute, CommandRoute } from '../diagnostics/RuntimeDiagnosticsStore';

export interface TuyaLocalClient {
  send(device: { id: string; ip: string; localKey: string; timeoutMs?: number }, dps: Record<string, unknown>): Promise<void>;
}

type LocalConfigResolver = (device: TuyaDevice) => TuyaPlatformLocalControlConfig | undefined;
type WarningLogger = (message: string, ...args: unknown[]) => void;
type AttemptObserver = (attempt: CommandAttemptDiagnostic) => void;

export default class TuyaLocalCommandRouter {
  constructor(
    private readonly resolveConfig: LocalConfigResolver,
    private readonly warn: WarningLogger,
    private readonly client: TuyaLocalClient = new TuyaLanProtocol33Client(),
  ) {}

  async send(
    device: TuyaDevice,
    commands: TuyaDeviceStatus[],
    sendCloud: () => Promise<unknown>,
    observe?: AttemptObserver,
  ): Promise<unknown> {
    const config = this.resolveConfig(device);
    if (!config || config.mode === 'cloud' || !['hybrid', 'local'].includes(config.mode)) {
      return this.attempt('cloud', 'cloud', sendCloud, observe);
    }

    try {
      await this.attempt(config.mode, 'local', async () => {
        const dps = this.mapCommands(config, commands);
        await this.client.send({
          id: device.id,
          ip: config.ip || device.ip,
          localKey: config.localKey,
          timeoutMs: config.timeoutMs,
        }, dps);
      }, observe);
      return true;
    } catch (error) {
      if (config.mode === 'local') {
        throw error;
      }
      this.warn('Local command failed for %s; falling back to Tuya Cloud: %s', device.name, String(error));
      return this.attempt('hybrid', 'cloud', sendCloud, observe);
    }
  }

  private async attempt(
    requestedRoute: CommandRoute,
    attemptedRoute: CommandAttemptRoute,
    operation: () => Promise<unknown>,
    observe?: AttemptObserver,
  ) {
    const startedAt = Date.now();
    try {
      const result = await operation();
      if (attemptedRoute === 'cloud' && result === false) {
        observe?.({
          requestedRoute,
          attemptedRoute,
          outcome: 'failure',
          durationMs: Date.now() - startedAt,
          error: new Error('Tuya Cloud rejected the command.'),
        });
        return result;
      }
      observe?.({
        requestedRoute,
        attemptedRoute,
        outcome: 'success',
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      observe?.({
        requestedRoute,
        attemptedRoute,
        outcome: 'failure',
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  }

  private mapCommands(config: TuyaPlatformLocalControlConfig, commands: TuyaDeviceStatus[]) {
    if ((config.protocolVersion ?? '3.3') !== '3.3') {
      throw new Error(`Unsupported Tuya LAN protocol version: ${config.protocolVersion}`);
    }
    const mappings = new Map((config.dpMap ?? []).map(item => [item.code.toLowerCase(), item.dpId]));
    const dps: Record<string, unknown> = {};
    for (const command of commands) {
      const dpId = mappings.get(command.code.toLowerCase());
      if (!Number.isInteger(dpId) || Number(dpId) <= 0) {
        throw new Error(`No local DP mapping configured for ${command.code}.`);
      }
      dps[String(dpId)] = command.value;
    }
    return dps;
  }
}
