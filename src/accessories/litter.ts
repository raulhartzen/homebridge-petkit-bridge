import { PlatformAccessory } from 'homebridge';
import { PetkitBridgePlatform } from '../platform';

/**
 * Litter box -> two switches:
 *  - "Clean": momentary, starts a cleaning cycle;
 *  - "Maintenance": stateful, enters/exits maintenance mode; its state is
 *    read from the bridge's /maint-status endpoint (polled on demand and
 *    on an interval so automations stay in sync).
 */
export class LitterAccessory {
  private maintenanceOn = false;

  constructor(
    private readonly platform: PetkitBridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const { Service, Characteristic } = platform;
    const device = accessory.context.device;

    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'PetKit (via petkit-bridge)')
      .setCharacteristic(Characteristic.Model, String(device.type ?? 'litter'))
      .setCharacteristic(Characteristic.SerialNumber, String(device.id));

    // --- Clean (momentary) ---
    const cleanSwitch =
      accessory.getService('Clean') ||
      accessory.addService(Service.Switch, 'Clean', 'clean');

    cleanSwitch
      .getCharacteristic(Characteristic.On)
      .onGet(() => false)
      .onSet(async (value) => {
        if (!value) {
          return;
        }
        try {
          await this.platform.client.clean(device.id);
          this.platform.log.info('[%s] cleaning cycle started', accessory.displayName);
        } catch (err) {
          this.platform.log.error(
            '[%s] clean failed: %s',
            accessory.displayName,
            String(err),
          );
          throw new this.platform.api.hap.HapStatusError(
            this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
          );
        } finally {
          setTimeout(() => {
            cleanSwitch.updateCharacteristic(Characteristic.On, false);
          }, 1000);
        }
      });

    // --- Maintenance (stateful) ---
    const maintSwitch =
      accessory.getService('Maintenance') ||
      accessory.addService(Service.Switch, 'Maintenance', 'maintenance');

    maintSwitch
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.maintenanceOn)
      .onSet(async (value) => {
        const action = value ? 'START' : 'END';
        try {
          await this.platform.client.litter(device.id, action, 'MAINTENANCE');
          this.maintenanceOn = Boolean(value);
          this.platform.log.info(
            '[%s] maintenance %s',
            accessory.displayName,
            value ? 'entered' : 'exited',
          );
        } catch (err) {
          this.platform.log.error(
            '[%s] maintenance %s failed: %s',
            accessory.displayName,
            action,
            String(err),
          );
          throw new this.platform.api.hap.HapStatusError(
            this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
          );
        }
      });

    // Keep the maintenance state in sync with reality.
    const poll = async () => {
      try {
        const on = await this.platform.client.getMaintStatus(device.id);
        if (on !== this.maintenanceOn) {
          this.maintenanceOn = on;
          maintSwitch.updateCharacteristic(Characteristic.On, on);
        }
      } catch {
        // Transient errors are fine here; next poll will retry.
      }
    };
    void poll();
    setInterval(poll, this.platform.pollInterval * 1000);
  }
}
