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

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const DATAPOINT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/;
const SAFE_SCHEMA_TYPES = new Set(['Boolean', 'Integer', 'Enum', 'String', 'Json', 'Raw', 'Bitmap']);
const IR_SHARING_FUNCTION_CODES = new Set(['F', 'M', 'PowerOff', 'PowerOn', 'T']);
const IR_SHARING_STATUS_CODES = new Set(['mode', 'power', 'temp', 'wind']);
const IR_SHARING_REMOTE_CATEGORIES = new Set([
  'infrared_airpurifier', 'infrared_amplifier', 'infrared_box', 'infrared_fan',
  'infrared_humidifier', 'infrared_light', 'infrared_projector', 'infrared_stb',
  'infrared_tv', 'infrared_waterheater',
]);
const SENSITIVE_CODE_PATTERN = /(?:^|[_-])(?:access|account|address|auth|certificate|coordinate|credential|email|endpoint|geo|gps|host|ip|key|lat|latitude|lng|localkey|local_key|location|lon|longitude|mac|password|passwd|phone|pin|private|pwd|secret|session|ssid|token|uid|uri|url|user|username|wifi)(?:$|[_-])/i;
const URL_PATTERN = /\b(?:data|file|ftp|https?|mqtts?|rtsp|wss?):\/\/\S+|\bwww\.\S+/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b(?:access[_ -]?key|auth|credential|local[_ -]?key|password|secret|token)\b\s*[:=]\s*\S+/gi;
const COORDINATE_PATTERN = /(?:^|\s)[+-]?\d{1,3}(?:\.\d{3,})?\s*[,/]\s*[+-]?\d{1,3}(?:\.\d{3,})?(?=\s|$)/g;
const HIGH_ENTROPY_PATTERN = /\b(?:[a-f0-9]{32,}|[a-zA-Z0-9+/_-]{40,}={0,2})\b/g;
const MAX_DIAGNOSTIC_ITEMS = 128;
const MAX_RUNTIME_DIAGNOSTIC_BYTES = 512 * 1024;
const MAX_RUNTIME_COMMANDS = 100;
const MAX_RUNTIME_RECENT_COMMANDS = 25;
const MAX_RUNTIME_CODES = 16;
const RUNTIME_DEVICE_REF_PATTERN = /^[a-f0-9]{16}$/;
const RUNTIME_ROUTES = new Set(['cloud', 'local', 'hybrid']);
const RUNTIME_ATTEMPTED_ROUTES = new Set(['cloud', 'local']);
const RUNTIME_OUTCOMES = new Set(['success', 'failure']);
const RUNTIME_ERROR_KINDS = new Set(['configuration', 'connection', 'rejected', 'timeout', 'unknown']);
const DEVICE_CATEGORY_OPTIONS = [
  ['dj', 'Light'], ['dsd', 'Light'], ['xdd', 'Light'], ['fwd', 'Light'], ['dc', 'Light'], ['dd', 'Light'],
  ['gyd', 'Light'], ['tyndj', 'Light'], ['sxd', 'Light'], ['tgq', 'Dimmer'], ['tgkg', 'Dimmer'],
  ['dlq', 'Switch'], ['kg', 'Switch'], ['tdq', 'Switch'], ['qjdcz', 'Switch'], ['szjqr', 'Switch'],
  ['cz', 'Outlet'], ['pc', 'Outlet'], ['wkcz', 'Outlet'], ['wxkg', 'Wireless switch'],
  ['cjkg', 'Scene switch'], ['bzyd', 'White-noise light'], ['zndb', 'Electricity meter'],
  ['kt', 'Air conditioner'], ['ktkzq', 'Air conditioner controller'], ['qn', 'Heater'], ['qn_old', 'Legacy heater'],
  ['kj', 'Air purifier'], ['xxj', 'Diffuser'], ['ckmkzq', 'Garage door'], ['cl', 'Curtain'],
  ['clkg', 'Curtain switch'], ['cwwsq', 'Pet feeder'], ['mc', 'Window controller'], ['wk', 'Thermostat'],
  ['wkf', 'Thermostat'], ['mjj', 'Towel rack'], ['ggq', 'Irrigator'], ['sfkzq', 'Irrigator'],
  ['jsq', 'Humidifier'], ['cs', 'Dehumidifier'], ['fs', 'Fan'], ['fsd', 'Fan'], ['fskg', 'Fan switch'],
  ['yyj', 'Extraction hood'], ['sp', 'Camera'], ['ywbj', 'Smoke sensor'], ['mcs', 'Contact sensor'],
  ['zd', 'Vibration sensor'], ['rqbj', 'Gas alarm'], ['jwbj', 'Methane alarm'], ['sj', 'Water detector'],
  ['cobj', 'Carbon monoxide sensor'], ['cocgq', 'Carbon monoxide sensor'], ['co2bj', 'Carbon dioxide sensor'],
  ['co2cgq', 'Carbon dioxide sensor'], ['wsdcg', 'Temperature and humidity sensor'], ['ldcg', 'Light sensor'],
  ['pir', 'Motion sensor'], ['pm25', 'Air-quality sensor'], ['pm2.5', 'Air-quality sensor'],
  ['pm25cgq', 'Air-quality sensor'], ['hjjcy', 'Air-quality sensor'], ['hps', 'Presence sensor'],
  ['ms', 'Lock'], ['jtmspro', 'Lock'], ['mal', 'Security system'], ['sos', 'Emergency button'],
  ['wxml', 'Doorbell'], ['qxj', 'Weather station'], ['wnykq', 'IR hub'], ['hwktwkq', 'IR thermostat hub'],
  ['wsdykq', 'IR hub'], ['infrared_tv', 'IR television'], ['infrared_stb', 'IR set-top box'],
  ['infrared_box', 'IR media box'], ['infrared_fan', 'IR fan'], ['infrared_light', 'IR light'],
  ['infrared_amplifier', 'IR amplifier'], ['infrared_projector', 'IR projector'],
  ['infrared_waterheater', 'IR water heater'], ['infrared_airpurifier', 'IR air purifier'],
  ['infrared_humidifier', 'IR humidifier'], ['infrared_ac', 'IR air conditioner'],
].map(([code, label]) => ({ code, label }));

