import fs from 'node:fs';
import path from 'node:path';

import { JSDOM } from 'jsdom';

type UiEventHandler = (event?: { data?: unknown }) => unknown;

describe('Homebridge custom UI', () => {
  test('renders live account data and supports the primary navigation flows', async () => {
    const listeners = new Map<string, UiEventHandler[]>();
    const showSchemaForm = jest.fn();
    const hideSchemaForm = jest.fn();
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
        };
      }
      if (route === '/sharing/status') {
        return { connected: true, matchesConfiguration: true, username: 'Test account' };
      }
      if (route === '/sharing/overview') {
        return {
          connected: true,
          username: 'Test account',
          homes: [
            { id: 'home-1', name: 'Main home', selected: true, deviceCount: 2, onlineCount: 1 },
            { id: 'home-2', name: 'Workshop', selected: true, deviceCount: 1, onlineCount: 1 },
          ],
          devices: [
            { id: 'device-1', name: 'Hall light', category: 'dj', productName: 'Light', online: true, homeId: 'home-1' },
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
              },
            }]),
            hideSchemaForm,
            request,
            savePluginConfig: jest.fn(),
            showSchemaForm,
            toast,
            updatePluginConfig: jest.fn(),
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

    (document.querySelector('[data-tuya-tab="account"]') as HTMLButtonElement).click();
    expect(document.getElementById('tuyaPanelAccount')?.hidden).toBe(false);
    (document.querySelector('[data-project-type="1"]') as HTMLButtonElement).click();
    expect(document.getElementById('tuyaQrAccount')?.hidden).toBe(true);
    expect(document.getElementById('tuyaDeveloperAccount')?.hidden).toBe(false);
    expect(document.getElementById('tuyaDeveloperTitle')?.textContent).toBe('Custom cloud project');

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
});
