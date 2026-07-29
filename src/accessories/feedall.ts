import { PlatformAccessory } from 'homebridge';
import { PetkitBridgePlatform } from '../platform';

/**
 * Virtual "Feed All" accessory: one momentary switch that dispenses on
 * every single-hopper feeder at once via the bridge's /feed-all endpoint.
 * Created only when at least two feeders are discovered (with a single
 * feeder it would just duplicate its Feed switch).
 * Partial success does not fail the switch (food WAS dispensed somewhere);
 * per-feeder failures are logged as warnings. Only a total failure throws.
 */
export class FeedAllAccessory {
  constructor(
    private readonly platform: PetkitBridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const { Service, Characteristic } = platform;

    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'petkit-bridge')
      .setCharacteristic(Characteristic.Model, 'virtual feed-all')
      .setCharacteristic(Characteristic.SerialNumber, 'feed-all');

    const name = platform.feedAllName;
    const feedAllSwitch =
      accessory.getServiceById(Service.Switch, 'feedall') ||
      accessory.addService(Service.Switch, name, 'feedall');
    feedAllSwitch.setCharacteristic(Characteristic.Name, name);
    feedAllSwitch.addOptionalCharacteristic(Characteristic.ConfiguredName);
    feedAllSwitch.setCharacteristic(Characteristic.ConfiguredName, name);

    feedAllSwitch
      .getCharacteristic(Characteristic.On)
      .onGet(() => false)
      .onSet(async (value) => {
        if (!value) {
          return;
        }
        try {
          const report = await this.platform.client.feedAll(
            this.platform.feedAmount,
          );
          const ok = report.results.filter((r) => r.ok);
          const failed = report.results.filter((r) => !r.ok);
          for (const f of failed) {
            this.platform.log.warn(
              '[%s] feeder "%s" failed: %s',
              accessory.displayName,
              f.name ?? f.id,
              f.error ?? 'unknown error',
            );
          }
          if (ok.length === 0) {
            throw new Error('no feeder dispensed');
          }
          this.platform.log.info(
            '[%s] dispensed on %d feeder(s)%s',
            accessory.displayName,
            ok.length,
            failed.length ? ` (${failed.length} failed)` : '',
          );
        } catch (err) {
          this.platform.log.error(
            '[%s] feed-all failed: %s',
            accessory.displayName,
            String(err),
          );
          throw new this.platform.api.hap.HapStatusError(
            this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
          );
        } finally {
          setTimeout(() => {
            feedAllSwitch.updateCharacteristic(Characteristic.On, false);
          }, 1000);
        }
      });
  }
}
