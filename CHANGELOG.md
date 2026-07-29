# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.6.0] - 2026-07-29

### Added
- **Native HomeKit cameras** (`enableCameras`, default off — experimental):
  camera-equipped devices are exposed as HomeKit cameras with live view in
  the Home app. The plugin auto-registers each device's WHEP stream on
  go2rtc via its API (nothing to add to `go2rtc.yaml`) and streams to
  HomeKit through ffmpeg (H.264 passthrough by default). Snapshots come
  from go2rtc's frame endpoint. Cameras are published as external
  accessories and pair individually.
- Config: `go2rtcUrl`, `cameraVcodec`, `ffmpegPath`.
- Requires petkit-bridge >= 1.3.0 (camera capability flag) plus a running
  go2rtc instance and ffmpeg on the Homebridge host.

### Notes
- v1 scope: video only (no audio, no HomeKit Secure Video).
- The manual go2rtc + homebridge-camera-ffmpeg recipe in the bridge README
  remains a supported alternative.

## [0.5.0] - 2026-07-29

### Added
- **Pet activity sensors** (`enablePetSensors`, default on): a Motion
  Sensor per pet — auto-discovered from your PetKit account — fires when
  that pet uses the litter box, with the visit weight in the log.
  Enables notifications and automations per pet.
- **Meal sensors** (`enableMealSensors`, `mealSensorName`): camera feeders
  get a Motion Sensor fired when an eating session is detected. If PetKit
  pet detection is enabled on the feeder, attributed meals also fire the
  pet's own sensor.
- `motionResetSeconds` config: how long sensors stay triggered (default 30).
- Requires petkit-bridge >= 1.2.0 (new `/device/{id}/events` endpoint).

### Notes
- Events are polled with `pollInterval`, so sensors fire up to ~1 minute
  after the physical event — designed for notifications and automations,
  not for real-time presence.
- History is never replayed: only events newer than plugin startup fire.

## [0.4.0] - 2026-07-29

### Added
- **"Feed All" virtual switch** (`enableFeedAll`, default on; `feedAllName`
  for the display/Siri name): one tap dispenses on every single-hopper
  feeder via the bridge's `/feed-all` endpoint. Created only when at least
  two feeders are discovered. Partial failures are logged per feeder
  without failing the switch; only a total failure reports an error.

## [0.3.0] - 2026-07-28

### Added
- **Configurable switch names** (`feedName`, `cleanName`, `maintenanceName`):
  set the display names the Home app shows and Siri responds to, in your own
  language (e.g. "Pulisci lettiera" instead of "Clean"). Empty values fall
  back to the English defaults.

### Changed
- Services are now looked up by their stable subtype instead of their
  display name, so renaming never creates duplicate switches. Existing
  cached accessories are migrated transparently.

## [0.2.3] - 2026-07-28

### Changed
- The unsupported-device log hint now reminds users to redact serial
  numbers, MAC addresses and Wi-Fi fields before posting raw device dumps
  in public issues.

## [0.2.2] - 2026-07-28

### Added
- **Discovery retry with exponential backoff** (30s → 60s → 120s → 240s,
  then every 5 minutes): if petkit-bridge is unreachable when Homebridge
  starts (e.g. boot-order race after a power outage), the plugin no longer
  gives up until a manual restart — accessories appear as soon as the
  bridge is back. Completes the end-to-end self-healing design: the bridge
  already recovers its cloud session on its own; now the plugin recovers
  its connection to the bridge on its own too.

## [0.2.1] - 2026-07-28

Compliance fixes for the Homebridge verification automated checks
(no functional changes).

### Fixed
- `package.json`: added the `supports-hap` keyword (transport declaration).
- `config.schema.json`: `required` is now a proper JSON Schema array at the
  object level instead of boolean flags on individual fields.
- `config.schema.json`: added the standard `name` platform property.
- Reworded the token field description (documentation-only change).

## [0.2.0] - 2026-07-28

**Status promoted from alpha to beta** — all features field-tested on real
hardware: Yumshare (dual hopper), Puramax 2, two Eversweet fountains.

### Fixed
- Maintenance switch is now properly stateful: optimistic state update on
  toggle (reverts only on failure) plus a 90s polling grace period after
  manual commands, so the switch no longer flips back during the device's
  mode transition (which used to cause double-START "Device in operation"
  errors).
- Silenced the HAP "Characteristic not in required or optional section"
  warning by declaring `ConfiguredName` as an optional characteristic.

### Changed
- Scoop log line now includes the cycle duration ("will stop on its own
  in ~50s").
- README: universal explanation of where the bridge token comes from,
  regardless of how petkit-bridge was deployed.

## [0.1.4] - 2026-07-28 *(unpublished, folded into 0.2.0)*

Internal iteration during field testing.

## [0.1.3] - 2026-07-28

### Fixed
- **Litter "Clean" now runs a self-terminating cycle** via the bridge's
  `/scoop` endpoint (START, wait ~50s, END) instead of `/clean`, which only
  sent START and left the litter box cycling forever.
- **Feed works out of the box on any model**: default amount raised to 10
  and, if the bridge rejects the configured amount, the plugin parses the
  valid values from the error response and retries once with the smallest.
- Explicit service names (`Clean`, `Maintenance`, `Feed`) via
  `ConfiguredName`, so the two litter switches are distinguishable in the
  Home app.

### Added
- `scoopWait` config option to tune the scoop cycle duration.

## [0.1.2] - 2026-07-28

### Fixed
- Device classification now matches the category strings actually reported
  by the bridge (`feeder`, `litter`, `waterfountain`), so litter boxes and
  fountains are registered. Model codes kept as fallback.
- Pets and purifiers are ignored quietly instead of logging an
  "unsupported type" warning.
- Bridge URL without a scheme (e.g. `192.168.1.10:8787`) is now accepted:
  `http://` is added automatically.

## [0.1.0] - 2026-07-28

Initial release: dynamic platform with auto-discovery from petkit-bridge.
Feeders as momentary Feed switches, litter boxes as Clean + Maintenance
switches, fountains as Leak Sensor + Battery.
