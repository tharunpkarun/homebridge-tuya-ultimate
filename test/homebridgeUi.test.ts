import fs from 'node:fs';
import path from 'node:path';

import { JSDOM } from 'jsdom';

type UiEventHandler = (event?: { data?: unknown }) => unknown;

describe('Homebridge custom UI', () => {
  test('renders live account data and supports the primary navigation flows', async () => {
    const listeners = new Map<string, UiEventHandler[]>();
    const showSchemaForm = jest.fn();
    const hideSchemaForm = jest.fn();
    const writeText = jest.fn(async (_text: string) => undefined);
    const updatePluginConfig = jest.fn(async () => undefined);
    const savePluginConfig = jest.fn(async () => undefined);
    const downloadClick = jest.fn();
    const createObjectURL = jest.fn(() => 'blob:support-bundle');
    const revokeObjectURL = jest.fn();
    const toast = {
      error: jest.fn(),
      info: jest.fn(),
      success: jest.fn(),
    };
    const request = jest.fn(async (route: string) => {
      if (route === '/about') {
        return {
          packageName: 'homebridge-tuya-ultimate',
          version: '2.5.1',
          node: '22.0.0',
          homebridge: '^1.8.0 || ^2.0.0',
          repository: 'https://private.example/repository',
          accessToken: 'about-access-token',
        };
      }
      if (route === '/sharing/accounts') {
        return { accounts: [] };
      }
      if (route === '/sharing/status') {
        return { connected: true, matchesConfiguration: true, username: 'Test account' };
      }
      if (route === '/sharing/overview') {
        return {
          connected: true,
          connectionType: 'account-sharing',
          appSchema: 'smartlife',
          username: 'Test account',
          endpoint: 'https://private.example/account',
          credentials: { accessKey: 'overview-access-key' },
          runtimeDiagnostics: {
            version: 1,
            mqtt: {
              messageCount: 12,
              lastMessageAt: 1_700_000_000_000,
              lastProtocol: 4,
              lastDeviceReference: 'runtime-device-001',
              protocols: [{ protocol: 4, count: 10 }, { protocol: 20, count: 2 }],
              endpoint: 'https://private.example/mqtt',
            },
            commands: {
              retainedCount: 2,
              outcomeCounts: { success: 1, failure: 1 },
              requestedRouteCounts: { cloud: 1, local: 0, hybrid: 1 },
              attemptedRouteCounts: { cloud: 1, local: 1 },
              durationMs: { min: 25, max: 75, average: 50 },
              lastCommandAt: 1_700_000_000_020,
              codeCounts: [{ code: 'switch_led', count: 1 }, { code: 'temp_current', count: 1 }],
              recent: [{
                timestamp: 1_700_000_000_010,
                deviceReference: 'runtime-device-001',
                codes: ['switch_led'],
                requestedRoute: 'hybrid',
                attemptedRoute: 'local',
                outcome: 'failure',
                durationMs: 25,
                errorKind: 'connection',
                rawValue: 'runtime-raw-value',
              }],
            },
            sourceHash: 'aaaaaaaaaaaaaaaa',
            localControl: { localKey: 'runtime-local-key' },
          },
          homes: [
            { id: 'home-1', name: 'Main home', selected: true, deviceCount: 2, onlineCount: 1 },
            { id: 'home-2', name: 'Workshop', selected: true, deviceCount: 1, onlineCount: 1 },
          ],
          devices: [
            {
              id: 'device-1',
              name: 'Hall light',
              category: 'dj',
              productId: 'product-1',
              productName: 'Light',
              online: true,
              homeId: 'home-1',
              connection: { status: 'online', transport: 'cloud', topology: 'direct', setup: 'ready' },
              schema: [
                { code: 'switch_led', mode: 'rw', type: 'Boolean', property: {} },
                { code: 'work_mode', mode: 'rw', type: 'Enum', property: { range: ['white', 'colour'] } },
              ],
              status: [
                { code: 'switch_led', displayValue: 'true', redacted: false, value: 'hidden-source-value' },
                { code: 'raw_payload', displayValue: 'Hidden', redacted: true },
              ],
              statusOmittedCount: 1,
              overrideDraft: { id: 'device-1', category: 'dj' },
              localControl: { localKey: 'device-local-key' },
              lat: '12.345678',
              lon: '67.890123',
              url: 'https://private.example/device',
            },
            { id: 'device-2', name: 'Door sensor', category: 'mcs', productName: 'Contact sensor', online: false, subDevice: true, homeId: 'home-1' },
            { id: 'device-3', name: 'Workshop switch', category: 'kg', productName: 'Switch', online: true, homeId: 'home-2' },
          ],
        };
      }
      throw new Error(`Unexpected UI request: ${route}`);
    });

    const html = fs.readFileSync(path.join(__dirname, '..', 'homebridge-ui', 'public', 'index.html'), 'utf8');
    const dom = new JSDOM(html, {
      beforeParse(window) {
        window.HTMLElement.prototype.scrollIntoView = jest.fn();
        window.HTMLAnchorElement.prototype.click = downloadClick;
        Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
        Object.defineProperty(window.URL, 'createObjectURL', { configurable: true, value: createObjectURL });
        Object.defineProperty(window.URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
        Object.defineProperty(window, 'homebridge', {
          configurable: true,
          value: {
            addEventListener(name: string, listener: UiEventHandler) {
              listeners.set(name, [...(listeners.get(name) || []), listener]);
            },
            fixScrollHeight: jest.fn(),
            getPluginConfig: jest.fn(async () => [{
              platform: 'TuyaPlatform',
              name: 'Tuya',
              options: {
                projectType: '3',
                appSchema: 'smartlife',
                userCode: 'user-1',
                generateWeatherAccessory: false,
                weatherAPI: 'open-meteo',
                forceIPv4: false,
                capabilityAutoDetection: true,
                energyHistory: { enabled: true, retentionDays: 45, sampleIntervalMinutes: 10 },
                deviceOverrides: [{
                  id: 'device-1',
                  localControl: { mode: 'hybrid', localKey: 'sixteen-byte-key', dpMap: [] },
                }],
              },
            }]),
            hideSchemaForm,
            request,
            savePluginConfig,
            showSchemaForm,
            toast,
            updatePluginConfig,
          },
        });
      },
      runScripts: 'dangerously',
      url: 'http://127.0.0.1/plugin-config',
    });

    await Promise.all((listeners.get('ready') || []).map(listener => listener()));
    await new Promise(resolve => setTimeout(resolve, 0));

    const document = dom.window.document;
    expect(document.getElementById('tuyaAuthorizationStat')?.textContent).toBe('Connected');
    expect(document.getElementById('tuyaAppStat')?.textContent).toBe('Smart Life');
    expect(document.getElementById('tuyaHomesStat')?.textContent).toBe('2');
    expect(document.getElementById('tuyaDevicesStat')?.textContent).toBe('3');
    expect(document.getElementById('tuyaDashboardMessage')?.textContent).toContain('Connected as Test account');
    expect(document.getElementById('tuyaDashboardHomes')?.textContent).toContain('Main home');
    expect(document.getElementById('tuyaDashboardDevices')?.textContent).toContain('Door sensor');

    const firstInspector = document.querySelector('#tuyaDashboardDevices .tuya-device-details') as HTMLDetailsElement;
    (firstInspector.querySelector('summary') as HTMLElement).click();
    expect(firstInspector.open).toBe(true);
    expect(firstInspector.textContent).toContain('switch_led');
    expect(firstInspector.textContent).toContain('Hidden by safety policy');
    expect(firstInspector.textContent).toContain('Safe deviceOverrides draft');
    expect(firstInspector.textContent).not.toContain('access-token');

    const copyDraft = [...firstInspector.querySelectorAll('button')]
      .find(button => button.textContent === 'Copy draft') as HTMLButtonElement;
    copyDraft.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(writeText).toHaveBeenCalledWith('{\n  "id": "device-1",\n  "category": "dj"\n}');
    expect(toast.success).toHaveBeenCalledWith('Override draft copied for Hall light.', 'Device inspector');
    expect(document.body.textContent).not.toContain('sixteen-byte-key');

    (document.querySelector('[data-tuya-tab="settings"]') as HTMLButtonElement).click();
    expect((document.getElementById('tuyaCapabilityAutoDetection') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('tuyaEnergyHistoryEnabled') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('tuyaEnergyRetentionDays') as HTMLInputElement).value).toBe('45');
    expect((document.getElementById('tuyaEnergySampleMinutes') as HTMLInputElement).value).toBe('10');
    (document.getElementById('tuyaCapabilityAutoDetection') as HTMLInputElement).checked = false;
    (document.getElementById('tuyaEnergyRetentionDays') as HTMLInputElement).value = '60';
    (document.getElementById('tuyaEnergySampleMinutes') as HTMLInputElement).value = '15';
    (document.getElementById('tuyaSaveSettings') as HTMLButtonElement).click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(updatePluginConfig).toHaveBeenLastCalledWith([
      expect.objectContaining({
        options: expect.objectContaining({
          capabilityAutoDetection: false,
          energyHistory: { enabled: true, retentionDays: 60, sampleIntervalMinutes: 15 },
        }),
      }),
    ]);
    expect(savePluginConfig).toHaveBeenCalled();

    (document.querySelector('[data-tuya-tab="advanced"]') as HTMLButtonElement).click();
    const copySupportBundle = document.getElementById('tuyaCopySupportBundle') as HTMLButtonElement;
    const downloadSupportBundle = document.getElementById('tuyaDownloadSupportBundle') as HTMLButtonElement;
    expect(copySupportBundle.disabled).toBe(false);
    expect(downloadSupportBundle.disabled).toBe(false);
    copySupportBundle.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const bundleText = writeText.mock.calls[writeText.mock.calls.length - 1]?.[0] as string;
    const bundle = JSON.parse(bundleText);
    expect(bundle).toMatchObject({
      format: 'homebridge-tuya-support-bundle',
      formatVersion: 1,
      plugin: { packageName: 'homebridge-tuya-ultimate', version: '2.5.1' },
      connection: { type: 'account-sharing', app: 'smartlife', connected: true },
      homes: {
        count: 2,
        selectedCount: 2,
        items: [
          { reference: 'home-001', selected: true, deviceCount: 2, onlineCount: 1 },
          { reference: 'home-002', selected: true, deviceCount: 1, onlineCount: 1 },
        ],
      },
      devices: { count: 3, onlineCount: 2 },
      runtimeDiagnostics: {
        version: 1,
        mqtt: {
          messageCount: 12,
          lastMessageAt: 1_700_000_000_000,
          lastProtocol: 4,
          lastDeviceReference: 'runtime-device-001',
          protocols: [{ protocol: 4, count: 10 }, { protocol: 20, count: 2 }],
        },
        commands: {
          retainedCount: 2,
          outcomeCounts: { success: 1, failure: 1 },
          requestedRouteCounts: { cloud: 1, local: 0, hybrid: 1 },
          attemptedRouteCounts: { cloud: 1, local: 1 },
          durationMs: { min: 25, max: 75, average: 50 },
          lastCommandAt: 1_700_000_000_020,
          codeCounts: [{ code: 'switch_led', count: 1 }, { code: 'temp_current', count: 1 }],
          recent: [expect.objectContaining({
            deviceReference: 'runtime-device-001',
            codes: ['switch_led'],
            outcome: 'failure',
            errorKind: 'connection',
          })],
        },
      },
    });
    expect(bundle.devices.items[0]).toMatchObject({
      reference: 'device-001',
      homeReference: 'home-001',
      category: 'dj',
      status: [
        { code: 'switch_led', visibility: 'safe-scalar-observed' },
        { code: 'raw_payload', visibility: 'redacted' },
      ],
    });
    expect(bundle.devices.items[0].schema[1].constraints).toEqual({});
    for (const excluded of [
      'Test account', 'Main home', 'Workshop', 'Hall light', 'device-1', 'home-1', 'product-1',
      'private.example', 'overview-access-key', 'device-local-key', 'hidden-source-value', '12.345678', '67.890123',
      'about-access-token', 'runtime-raw-value', 'runtime-local-key', 'aaaaaaaaaaaaaaaa',
    ]) {
      expect(bundleText).not.toContain(excluded);
    }
    downloadSupportBundle.click();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(downloadClick).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:support-bundle');

    (document.querySelector('[data-tuya-tab="account"]') as HTMLButtonElement).click();
    expect(document.getElementById('tuyaPanelAccount')?.hidden).toBe(false);
    (document.querySelector('[data-project-type="1"]') as HTMLButtonElement).click();
    expect(document.getElementById('tuyaQrAccount')?.hidden).toBe(true);
    expect(document.getElementById('tuyaDeveloperAccount')?.hidden).toBe(false);
    expect(document.getElementById('tuyaDeveloperTitle')?.textContent).toBe('Custom cloud project');
    expect(copySupportBundle.disabled).toBe(true);
    expect(downloadSupportBundle.disabled).toBe(true);

    (document.querySelector('[data-tuya-tab="advanced"]') as HTMLButtonElement).click();
    (document.getElementById('tuyaToggleSchema') as HTMLButtonElement).click();
    expect(showSchemaForm).toHaveBeenCalledTimes(1);
    expect(document.getElementById('tuyaToggleSchema')?.textContent).toBe('Close full schema editor');

    const theme = document.getElementById('tuyaTheme') as HTMLSelectElement;
    theme.value = 'dark';
    theme.dispatchEvent(new dom.window.Event('change'));
    expect(document.getElementById('tuyaApp')?.dataset.theme).toBe('dark');
    expect(dom.window.localStorage.getItem('tuya-ultimate-theme')).toBe('dark');

    dom.window.close();
  });

  test('prevents a visual home selection from excluding every home', async () => {
    const listeners = new Map<string, UiEventHandler[]>();
    const info = jest.fn();
    const html = fs.readFileSync(path.join(__dirname, '..', 'homebridge-ui', 'public', 'index.html'), 'utf8');
    const dom = new JSDOM(html, {
      beforeParse(window) {
        window.HTMLElement.prototype.scrollIntoView = jest.fn();
        Object.defineProperty(window, 'homebridge', {
          configurable: true,
          value: {
            addEventListener(name: string, listener: UiEventHandler) {
              listeners.set(name, [...(listeners.get(name) || []), listener]);
            },
            fixScrollHeight: jest.fn(),
            getPluginConfig: jest.fn(async () => [{
              platform: 'TuyaPlatform',
              name: 'Tuya',
              options: { projectType: '3', appSchema: 'tuyaSmart', userCode: 'user-1' },
            }]),
            hideSchemaForm: jest.fn(),
            request: jest.fn(async (route: string) => {
              if (route === '/about') return {};
              if (route === '/sharing/accounts') return { accounts: [] };
              if (route === '/sharing/status') return { connected: true, matchesConfiguration: true };
              if (route === '/sharing/overview') {
                return {
                  connected: true,
                  homes: [
                    { id: 'home-1', name: 'One', selected: true, deviceCount: 0, onlineCount: 0 },
                    { id: 'home-2', name: 'Two', selected: true, deviceCount: 0, onlineCount: 0 },
                  ],
                  devices: [],
                };
              }
              throw new Error(`Unexpected UI request: ${route}`);
            }),
            savePluginConfig: jest.fn(),
            showSchemaForm: jest.fn(),
            toast: { error: jest.fn(), info, success: jest.fn() },
            updatePluginConfig: jest.fn(),
          },
        });
      },
      runScripts: 'dangerously',
      url: 'http://127.0.0.1/plugin-config',
    });

    await Promise.all((listeners.get('ready') || []).map(listener => listener()));
    await new Promise(resolve => setTimeout(resolve, 0));

    const checkboxes = [...dom.window.document.querySelectorAll('#tuyaHomePicker input')] as HTMLInputElement[];
    expect(checkboxes).toHaveLength(2);
    checkboxes[0].click();
    checkboxes[1].click();
    expect(checkboxes.every(input => input.checked)).toBe(true);
    expect(info).toHaveBeenCalledWith('At least one home must be included. All homes were selected.', 'Home selection');

    dom.window.close();
  });

  test('offers a stored QR authorization when developer-project mode is selected', async () => {
    const listeners = new Map<string, UiEventHandler[]>();
    const confirm = jest.fn(() => false);
    const updatePluginConfig = jest.fn();
    const savePluginConfig = jest.fn();
    const request = jest.fn(async (route: string) => {
      if (route === '/about') return {};
      if (route === '/sharing/accounts') {
        return {
          accounts: [{
            userCode: 'stored-user',
            clientId: 'stored-client',
            appSchema: 'smartlife',
            username: 'Stored account',
          }],
        };
      }
      if (route === '/sharing/status') {
        return { connected: true, matchesConfiguration: true, username: 'Stored account' };
      }
      if (route === '/sharing/overview') {
        return {
          connected: true,
          username: 'Stored account',
          homes: [{ id: 'home-1', name: 'Recovered home', selected: true, deviceCount: 1, onlineCount: 1 }],
          devices: [{ id: 'device-1', name: 'Recovered device', category: 'kg', online: true }],
        };
      }
      throw new Error(`Unexpected UI request: ${route}`);
    });
    const html = fs.readFileSync(path.join(__dirname, '..', 'homebridge-ui', 'public', 'index.html'), 'utf8');
    const dom = new JSDOM(html, {
      beforeParse(window) {
        window.HTMLElement.prototype.scrollIntoView = jest.fn();
        window.confirm = confirm;
        Object.defineProperty(window, 'homebridge', {
          configurable: true,
          value: {
            addEventListener(name: string, listener: UiEventHandler) {
              listeners.set(name, [...(listeners.get(name) || []), listener]);
            },
            fixScrollHeight: jest.fn(),
            getPluginConfig: jest.fn(async () => [{
              platform: 'TuyaPlatform',
              name: 'Tuya',
              options: {
                projectType: '2',
                appSchema: 'smartlife',
                accessId: 'access-id',
                accessKey: 'access-key',
                countryCode: 91,
                username: 'developer@example.test',
                password: 'password',
              },
            }]),
            hideSchemaForm: jest.fn(),
            request,
            savePluginConfig,
            showSchemaForm: jest.fn(),
            toast: { error: jest.fn(), info: jest.fn(), success: jest.fn() },
            updatePluginConfig,
          },
        });
      },
      runScripts: 'dangerously',
      url: 'http://127.0.0.1/plugin-config',
    });

    await Promise.all((listeners.get('ready') || []).map(listener => listener()));
    await new Promise(resolve => setTimeout(resolve, 0));

    const document = dom.window.document;
    expect(document.getElementById('tuyaAuthorizationStat')?.textContent).toBe('Configured · QR stored');
    expect(document.getElementById('tuyaDashboardMessage')?.textContent).toContain('stored Smart Life QR authorization is also available');
    expect(document.getElementById('tuyaDashboardMessage')?.textContent).toContain('IR AC/remotes');

    (document.querySelector('[data-tuya-tab="account"]') as HTMLButtonElement).click();
    expect(document.getElementById('tuyaStoredQrRecovery')?.hidden).toBe(false);
    expect(document.getElementById('tuyaStoredQrRecoveryMessage')?.textContent).toContain('Stored account');
    expect(document.getElementById('tuyaUseStoredQr')?.textContent).toContain('no IR remotes');

    (document.getElementById('tuyaUseStoredQr') as HTMLButtonElement).click();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(confirm).not.toHaveBeenCalled();

    expect(updatePluginConfig).toHaveBeenCalledWith([
      expect.objectContaining({
        options: expect.objectContaining({
          projectType: '3',
          appSchema: 'smartlife',
          userCode: 'stored-user',
          clientId: 'stored-client',
        }),
      }),
    ]);
    expect(savePluginConfig).toHaveBeenCalled();
    expect(document.getElementById('tuyaAuthorizationStat')?.textContent).toBe('Connected');
    expect(document.getElementById('tuyaDashboardHomes')?.textContent).toContain('Recovered home');

    dom.window.close();
  });
});
