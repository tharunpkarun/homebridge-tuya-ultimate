import { TuyaDeviceStatus } from '../device/TuyaDevice';
import BaseAccessory from './BaseAccessory';
import { configureName } from './characteristic/Name';
import { configureEmergencyEvent, onEmergencyEvent } from './characteristic/EmergencyEvent';
import { sanitizeName } from '../util/util';

const SCHEMA_CODE = {
  EMERGENCY: ['sos', 'sos_state'],
};

const SERVICE_SUBTYPE = 'emergency-button';

/** Exposes an SOS button as a non-commanding, single-press HomeKit event. */
export default class EmergencyButtonAccessory extends BaseAccessory {

  requiredSchema() {
    return [SCHEMA_CODE.EMERGENCY];
  }

  configureServices() {
    const schema = this.getSchema(...SCHEMA_CODE.EMERGENCY);
    if (!schema) {
      return;
    }

    const service = this.getEmergencyButtonService();
    configureName(this, service, this.device.name);
    configureEmergencyEvent(this, service, schema);
  }

  getEmergencyButtonService() {
    const name = sanitizeName(this.device.name) ?? 'Emergency Button';
    return this.accessory.getService(SERVICE_SUBTYPE)
      || this.accessory.addService(
        this.Service.StatelessProgrammableSwitch,
        name,
        SERVICE_SUBTYPE,
      );
  }

  async onDeviceStatusUpdate(status: TuyaDeviceStatus[]) {
    super.onDeviceStatusUpdate(status);

    const schema = this.getSchema(...SCHEMA_CODE.EMERGENCY);
    if (!schema) {
      return;
    }

    const emergencyStatus = status.find(item => item.code.toLowerCase() === schema.code.toLowerCase());
    if (emergencyStatus) {
      onEmergencyEvent(this, this.getEmergencyButtonService(), schema, emergencyStatus);
    }
  }
}
