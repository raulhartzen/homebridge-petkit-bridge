# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
