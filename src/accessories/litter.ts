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
    // Explicit display name: without ConfiguredName, recent iOS versions
    // fall back to the accessory name for every service, making the two
    // switches indistinguishable in the Home app.
    cleanSwitch.setCharacteristic(Characteristic.Name, 'Clean');
    cleanSwitch.setCharacteristic(Characteristic.ConfiguredName, 'Clean');

    cleanSwitch
      .getCharacteristic(Characteristic.On)
      .onGet(() => false)
      .onSet(async (value) => {
        if (!value) {
          return;
        }
        try {
          // /scoop runs a full self-terminating cycle (START, wait, END).
          // Plain /clean only sends START and the litter box never stops.
          await this.platform.client.scoop(device.id, this.platform.scoopWait);
          this.platform.log.info(
            '[%s] scoop cycle started (will stop on its own)',
            accessory.displayName,
          );
        } catch (err) {
          this.platform.log.error(
            '[%s] scoop failed: %s',
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
    maintSwitch.setCharacteristic(Characteristic.Name, 'Maintenance');
    maintSwitch.setCharacteristic(Characteristic.ConfiguredName, 'Maintenance');

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
