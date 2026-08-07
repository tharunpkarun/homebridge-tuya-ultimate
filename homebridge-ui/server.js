const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');

const {
  DEFAULT_CLIENT_ID,
  DEFAULT_LOGIN_ENDPOINT,
  DEFAULT_SCHEMA,
  legacySharingCredentialFile,
  sharingCredentialFile,
  TuyaSharingCredentialStore,
  TuyaSharingLogin,
} = require('../dist/core/TuyaSharingAuth');
const TuyaSharingAPI = require('../dist/core/TuyaSharingAPI').default;
const packageJson = require('../package.json');

function credentialFile(storagePath, userCode) {
  return sharingCredentialFile(storagePath, userCode);
}

function required(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RequestError(`${label} is required`, { status: 400 });
  }
  return value.trim();
}

async function findCredentialFiles(storagePath) {
  const files = [];
  for (const directory of [path.join(storagePath, 'persist'), storagePath]) {
    try {
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      files.push(...entries
        .filter(entry => entry.isFile() && /^TuyaSharing\.[a-f0-9]{16}\.json$/.test(entry.name))
        .map(entry => path.join(directory, entry.name)));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return files;
}

function createHandlers(storagePath, dependencies = {}) {
  const CredentialStore = dependencies.CredentialStore || TuyaSharingCredentialStore;
  const Login = dependencies.Login || TuyaSharingLogin;
  const SharingAPI = dependencies.SharingAPI || TuyaSharingAPI;
  const listCredentialFiles = dependencies.listCredentialFiles || findCredentialFiles;
  const renderQr = dependencies.renderQr || (content => QRCode.toDataURL(content, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 360,
  }));

  function storeFor(userCode) {
    return new CredentialStore(credentialFile(storagePath, userCode));
  }

  async function loadCredentials(userCode) {
    const store = storeFor(userCode);
    const credentials = await store.load();
    if (credentials) return credentials;

    const legacyStore = new CredentialStore(legacySharingCredentialFile(storagePath, userCode));
    const legacyCredentials = await legacyStore.load();
    if (legacyCredentials) {
      await store.save(legacyCredentials);
    }
    return legacyCredentials;
  }

  return {
    async about() {
      return {
        name: packageJson.displayName,
        packageName: packageJson.name,
        version: packageJson.version,
        description: packageJson.description,
        node: process.versions.node,
        homebridge: packageJson.engines.homebridge,
        repository: packageJson.repository.url.replace(/^git\+/, '').replace(/\.git$/, ''),
        issues: packageJson.bugs.url,
      };
    },

    async status(payload = {}) {
      const userCode = required(payload.userCode, 'User code');
      const credentials = await loadCredentials(userCode);
      const clientId = payload.clientId || process.env.TUYA_SHARING_CLIENT_ID || DEFAULT_CLIENT_ID;
      const appSchema = payload.appSchema === 'smartlife' ? 'smartlife' : 'tuyaSmart';
      const matchesConfiguration = Boolean(credentials
        && credentials.client_id === clientId
        && credentials.user_code === userCode
        && credentials.app_schema === appSchema);
      return credentials ? {
        connected: true,
        matchesConfiguration,
        username: credentials.username,
        endpoint: credentials.endpoint,
        appSchema: credentials.app_schema,
        expiresAt: credentials.token_info.t + credentials.token_info.expire_time * 1000,
      } : { connected: false };
    },

    async accounts() {
      const accounts = [];
      const identities = new Set();
      for (const file of await listCredentialFiles(storagePath)) {
        try {
          const credentials = await new CredentialStore(file).load();
          if (!credentials?.user_code || !credentials?.client_id || !credentials?.app_schema) {
            continue;
          }
          const identity = `${credentials.client_id}\0${credentials.user_code}\0${credentials.app_schema}`;
          if (identities.has(identity)) {
            continue;
          }
          identities.add(identity);
          accounts.push({
            userCode: credentials.user_code,
            clientId: credentials.client_id,
            appSchema: credentials.app_schema,
            username: credentials.username,
            endpoint: credentials.endpoint,
            expiresAt: credentials.token_info.t + credentials.token_info.expire_time * 1000,
          });
        } catch (_error) {
          // Ignore an unreadable legacy file so one stale entry cannot hide valid accounts.
        }
      }
      return { accounts };
    },

    async start(payload = {}) {
      const userCode = required(payload.userCode, 'User code');
      const clientId = payload.clientId || process.env.TUYA_SHARING_CLIENT_ID || DEFAULT_CLIENT_ID;
      const qrSchema = payload.qrSchema || process.env.TUYA_SHARING_SCHEMA || DEFAULT_SCHEMA;
      const login = new Login(clientId, payload.endpoint || DEFAULT_LOGIN_ENDPOINT, undefined, qrSchema);
      const qr = await login.createQrCode(userCode);
      return {
        state: 'created',
        qrToken: qr.token,
        qrImage: await renderQr(qr.content),
      };
    },

    async poll(payload = {}) {
      const userCode = required(payload.userCode, 'User code');
      const clientId = payload.clientId || process.env.TUYA_SHARING_CLIENT_ID || DEFAULT_CLIENT_ID;
      const qrToken = required(payload.qrToken, 'QR token');
      const appSchema = payload.appSchema === 'smartlife' ? 'smartlife' : 'tuyaSmart';
      const login = new Login(clientId, payload.endpoint || DEFAULT_LOGIN_ENDPOINT);
      const credentials = await login.loginResult(qrToken, userCode, appSchema);
      if (!credentials) return { state: 'pending' };
      const store = storeFor(userCode);
      await store.save(credentials);
      return { state: 'success', username: credentials.username, endpoint: credentials.endpoint };
    },

    async overview(payload = {}) {
      const userCode = required(payload.userCode, 'User code');
      const clientId = payload.clientId || process.env.TUYA_SHARING_CLIENT_ID || DEFAULT_CLIENT_ID;
      const appSchema = payload.appSchema === 'smartlife' ? 'smartlife' : 'tuyaSmart';
      const store = storeFor(userCode);
      const credentials = await loadCredentials(userCode);
      if (!credentials) {
        return { connected: false, reason: 'not_authorized', homes: [], devices: [] };
      }
      if (credentials.client_id !== clientId
        || credentials.user_code !== userCode
        || credentials.app_schema !== appSchema) {
        return { connected: false, reason: 'configuration_changed', homes: [], devices: [] };
      }

      const api = new SharingAPI({
        credentials,
        onTokenUpdate: async token => {
          credentials.token_info = token;
          await store.save(credentials);
        },
      });
      const homeResponse = await api.get('/v1.0/m/life/users/homes');
      if (!homeResponse.success || !Array.isArray(homeResponse.result)) {
        throw new RequestError(
          `Tuya could not load homes (${homeResponse.code || 'unknown'}): ${homeResponse.msg || 'Unknown error'}`,
          { status: 502 },
        );
      }

      const selectedHomes = Array.isArray(payload.homeWhitelist)
        ? new Set(payload.homeWhitelist.map(String))
        : null;
      const homes = [];
      const devices = [];
      for (const rawHome of homeResponse.result) {
        const homeId = String(rawHome.ownerId ?? rawHome.home_id ?? rawHome.id ?? '');
        if (!homeId) continue;
        const home = {
          id: homeId,
          name: String(rawHome.name ?? homeId),
          selected: !selectedHomes || selectedHomes.has(homeId),
          deviceCount: 0,
          onlineCount: 0,
        };
        if (home.selected) {
          const deviceResponse = await api.get('/v1.0/m/life/ha/home/devices', { homeId });
          if (deviceResponse.success && Array.isArray(deviceResponse.result)) {
            for (const rawDevice of deviceResponse.result) {
              const device = {
                id: String(rawDevice.id ?? ''),
                name: String(rawDevice.name ?? rawDevice.id ?? 'Unnamed device'),
                category: String(rawDevice.category ?? 'unknown'),
                productName: String(rawDevice.product_name ?? rawDevice.productName ?? ''),
                online: rawDevice.online !== false,
                subDevice: rawDevice.sub === true,
                homeId,
              };
              devices.push(device);
              home.deviceCount += 1;
              if (device.online) home.onlineCount += 1;
            }
          }
        }
        homes.push(home);
      }

      return {
        connected: true,
        username: credentials.username,
        appSchema: credentials.app_schema,
        endpoint: credentials.endpoint,
        homes,
        devices,
      };
    },
  };
}

class TuyaAccountUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    const handlers = createHandlers(this.homebridgeStoragePath);
    this.onRequest('/about', handlers.about);
    this.onRequest('/sharing/accounts', handlers.accounts);
    this.onRequest('/sharing/status', handlers.status);
    this.onRequest('/sharing/qr/start', handlers.start);
    this.onRequest('/sharing/qr/poll', handlers.poll);
    this.onRequest('/sharing/overview', handlers.overview);
    this.ready();
  }
}

if (require.main === module) {
  new TuyaAccountUiServer();
}

module.exports = { createHandlers, credentialFile, findCredentialFiles, TuyaAccountUiServer };
