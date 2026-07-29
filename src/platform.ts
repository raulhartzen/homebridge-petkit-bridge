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
import { FeedAllAccessory } from './accessories/feedall';
import { PetSensorAccessory } from './accessories/pet';
import { CameraAccessory } from './accessories/camera';

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
  scoopWait?: number;
  feedName?: string;
  cleanName?: string;
  maintenanceName?: string;
  enableFeedAll?: boolean;
  feedAllName?: string;
  enablePetSensors?: boolean;
  enableMealSensors?: boolean;
  mealSensorName?: string;
  motionResetSeconds?: number;
  enableCameras?: boolean;
  go2rtcUrl?: string;
  cameraVcodec?: string;
  ffmpegPath?: string;
}

export class PetkitBridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly client: BridgeClient;
  public readonly pollInterval: number;
  public readonly feedAmount: number;
  public readonly scoopWait: number | undefined;
  public readonly feedName: string;
  public readonly cleanName: string;
  public readonly maintenanceName: string;
  public readonly enableFeedAll: boolean;
  public readonly feedAllName: string;
  public readonly enablePetSensors: boolean;
  public readonly enableMealSensors: boolean;
  public readonly mealSensorName: string;
  public readonly motionResetSeconds: number;
  public readonly enableCameras: boolean;
  public readonly go2rtcUrl: string;
  public readonly go2rtcRtspBase: string;
  public readonly cameraVcodec: string;
  public readonly ffmpegPath: string;
  private readonly publishedCameras = new Set<string>();

  /** Pet sensors by pet id, fed by the events poller. */
  private readonly petSensors = new Map<string, PetSensorAccessory>();
  /** Feeder handlers by device id, for meal-sensor triggers. */
  private readonly feeders = new Map<string, FeederAccessory>();
  /** Litter device ids to poll for events. */
  private readonly litterIds: Array<number | string> = [];
  /** Per-device watermark: only events newer than this fire sensors. */
  private readonly eventWatermark = new Map<string, number>();

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
    // Default 10: the smallest amount accepted by common PetKit feeders
    // (e.g. d4h validates against [10, 20, 30, 40, 50]).
    this.feedAmount = Math.max(1, Number(config.feedAmount ?? 10));
    // Seconds the bridge waits before ending a scoop cycle; undefined
    // means "use the bridge default" (~50s, tuned on the Puramax 2).
    this.scoopWait = config.scoopWait !== undefined ? Number(config.scoopWait) : undefined;
    // Configurable switch names (what the Home app shows and Siri responds
    // to). Empty/whitespace values fall back to the English defaults.
    this.feedName = (config.feedName ?? '').trim() || 'Feed';
    this.cleanName = (config.cleanName ?? '').trim() || 'Clean';
    this.maintenanceName = (config.maintenanceName ?? '').trim() || 'Maintenance';
    this.enableFeedAll = config.enableFeedAll !== false;  // default: enabled
    this.feedAllName = (config.feedAllName ?? '').trim() || 'Feed All';
    this.enablePetSensors = config.enablePetSensors !== false;   // default on
    this.enableMealSensors = config.enableMealSensors !== false; // default on
    this.mealSensorName = (config.mealSensorName ?? '').trim() || 'Meal';
    this.motionResetSeconds = Math.max(5, Number(config.motionResetSeconds ?? 30));
    this.enableCameras = config.enableCameras === true;  // default OFF
    let g2r = (config.go2rtcUrl ?? '').trim().replace(/\/+$/, '');
    if (g2r && !/^https?:\/\//i.test(g2r)) {
      g2r = `http://${g2r}`;
    }
    this.go2rtcUrl = g2r || 'http://127.0.0.1:1984';
    // RTSP restream lives on the same host as go2rtc, default port 8554.
    this.go2rtcRtspBase = `rtsp://${new URL(this.go2rtcUrl).hostname}:8554`;
    this.cameraVcodec = (config.cameraVcodec ?? '').trim() || 'copy';
    this.ffmpegPath = (config.ffmpegPath ?? '').trim() || 'ffmpeg';
    this.client = new BridgeClient(bridgeUrl, token);

    if (!bridgeUrl || !token) {
      this.log.error(
        'Missing "bridgeUrl" or "token" in platform config; the plugin will not start.',
      );
      return;
    }

    this.api.on('didFinishLaunching', () => {
      this.tryDiscover(0);
    });
  }

  /**
   * Runs discovery, retrying with exponential backoff (30s, 60s, 120s,
   * 240s, then every 5 minutes) until the bridge answers. This makes the
   * plugin resilient to boot-order races (e.g. after a power outage,
   * Homebridge often starts before the machine running petkit-bridge):
   * instead of giving up until a manual restart, the accessories appear
   * as soon as the bridge is back.
   */
  private tryDiscover(attempt: number): void {
    this.discoverDevices()
      .then(() => {
        if (attempt > 0) {
          this.log.info(
            'Discovery succeeded after %d retr%s.',
            attempt,
            attempt === 1 ? 'y' : 'ies',
          );
        }
      })
      .catch((err) => {
        const delaySecs = Math.min(30 * 2 ** Math.min(attempt, 4), 300);
        this.log.error('Device discovery failed: %s', String(err));
        this.log.warn(
          'Check that petkit-bridge is reachable at %s and the token is correct. ' +
            'Retrying in %ds (attempt %d)...',
          this.config.bridgeUrl,
          delaySecs,
          attempt + 1,
        );
        setTimeout(() => this.tryDiscover(attempt + 1), delaySecs * 1000);
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

    // Virtual "Feed All" switch: only when enabled AND there are at least
    // two feeders (with one, it would duplicate its own Feed switch).
    // When disabled (or feeders drop below two) the stale-pruning below
    // removes any cached instance automatically.
    const feederCount = devices.filter((d) =>
      FEEDER_TYPES.has(String(d.type ?? '').toLowerCase()),
    ).length;
    if (this.enableFeedAll && feederCount >= 2) {
      this.setupFeedAll(feederCount);
    }

    this.startEventsPoller();

    if (this.enableCameras) {
      const cams = devices.filter((d) => d.camera === true);
      if (cams.length === 0) {
        this.log.warn(
          'enableCameras is on but the bridge reported no camera-equipped ' +
            'devices. petkit-bridge >= 1.3.0 is required for camera detection.',
        );
      }
      for (const cam of cams) {
        this.setupCamera(cam).catch((err) =>
          this.log.error('Camera setup failed for %s: %s', cam.name, String(err)),
        );
      }
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

  /**
   * Registers the device's WHEP stream on go2rtc (via its API — the
   * definition is not persisted, so it is re-registered at every
   * discovery) and publishes a native HomeKit camera as an EXTERNAL
   * accessory (cameras pair individually, like camera plugins do).
   */
  private async setupCamera(device: BridgeDevice): Promise<void> {
    const streamName = `petkit_${device.id}`;
    const src =
      `webrtc:${this.client.baseUrl}/device/${device.id}/whep` +
      `?token=${encodeURIComponent(String(this.config.token))}#format=whep`;
    const url =
      `${this.go2rtcUrl}/api/streams?name=${encodeURIComponent(streamName)}` +
      `&src=${encodeURIComponent(src)}`;
    const res = await fetch(url, {
      method: 'PUT',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      throw new Error(`go2rtc stream registration -> HTTP ${res.status}`);
    }

    const uuid = this.api.hap.uuid.generate(`petkit-bridge:camera:${device.id}`);
    if (this.publishedCameras.has(uuid)) {
      return; // already published in this runtime (discovery retry)
    }
    const name = `${device.name || device.id} Camera`;
    const accessory = new this.api.platformAccessory(
      name, uuid, this.api.hap.Categories.CAMERA,
    );
    accessory.context.device = device;
    new CameraAccessory(this, accessory, streamName);
    this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
    this.publishedCameras.add(uuid);
    this.log.info(
      'Published camera: %s — pair it separately in the Home app ' +
        '(Home > + > Add Accessory > More options). The Setup Code is ' +
        'printed by Homebridge below this line and is also shown in the ' +
        'Homebridge UI (it is your main bridge PIN).',
      name,
    );
  }

  private setupPet(device: BridgeDevice, name: string): void {
    const uuid = this.api.hap.uuid.generate(`petkit-bridge:pet:${device.id}`);
    this.seen.add(uuid);
    let accessory = this.cached.get(uuid);
    const isNew = !accessory;
    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid);
    }
    accessory.context.device = device;
    this.petSensors.set(String(device.id), new PetSensorAccessory(this, accessory));
    if (isNew) {
      this.log.info('Registering pet sensor: %s', name);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cached.set(uuid, accessory);
    } else {
      this.log.info('Restored pet sensor: %s', name);
      this.api.updatePlatformAccessories([accessory]);
    }
  }

  /**
   * Polls the bridge's /events feed and fires the virtual sensors.
   * The watermark starts at "now" so history is never replayed as fresh
   * motion on startup; only events newer than the last poll trigger.
   */
  private startEventsPoller(): void {
    if (!this.enablePetSensors && !this.enableMealSensors) {
      return;
    }
    const sources: Array<{ id: number | string; kind: 'litter' | 'feeder' }> = [
      ...this.litterIds.map((id) => ({ id, kind: 'litter' as const })),
      ...[...this.feeders.keys()].map((id) => ({ id, kind: 'feeder' as const })),
    ];
    if (sources.length === 0) {
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    for (const s of sources) {
      this.eventWatermark.set(String(s.id), now);
    }
    const poll = async () => {
      for (const s of sources) {
        const key = String(s.id);
        const since = this.eventWatermark.get(key) ?? now;
        try {
          const events = await this.client.getEvents(s.id, since);
          if (events.length === 0) {
            continue;
          }
          this.eventWatermark.set(
            key,
            Math.max(...events.map((e) => e.timestamp), since),
          );
          for (const e of events.reverse()) {
            if (s.kind === 'litter' && e.type === 'pet_out' && e.pet_id != null) {
              const sensor = this.petSensors.get(String(e.pet_id));
              const kg = e.weight_g != null ? ` (${(e.weight_g / 1000).toFixed(2)} kg)` : '';
              sensor?.trigger(`litter box visit${kg}`);
            } else if (s.kind === 'feeder' && e.type === 'eat') {
              this.feeders.get(key)?.triggerMeal('eating session detected');
              if (e.pet_id != null) {
                this.petSensors.get(String(e.pet_id))?.trigger('meal');
              }
            }
          }
        } catch (err) {
          this.log.debug('events poll failed for %s: %s', key, String(err));
        }
      }
    };
    setInterval(poll, this.pollInterval * 1000);
    this.log.info(
      'Events poller started (%d source(s), every %ds)',
      sources.length,
      this.pollInterval,
    );
  }

  private setupFeedAll(feederCount: number): void {
    const uuid = this.api.hap.uuid.generate('petkit-bridge:feed-all');
    this.seen.add(uuid);
    let accessory = this.cached.get(uuid);
    const isNew = !accessory;
    if (!accessory) {
      accessory = new this.api.platformAccessory(this.feedAllName, uuid);
    }
    new FeedAllAccessory(this, accessory);
    if (isNew) {
      this.log.info(
        'Registering virtual accessory: %s (dispenses on %d feeders)',
        this.feedAllName,
        feederCount,
      );
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cached.set(uuid, accessory);
    } else {
      this.log.info('Restored virtual accessory: %s', this.feedAllName);
      this.api.updatePlatformAccessories([accessory]);
    }
  }

  private setupDevice(device: BridgeDevice): void {
    const type = String(device.type ?? '').toLowerCase();
    const name = device.name || `PetKit ${device.id}`;

    if (type === 'pet' && this.enablePetSensors) {
      this.setupPet(device, name);
      return;
    }
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
      this.feeders.set(String(device.id), new FeederAccessory(this, accessory));
    } else if (LITTER_TYPES.has(type)) {
      new LitterAccessory(this, accessory);
      this.litterIds.push(device.id);
    } else if (FOUNTAIN_TYPES.has(type)) {
      new FountainAccessory(this, accessory);
    } else {
      this.log.warn(
        'Device "%s" has unsupported type "%s" — skipped. ' +
          'Open an issue with the output of /device/%s to add support ' +
          '(redact serial numbers, MAC addresses and Wi-Fi fields before posting).',
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
