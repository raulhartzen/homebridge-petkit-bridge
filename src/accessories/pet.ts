import { PlatformAccessory } from 'homebridge';
import { PetkitBridgePlatform } from '../platform';

/**
 * Per-pet virtual Motion Sensor: triggered when the events feed reports a
 * litter-box visit (or, if PetKit's pet detection is enabled on a camera
 * feeder, an attributed meal) for this pet. Motion stays active for
 * `motionResetSeconds`, then clears — enough for Home app notifications
 * and automations ("notify me when Milù uses the litter box").
 */
export class PetSensorAccessory {
  private resetTimer?: NodeJS.Timeout;

  constructor(
    private readonly platform: PetkitBridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const { Service, Characteristic } = platform;
    const device = accessory.context.device;

    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'petkit-bridge')
      .setCharacteristic(Characteristic.Model, 'pet activity sensor')
      .setCharacteristic(Characteristic.SerialNumber, String(device.id));

    const motion =
      accessory.getServiceById(Service.MotionSensor, 'activity') ||
      accessory.addService(Service.MotionSensor, accessory.displayName, 'activity');
    motion.setCharacteristic(Characteristic.Name, accessory.displayName);

    this.motion = motion;
  }

  private motion;

  /** Fires the sensor; clears after the configured reset window. */
  trigger(detail: string): void {
    const { Characteristic } = this.platform;
    this.platform.log.info(
      '[%s] activity: %s',
      this.accessory.displayName,
      detail,
    );
    this.motion.updateCharacteristic(Characteristic.MotionDetected, true);
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
    }
    this.resetTimer = setTimeout(() => {
      this.motion.updateCharacteristic(Characteristic.MotionDetected, false);
    }, this.platform.motionResetSeconds * 1000);
  }
}