function credentialFile(storagePath, userCode) {
  return sharingCredentialFile(storagePath, userCode);
}

function required(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RequestError(`${label} is required`, { status: 400 });
  }
  return value.trim();
}

function safeIdentifier(value, pattern = IDENTIFIER_PATTERN) {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  return pattern.test(text) ? text : '';
}

function safeLabel(value, fallback, maxLength = 96) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return fallback;
  }
  const text = String(value)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(URL_PATTERN, '[hidden]')
    .replace(SECRET_ASSIGNMENT_PATTERN, '[hidden]')
    .replace(COORDINATE_PATTERN, ' [hidden]')
    .replace(HIGH_ENTROPY_PATTERN, '[hidden]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return fallback;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function isSensitiveCode(code) {
  return SENSITIVE_CODE_PATTERN.test(code.replace(/([a-z])([A-Z])/g, '$1_$2'));
}

function parseSchemaProperty(entry) {
  if (entry?.property && typeof entry.property === 'object' && !Array.isArray(entry.property)) {
    return entry.property;
  }
  if (typeof entry?.values !== 'string' || entry.values.length > 20_000) {
    return {};
  }
  try {
    const parsed = JSON.parse(entry.values);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function safeEnumValue(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text
    || text.length > 64
    || /[:/\\]/.test(text)
    || /(?:auth|credential|password|secret|token)/i.test(text)
    || /^[a-zA-Z0-9_-]{20,}$/.test(text)
    || URL_PATTERN.test(text)) {
    URL_PATTERN.lastIndex = 0;
    return undefined;
  }
  URL_PATTERN.lastIndex = 0;
  if (/^[a-zA-Z0-9][a-zA-Z0-9 _.+%()-]{0,63}$/.test(text)) {
    return text;
  }
  return undefined;
}

function sanitizeSchemaProperty(type, property) {
  if (type === 'Integer') {
    const result = {};
    for (const key of ['min', 'max', 'scale', 'step']) {
      const value = property?.[key];
      if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
        result[key] = value;
      }
    }
    return result;
  }
  if (type === 'Enum' && Array.isArray(property?.range)) {
    const range = property.range
      .slice(0, 64)
      .map(safeEnumValue)
      .filter(value => value !== undefined);
    return range.length ? { range } : {};
  }
  if (type === 'Enum') {
    const result = {};
    for (const key of ['min', 'max', 'scale', 'step']) {
      const value = property?.[key];
      if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
        result[key] = value;
      }
    }
    return result;
  }
  return {};
}

