import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { BridgeClient, BridgeDevice } from './bridgeClient';
import { FeederAccessory } from './accessories/feeder';
import { LitterAccessory } from './accessories/litter';
import { FountainAccessory } from './accessories/fountain';

/**
 * Device-type classification. The bridge's /devices endpoint reports
 * category strings ("feeder", "litter", "waterfountain", ...) — verified
 * in the field on petkit-bridge 1.x. Model codes are kept as a fallback.
 * Non-controllable entries (pets, purifiers) are ignored quietly.
 */
const FEEDER_TYPES = new Set(['feeder', 'feedermini', 'd3', 'd4', 'd4h', 'd4s', 'd4sh']);
const LITTER_TYPES = new Set(['litter', 'litterbox', 't3', 't4', 't5', 't6', 't7']);
const FOUNTAIN_TYPES = new Set(['waterfountain', 'fountain', 'ctw2', 'ctw3', 'w5']);
const IGNORED_TYPES = new Set(['pet', 'purifier']);

export interface PetkitBridgeConfig extends PlatformConfig {
  bridgeUrl?: string;
  token?: string;
  pollInterval?: number;
  feedAmount?: number;
}

export class PetkitBridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly client: BridgeClient;
  public readonly pollInterval: number;
  public readonly feedAmount: number;

  /** Accessories restored from cache, keyed by UUID. */
  private readonly cached = new Map<string, PlatformAccessory>();
  /** UUIDs seen during the last discovery (to unregister stale ones). */
  private readonly seen = new Set<string>();

  constructor(
    public readonly log: Logger,
    public readonly config: PetkitBridgeConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    const bridgeUrl = config.bridgeUrl ?? '';
    const token = config.token ?? '';
    this.pollInterval = Math.max(15, Number(config.pollInterval ?? 60));
    this.feedAmount = Math.max(1, Number(config.feedAmount ?? 1));
    this.client = new BridgeClient(bridgeUrl, token);

    if (!bridgeUrl || !token) {
      this.log.error(
        'Missing "bridgeUrl" or "token" in platform config; the plugin will not start.',
      );
      return;
    }

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices().catch((err) => {
        this.log.error('Device discovery failed: %s', String(err));
        this.log.error(
          'Check that petkit-bridge is reachable at %s and the token is correct.',
          bridgeUrl,
        );
      });
    });
  }

  /** Called by Homebridge for each accessory restored from disk cache. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  private async discoverDevices(): Promise<void> {
    const devices = await this.client.getDevices();
    this.log.info('petkit-bridge reported %d device(s)', devices.length);

    for (const device of devices) {
      this.setupDevice(device);
    }

    // Unregister cached accessories that no longer exist on the bridge.
    const stale: PlatformAccessory[] = [];
    for (const [uuid, accessory] of this.cached) {
      if (!this.seen.has(uuid)) {
        stale.push(accessory);
        this.log.info('Removing stale accessory: %s', accessory.displayName);
      }
    }
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }

  private setupDevice(device: BridgeDevice): void {
    const type = String(device.type ?? '').toLowerCase();
    const name = device.name || `PetKit ${device.id}`;

    if (IGNORED_TYPES.has(type)) {
      this.log.debug('Ignoring "%s" (type "%s": not a controllable device)', name, type);
      return;
    }

    const uuid = this.api.hap.uuid.generate(`petkit-bridge:${device.id}`);
    this.seen.add(uuid);

    let accessory = this.cached.get(uuid);
    const isNew = !accessory;
    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid);
    }
    accessory.context.device = device;

    if (FEEDER_TYPES.has(type)) {
      new FeederAccessory(this, accessory);
    } else if (LITTER_TYPES.has(type)) {
      new LitterAccessory(this, accessory);
    } else if (FOUNTAIN_TYPES.has(type)) {
      new FountainAccessory(this, accessory);
    } else {
      this.log.warn(
        'Device "%s" has unsupported type "%s" — skipped. ' +
          'Open an issue with the output of /device/%s to add support.',
        name,
        type || '(none)',
        device.id,
      );
      return;
    }

    if (isNew) {
      this.log.info('Registering accessory: %s (%s)', name, type);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cached.set(uuid, accessory);
    } else {
      this.log.info('Restored accessory: %s (%s)', name, type);
      this.api.updatePlatformAccessories([accessory]);
    }
  }
}
