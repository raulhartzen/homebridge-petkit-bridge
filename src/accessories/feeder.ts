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

    const feedName = platform.feedName;
    // Look up by stable subtype ('feed'), never by display name: the name
    // is configurable and must be free to change between restarts.
    const feedSwitch =
      accessory.getServiceById(Service.Switch, 'feed') ||
      accessory.getService('Feed') ||  // legacy pre-0.3.0 cached accessories
      accessory.addService(Service.Switch, feedName, 'feed');
    feedSwitch.setCharacteristic(Characteristic.Name, feedName);
    feedSwitch.addOptionalCharacteristic(Characteristic.ConfiguredName);
    feedSwitch.setCharacteristic(Characteristic.ConfiguredName, feedName);

    feedSwitch
      .getCharacteristic(Characteristic.On)
      .onGet(() => false)
      .onSet(async (value) => {
        if (!value) {
          return;
        }
        try {
          await this.dispense(accessory, device);
        } finally {
          // Flip the momentary switch back off shortly after.
          setTimeout(() => {
            feedSwitch.updateCharacteristic(Characteristic.On, false);
          }, 1000);
        }
      });
  }

  /**
   * Dispenses food. If the bridge rejects the configured amount, the error
   * lists the model's valid values (e.g. d4h only accepts 10..50): parse
   * them and retry once with the smallest, so the button works out of the
   * box on any model. A log line suggests fixing "feedAmount" in config.
   */
  private async dispense(
    accessory: PlatformAccessory,
    device: { id: number | string },
  ): Promise<void> {
    const amount = this.platform.feedAmount;
    try {
      await this.platform.client.feed(device.id, amount);
      this.platform.log.info(
        '[%s] feed dispensed (amount=%d)',
        accessory.displayName,
        amount,
      );
      return;
    } catch (err) {
      const fallback = this.extractSmallestValidAmount(String(err));
      if (fallback === undefined || fallback === amount) {
        this.platform.log.error(
          '[%s] feed failed: %s',
          accessory.displayName,
          String(err),
        );
        throw new this.platform.api.hap.HapStatusError(
          this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        );
      }
      this.platform.log.warn(
        '[%s] amount=%d rejected by the bridge; retrying with %d. ' +
          'Set "feedAmount" to a valid value in the plugin config to silence this.',
        accessory.displayName,
        amount,
        fallback,
      );
      try {
        await this.platform.client.feed(device.id, fallback);
        this.platform.log.info(
          '[%s] feed dispensed (amount=%d)',
          accessory.displayName,
          fallback,
        );
      } catch (err2) {
        this.platform.log.error(
          '[%s] feed retry failed: %s',
          accessory.displayName,
          String(err2),
        );
        throw new this.platform.api.hap.HapStatusError(
          this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        );
      }
    }
  }

  /**
   * Pulls the smallest valid amount out of a bridge error message like
   * {"error": "...", "valid_values": [10, 20, 30]} (or the Italian
   * "valori_validi" from older bridge builds).
   */
  private extractSmallestValidAmount(message: string): number | undefined {
    const m = message.match(/(?:valid_values|valori_validi)"?\s*:\s*\[([\d,\s]+)\]/);
    if (!m) {
      return undefined;
    }
    const values = m[1]
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    return values.length ? Math.min(...values) : undefined;
  }
}
