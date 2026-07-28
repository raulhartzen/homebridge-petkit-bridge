import { PlatformAccessory } from 'homebridge';
import { PetkitBridgePlatform } from '../platform';

/**
 * Litter box -> two switches:
 *  - "Clean": momentary, starts a cleaning cycle;
 *  - "Maintenance": stateful, enters/exits maintenance mode; its state is
 *    read from the bridge's /maint-status endpoint (polled on demand and
 *    on an interval so automations stay in sync).
 */
/** After a manual command, skip polling sync while the device settles. */
const MAINT_SYNC_GRACE_MS = 90_000;

export class LitterAccessory {
  private maintenanceOn = false;
  private lastCommandAt = 0;

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
    cleanSwitch.addOptionalCharacteristic(Characteristic.ConfiguredName);
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
          const waitSecs = this.platform.scoopWait ?? 50;
          this.platform.log.info(
            '[%s] scoop cycle started (will stop on its own in ~%ds)',
            accessory.displayName,
            waitSecs,
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
    maintSwitch.addOptionalCharacteristic(Characteristic.ConfiguredName);
    maintSwitch.setCharacteristic(Characteristic.ConfiguredName, 'Maintenance');

    maintSwitch
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.maintenanceOn)
      .onSet(async (value) => {
        const target = Boolean(value);
        const action = target ? 'START' : 'END';
        // Optimistic update: reflect the requested state immediately, so
        // the Home app doesn't read a stale "off" while the bridge call
        // is in flight (which made the switch look momentary and led to
        // double-START "Device in operation" errors).
        const previous = this.maintenanceOn;
        this.maintenanceOn = target;
        this.lastCommandAt = Date.now();
        try {
          await this.platform.client.litter(device.id, action, 'MAINTENANCE');
          this.platform.log.info(
            '[%s] maintenance %s',
            accessory.displayName,
            target ? 'entered' : 'exited',
          );
        } catch (err) {
          // Revert the optimistic state.
          this.maintenanceOn = previous;
          setTimeout(() => {
            maintSwitch.updateCharacteristic(Characteristic.On, previous);
          }, 500);
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
      // Right after a manual command the device takes a while to report
      // its new mode; syncing during that window would flip the switch
      // back prematurely. Give it time to settle.
      if (Date.now() - this.lastCommandAt < MAINT_SYNC_GRACE_MS) {
        return;
      }
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