function sanitizeDeviceSchema(rawDevice, specification) {
  const schemas = new Map();
  const add = (entry, access) => {
    const code = safeIdentifier(entry?.code, DATAPOINT_PATTERN);
    if (!code || isSensitiveCode(code)) return;
    const type = SAFE_SCHEMA_TYPES.has(entry?.type) ? entry.type : 'Unknown';
    const current = schemas.get(code) || { code, readable: false, writable: false, type, property: {} };
    if (access === 'read') current.readable = true;
    if (access === 'write') current.writable = true;
    if (entry?.mode === 'ro' || entry?.mode === 'rw') current.readable = true;
    if (entry?.mode === 'wo' || entry?.mode === 'rw') current.writable = true;
    if (type !== 'Unknown') current.type = type;
    current.property = sanitizeSchemaProperty(current.type, parseSchemaProperty(entry));
    schemas.set(code, current);
  };

  if (Array.isArray(rawDevice?.schema)) {
    rawDevice.schema.forEach(entry => add(entry));
  }
  if (Array.isArray(specification?.status)) {
    specification.status.forEach(entry => add(entry, 'read'));
  }
  if (Array.isArray(specification?.functions)) {
    specification.functions.forEach(entry => add(entry, 'write'));
  }
  for (const [mappingCode, value] of specificationEntries(rawDevice?.status_range)) {
    add(mappingSpecification(mappingCode, value), 'read');
  }
  for (const [mappingCode, value] of specificationEntries(rawDevice?.function)) {
    add(mappingSpecification(mappingCode, value), 'write');
  }
  const isInfraredAC = rawDevice?.category === 'infrared_ac';
  const isInfraredButtonRemote = IR_SHARING_REMOTE_CATEGORIES.has(rawDevice?.category);
  if (isInfraredAC || isInfraredButtonRemote) {
    for (const [mappingCode, value] of specificationEntries(rawDevice?.mapping)) {
      const code = typeof value.code === 'string' ? value.code : mappingCode;
      const entry = mappingSpecification(mappingCode, value);
      if (!entry) continue;
      if (isInfraredAC && IR_SHARING_FUNCTION_CODES.has(code)) add(entry, 'write');
      if (isInfraredAC && IR_SHARING_STATUS_CODES.has(code)) add(entry, 'read');
      if (isInfraredButtonRemote && isStaticInfraredMappingFunction(entry.type, value.values ?? value.value)) {
        add(entry, 'write');
      }
    }
  }

  const all = [...schemas.values()].sort((left, right) => left.code.localeCompare(right.code));
  return {
    entries: all.slice(0, MAX_DIAGNOSTIC_ITEMS).map(entry => ({
      code: entry.code,
      mode: entry.readable && entry.writable ? 'rw' : entry.readable ? 'ro' : entry.writable ? 'wo' : 'unknown',
      type: entry.type,
      property: entry.property,
    })),
    omittedCount: Math.max(0, all.length - MAX_DIAGNOSTIC_ITEMS),
  };
}

function specificationEntries(value) {
  let source = value;
  if (typeof source === 'string' && source.length <= 100_000) {
    try {
      source = JSON.parse(source);
    } catch (_error) {
      return [];
    }
  }
  if (Array.isArray(source)) {
    return source.slice(0, 256).flatMap((entry, index) => (
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? [[typeof entry.code === 'string' ? entry.code : String(index), entry]]
        : []
    ));
  }
  if (!source || typeof source !== 'object') return [];
  return Object.entries(source).slice(0, 256)
    .filter(([, entry]) => entry && typeof entry === 'object' && !Array.isArray(entry));
}

function mappingSpecification(mappingCode, value) {
  const code = typeof value.code === 'string' ? value.code : mappingCode;
  const type = normalizeMappingSchemaType(value.type);
  if (!code || !type) return undefined;
  const mappingValue = value.values ?? value.value;
  return {
    code,
    type,
    property: mappingValue && typeof mappingValue === 'object' && !Array.isArray(mappingValue)
      ? mappingValue
      : undefined,
    values: typeof mappingValue === 'string'
      ? mappingValue
      : mappingValue !== undefined ? JSON.stringify(mappingValue) : undefined,
  };
}

