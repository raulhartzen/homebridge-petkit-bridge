import { PlatformAccessory } from 'homebridge';
import { PetkitBridgePlatform } from '../platform';

/**
 * Fountain -> a Leak Sensor (LeakDetected fires when the fountain lacks
 * water) plus a Battery service (level + low-battery flag), fed by the
 * bridge's /hk-state endpoint, polled on an interval.
 */
export class FountainAccessory {
  constructor(
    private readonly platform: PetkitBridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const { Service, Characteristic } = platform;
    const device = accessory.context.device;

    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'PetKit (via petkit-bridge)')
      .setCharacteristic(Characteristic.Model, String(device.type ?? 'fountain'))
      .setCharacteristic(Characteristic.SerialNumber, String(device.id));

    const leak =
      accessory.getService(Service.LeakSensor) ||
      accessory.addService(Service.LeakSensor, accessory.displayName);

    const battery =
      accessory.getService(Service.Battery) ||
      accessory.addService(Service.Battery, `${accessory.displayName} Battery`);

    battery.setCharacteristic(
      Characteristic.ChargingState,
      Characteristic.ChargingState.NOT_CHARGEABLE,
    );

    const poll = async () => {
      try {
        const st = await this.platform.client.getFountainHkState(device.id);
        leak.updateCharacteristic(
          Characteristic.LeakDetected,
          st.LeakDetected
            ? Characteristic.LeakDetected.LEAK_DETECTED
            : Characteristic.LeakDetected.LEAK_NOT_DETECTED,
        );
        leak.updateCharacteristic(
          Characteristic.StatusFault,
          st.StatusFault
            ? Characteristic.StatusFault.GENERAL_FAULT
            : Characteristic.StatusFault.NO_FAULT,
        );
        if (typeof st.BatteryLevel === 'number') {
          battery.updateCharacteristic(
            Characteristic.BatteryLevel,
            Math.min(100, Math.max(0, st.BatteryLevel)),
          );
        }
        battery.updateCharacteristic(
          Characteristic.StatusLowBattery,
          st.LowBattery
            ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
        );
      } catch (err) {
        this.platform.log.debug(
          '[%s] hk-state poll failed: %s',
          accessory.displayName,
          String(err),
        );
      }
    };
    void poll();
    setInterval(poll, this.platform.pollInterval * 1000);
  }
}
