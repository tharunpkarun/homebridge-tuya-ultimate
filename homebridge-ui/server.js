const Crypto = require('node:crypto');
const path = require('node:path');

const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const QRCode = require('qrcode');

const {
  DEFAULT_CLIENT_ID,
  DEFAULT_LOGIN_ENDPOINT,
  DEFAULT_SCHEMA,
  TuyaSharingCredentialStore,
  TuyaSharingLogin,
} = require('../dist/core/TuyaSharingAuth');

function credentialFile(storagePath, userCode) {
  const id = Crypto.createHash('sha256').update(userCode).digest('hex').slice(0, 16);
  return path.join(storagePath, `TuyaSharing.${id}.json`);
}

function required(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RequestError(`${label} is required`, { status: 400 });
  }
  return value.trim();
}

function createHandlers(storagePath) {
  return {
    async status(payload = {}) {
      const userCode = required(payload.userCode, 'User code');
      const store = new TuyaSharingCredentialStore(credentialFile(storagePath, userCode));
      const credentials = await store.load();
      return credentials ? {
        connected: true,
        username: credentials.username,
        endpoint: credentials.endpoint,
        appSchema: credentials.app_schema,
      } : { connected: false };
    },

    async start(payload = {}) {
      const userCode = required(payload.userCode, 'User code');
      const clientId = payload.clientId || process.env.TUYA_SHARING_CLIENT_ID || DEFAULT_CLIENT_ID;
      const qrSchema = payload.qrSchema || process.env.TUYA_SHARING_SCHEMA || DEFAULT_SCHEMA;
      const login = new TuyaSharingLogin(clientId, payload.endpoint || DEFAULT_LOGIN_ENDPOINT, undefined, qrSchema);
      const qr = await login.createQrCode(userCode);
      return {
        state: 'created',
        qrToken: qr.token,
        qrImage: await QRCode.toDataURL(qr.content, { errorCorrectionLevel: 'M', width: 320 }),
      };
    },

    async poll(payload = {}) {
      const userCode = required(payload.userCode, 'User code');
      const clientId = payload.clientId || process.env.TUYA_SHARING_CLIENT_ID || DEFAULT_CLIENT_ID;
      const qrToken = required(payload.qrToken, 'QR token');
      const appSchema = payload.appSchema === 'smartlife' ? 'smartlife' : 'tuyaSmart';
      const login = new TuyaSharingLogin(clientId, payload.endpoint || DEFAULT_LOGIN_ENDPOINT);
      const credentials = await login.loginResult(qrToken, userCode, appSchema);
      if (!credentials) return { state: 'pending' };
      const store = new TuyaSharingCredentialStore(credentialFile(storagePath, userCode));
      await store.save(credentials);
      return { state: 'success', username: credentials.username, endpoint: credentials.endpoint };
    },
  };
}

class TuyaAccountUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    const handlers = createHandlers(this.homebridgeStoragePath);
    this.onRequest('/sharing/status', handlers.status);
    this.onRequest('/sharing/qr/start', handlers.start);
    this.onRequest('/sharing/qr/poll', handlers.poll);
    this.ready();
  }
}

if (require.main === module) {
  new TuyaAccountUiServer();
}

module.exports = { createHandlers, credentialFile, TuyaAccountUiServer };
