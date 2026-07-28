import { PlatformAccessory } from 'homebridge';
import { PetkitBridgePlatform } from '../platform';

/**
 * Feeder -> a stateless Switch: turning it on dispenses one feed and the
 * switch flips back off after a moment (HomeKit has no native "button
 * you can trigger from automations", the momentary switch is the
 * conventional pattern).
 */
export class FeederAccessory {
  constructor(
    private readonly platform: PetkitBridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const { Service, Characteristic } = platform;
    const device = accessory.context.device;

    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'PetKit (via petkit-bridge)')
      .setCharacteristic(Characteristic.Model, String(device.type ?? 'feeder'))
      .setCharacteristic(Characteristic.SerialNumber, String(device.id));

    const feedSwitch =
      accessory.getService('Feed') ||
      accessory.addService(Service.Switch, 'Feed', 'feed');

    feedSwitch
      .getCharacteristic(Characteristic.On)
      .onGet(() => false)
      .onSet(async (value) => {
        if (!value) {
          return;
        }
        try {
          await this.platform.client.feed(device.id, this.platform.feedAmount);
          this.platform.log.info(
            '[%s] feed dispensed (amount=%d)',
            accessory.displayName,
            this.platform.feedAmount,
          );
        } catch (err) {
          this.platform.log.error(
            '[%s] feed failed: %s',
            accessory.displayName,
            String(err),
          );
          throw new this.platform.api.hap.HapStatusError(
            this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
          );
        } finally {
          // Flip the momentary switch back off shortly after.
          setTimeout(() => {
            feedSwitch.updateCharacteristic(Characteristic.On, false);
          }, 1000);
        }
      });
  }
}