function isStaticInfraredMappingFunction(type, value) {
  return type === 'String'
    && (value === undefined || ['string', 'number', 'boolean'].includes(typeof value));
}

function normalizeMappingSchemaType(value) {
  switch (String(value ?? '').toLowerCase()) {
    case 'bool':
    case 'boolean': return 'Boolean';
    case 'value':
    case 'integer': return 'Integer';
    case 'number': return 'Integer';
    case 'enum': return 'Enum';
    case 'string': return 'String';
    case 'json': return 'Json';
    case 'raw': return 'Raw';
    case 'bitmap': return 'Bitmap';
    default: return undefined;
  }
}

function rawStatuses(rawDevice) {
  if (Array.isArray(rawDevice?.status)) return rawDevice.status;
  if (rawDevice?.status && typeof rawDevice.status === 'object') {
    return Object.entries(rawDevice.status).map(([code, value]) => ({ code, value }));
  }
  return [];
}

function sanitizeDeviceStatus(rawDevice, schemaEntries) {
  const schemas = new Map(schemaEntries.map(entry => [entry.code, entry]));
  const entries = [];
  let omittedCount = 0;
  for (const item of rawStatuses(rawDevice)) {
    const code = safeIdentifier(item?.code, DATAPOINT_PATTERN);
    if (!code || isSensitiveCode(code) || entries.length >= MAX_DIAGNOSTIC_ITEMS) {
      omittedCount += 1;
      continue;
    }
    const schema = schemas.get(code);
    let displayValue = 'Hidden';
    let redacted = true;
    if (schema?.type === 'Boolean' && typeof item.value === 'boolean') {
      displayValue = item.value ? 'true' : 'false';
      redacted = false;
    } else if ((schema?.type === 'Integer' || schema?.type === 'Bitmap')
      && typeof item.value === 'number' && Number.isFinite(item.value)) {
      displayValue = String(item.value);
      redacted = false;
    } else if (schema?.type === 'Enum') {
      const enumValue = safeEnumValue(item.value);
      if (enumValue && schema.property?.range?.includes(enumValue)) {
        displayValue = enumValue;
        redacted = false;
      }
    }
    entries.push({ code, displayValue, redacted });
  }
  return { entries, omittedCount };
}

function sanitizeDevice(rawDevice, homeId, specification = {}) {
  const id = safeIdentifier(rawDevice?.id);
  if (!id) return undefined;
  const safeHomeId = safeIdentifier(homeId);
  const category = safeIdentifier(rawDevice?.category, DATAPOINT_PATTERN) || 'unknown';
  const schema = sanitizeDeviceSchema(rawDevice, specification);
  const status = sanitizeDeviceStatus(rawDevice, schema.entries);
  const connectionStatus = rawDevice?.online === true ? 'online' : rawDevice?.online === false ? 'offline' : 'unknown';
  const setupStatus = rawDevice?.set_up === true ? 'ready' : rawDevice?.set_up === false ? 'incomplete' : 'unknown';
  const productId = safeIdentifier(rawDevice?.product_id ?? rawDevice?.productId);
  const uuid = safeIdentifier(rawDevice?.uuid);
  return {
    id,
    uuid: uuid && uuid !== id ? uuid : undefined,
    name: safeLabel(rawDevice?.name, 'Unnamed device'),
    category,
    productId,
    productName: safeLabel(rawDevice?.product_name ?? rawDevice?.productName, ''),
    homeId: safeHomeId,
    online: connectionStatus === 'online',
    subDevice: rawDevice?.sub === true,
    connection: {
      status: connectionStatus,
      transport: 'cloud',
      topology: rawDevice?.sub === true ? 'sub-device' : 'direct',
      setup: setupStatus,
    },
    schema: schema.entries,
    schemaOmittedCount: schema.omittedCount,
    status: status.entries,
    statusOmittedCount: status.omittedCount,
    overrideDraft: id.toLowerCase() === 'global'
      ? undefined
      : category === 'unknown' || category === 'hidden' ? { id } : { id, category },
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeRuntimeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeRuntimeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sanitizeRuntimeDiagnostics(raw) {
  if (!isPlainObject(raw) || raw.version !== 1 || !isPlainObject(raw.mqtt) || !Array.isArray(raw.commands)) {
    return undefined;
  }
  const messageCount = safeRuntimeCount(raw.mqtt.messageCount);
  if (messageCount === undefined || !isPlainObject(raw.mqtt.protocols)) {
    return undefined;
  }

  const deviceReferences = new Map();
  let nextDeviceReference = 1;
  const pseudonymize = reference => {
    if (typeof reference !== 'string' || !RUNTIME_DEVICE_REF_PATTERN.test(reference)) return undefined;
    if (!deviceReferences.has(reference)) {
      deviceReferences.set(reference, `runtime-device-${String(nextDeviceReference).padStart(3, '0')}`);
      nextDeviceReference += 1;
    }
    return deviceReferences.get(reference);
  };

  const protocols = Object.entries(raw.mqtt.protocols)
    .map(([protocol, count]) => ({ protocol: Number(protocol), count: safeRuntimeCount(count) }))
    .filter(item => Number.isInteger(item.protocol)
      && item.protocol >= 0
      && item.protocol <= 99_999
      && item.count !== undefined)
    .sort((left, right) => left.protocol - right.protocol)
    .slice(0, 32);
  const mqtt = { messageCount, protocols };
  const lastMessageAt = safeRuntimeTimestamp(raw.mqtt.lastMessageAt);
  if (lastMessageAt !== undefined) mqtt.lastMessageAt = lastMessageAt;
  if (Number.isInteger(raw.mqtt.lastProtocol)
    && raw.mqtt.lastProtocol >= 0
    && raw.mqtt.lastProtocol <= 99_999) {
    mqtt.lastProtocol = raw.mqtt.lastProtocol;
  }
  const lastDeviceReference = pseudonymize(raw.mqtt.lastDeviceRef);
  if (lastDeviceReference) mqtt.lastDeviceReference = lastDeviceReference;

  const commands = raw.commands.slice(-MAX_RUNTIME_COMMANDS).flatMap(entry => {
    if (!isPlainObject(entry)
      || safeRuntimeTimestamp(entry.timestamp) === undefined
      || typeof entry.deviceRef !== 'string'
      || !RUNTIME_DEVICE_REF_PATTERN.test(entry.deviceRef)
      || !Array.isArray(entry.codes)
      || !RUNTIME_ROUTES.has(entry.requestedRoute)
      || !RUNTIME_ATTEMPTED_ROUTES.has(entry.attemptedRoute)
      || !RUNTIME_OUTCOMES.has(entry.outcome)
      || !Number.isInteger(entry.durationMs)
      || entry.durationMs < 0
      || entry.durationMs > 300_000) {
      return [];
    }
    const codes = [...new Set(entry.codes.slice(0, MAX_RUNTIME_CODES))]
      .filter(code => typeof code === 'string'
        && safeIdentifier(code, DATAPOINT_PATTERN)
        && !isSensitiveCode(code))
    const command = {
      timestamp: entry.timestamp,
      deviceReference: pseudonymize(entry.deviceRef),
      codes,
      requestedRoute: entry.requestedRoute,
      attemptedRoute: entry.attemptedRoute,
      outcome: entry.outcome,
      durationMs: entry.durationMs,
    };
    if (entry.outcome === 'failure' && RUNTIME_ERROR_KINDS.has(entry.errorKind)) {
      command.errorKind = entry.errorKind;
    }
    return [command];
  });

  const outcomeCounts = { success: 0, failure: 0 };
  const requestedRouteCounts = { cloud: 0, local: 0, hybrid: 0 };
  const attemptedRouteCounts = { cloud: 0, local: 0 };
  const codeCounts = new Map();
  let durationTotal = 0;
  for (const command of commands) {
    outcomeCounts[command.outcome] += 1;
    requestedRouteCounts[command.requestedRoute] += 1;
    attemptedRouteCounts[command.attemptedRoute] += 1;
    durationTotal += command.durationMs;
    for (const code of command.codes) codeCounts.set(code, (codeCounts.get(code) || 0) + 1);
  }
  const durations = commands.map(command => command.durationMs);
  const commandSummary = {
    retainedCount: commands.length,
    outcomeCounts,
    requestedRouteCounts,
    attemptedRouteCounts,
    durationMs: {
      min: durations.length ? Math.min(...durations) : 0,
      max: durations.length ? Math.max(...durations) : 0,
      average: durations.length ? Math.round(durationTotal / durations.length) : 0,
    },
    codeCounts: [...codeCounts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code))
      .slice(0, 64),
    recent: commands.slice(-MAX_RUNTIME_RECENT_COMMANDS),
  };
  if (commands.length) commandSummary.lastCommandAt = commands[commands.length - 1].timestamp;

  return { version: 1, mqtt, commands: commandSummary };
}

async function readRuntimeDiagnostics(storagePath) {
  const file = path.join(storagePath, 'persist', 'TuyaRuntimeDiagnostics.json');
  try {
    const stats = await fs.promises.lstat(file);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_RUNTIME_DIAGNOSTIC_BYTES) return undefined;
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch (_error) {
    return undefined;
  }
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
  const loginEndpoint = dependencies.loginEndpoint
    || process.env.TUYA_SHARING_LOGIN_ENDPOINT
    || DEFAULT_LOGIN_ENDPOINT;
  const listCredentialFiles = dependencies.listCredentialFiles || findCredentialFiles;
  const loadRuntimeDiagnostics = dependencies.readRuntimeDiagnostics
    || (() => readRuntimeDiagnostics(storagePath));
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
        deviceCategoryOptions: DEVICE_CATEGORY_OPTIONS,
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
      const login = new Login(clientId, loginEndpoint, undefined, qrSchema);
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
      const login = new Login(clientId, loginEndpoint);
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
        const code = safeIdentifier(homeResponse.code) || 'unknown';
        throw new RequestError(
          `Tuya could not load homes (${code}).`,
          { status: 502 },
        );
      }

      const selectedHomes = Array.isArray(payload.homeWhitelist)
        ? new Set(payload.homeWhitelist.map(String))
        : null;
      const homes = [];
      const devices = [];
      for (const rawHome of homeResponse.result) {
        const homeId = safeIdentifier(rawHome.ownerId ?? rawHome.home_id ?? rawHome.id);
        if (!homeId) continue;
        const home = {
          id: homeId,
          name: safeLabel(rawHome.name, homeId),
          selected: !selectedHomes || selectedHomes.has(homeId),
          deviceCount: 0,
          onlineCount: 0,
        };
        if (home.selected) {
          const deviceResponse = await api.get('/v1.0/m/life/ha/home/devices', { homeId });
          if (deviceResponse.success && Array.isArray(deviceResponse.result)) {
            const sanitizedDevices = await mapWithConcurrency(deviceResponse.result, 4, async rawDevice => {
              const deviceId = safeIdentifier(rawDevice?.id);
              let specification = {};
              if (deviceId) {
                try {
                  const response = await api.get(`/v1.1/m/life/${encodeURIComponent(deviceId)}/specifications`);
                  if (response.success && response.result && typeof response.result === 'object') {
                    specification = response.result;
                  }
                } catch (_error) {
                  // A missing product specification should not hide the safe identity/status summary.
                }
              }
              return sanitizeDevice(rawDevice, homeId, specification);
            });
            for (const device of sanitizedDevices) {
              if (!device) continue;
              devices.push(device);
              home.deviceCount += 1;
              if (device.connection.status === 'online') home.onlineCount += 1;
            }
          }
        }
        homes.push(home);
      }

      let runtimeDiagnostics;
      try {
        runtimeDiagnostics = sanitizeRuntimeDiagnostics(await loadRuntimeDiagnostics());
      } catch (_error) {
        // Runtime diagnostics are optional and must never prevent account inspection.
      }
      const result = {
        connected: true,
        connectionType: 'account-sharing',
        username: credentials.username,
        appSchema: credentials.app_schema,
        homes,
        devices,
      };
      if (runtimeDiagnostics) result.runtimeDiagnostics = runtimeDiagnostics;
      return result;
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

module.exports = {
  DEVICE_CATEGORY_OPTIONS,
  createHandlers,
  credentialFile,
  findCredentialFiles,
  readRuntimeDiagnostics,
  sanitizeDevice,
  sanitizeRuntimeDiagnostics,
  TuyaAccountUiServer,
};
