<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/raulhartzen/homebridge-petkit-bridge@main/assets/banner.svg" alt="homebridge-petkit-bridge — petkit-bridge to Apple HomeKit" width="820">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/homebridge-petkit-bridge"><img src="https://img.shields.io/npm/v/homebridge-petkit-bridge?label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/homebridge-petkit-bridge"><img src="https://img.shields.io/npm/dm/homebridge-petkit-bridge" alt="npm downloads"></a>
  <img src="https://img.shields.io/badge/works%20with-Homebridge-6f42c1" alt="Works with Homebridge">
  <img src="https://img.shields.io/badge/Apple-HomeKit-0b84fe" alt="Apple HomeKit">
  <img src="https://img.shields.io/badge/status-alpha-orange" alt="Status alpha">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License">
</p>

# homebridge-petkit-bridge

Homebridge plugin for [petkit-bridge](https://github.com/raulhartzen/petkit-bridge): brings PetKit feeders, litter boxes and water fountains into Apple HomeKit — accessories are discovered and created automatically.

> **Status: alpha.** The plugin compiles and follows the standard Homebridge dynamic-platform API, but has not yet been battle-tested. Try it, and open an issue if something misbehaves.

## How it works

This plugin does **not** talk to the PetKit cloud. It talks to your local [petkit-bridge](https://github.com/raulhartzen/petkit-bridge) instance, which handles the cloud session (including automatic re-login when it expires). Run the bridge first; then this plugin discovers your devices through it and exposes them as HomeKit accessories:

- **Feeders** → a momentary "Feed" switch (turn on to dispense; usable in automations and Siri)
- **Litter boxes** → a momentary "Clean" switch plus a stateful "Maintenance" switch kept in sync with the real device state
- **Fountains** → a Leak Sensor (fires when water is low) and a Battery service (level + low-battery alert)

Unsupported device types are skipped with a log line — open an issue with your device's raw dump to add support.

## Requirements

- A running [petkit-bridge](https://github.com/raulhartzen/petkit-bridge) instance on your network
- Homebridge >= 1.6, Node.js >= 18

## Installation

From the Homebridge UI, search for `homebridge-petkit-bridge`, or:

```bash
npm install -g homebridge-petkit-bridge
```

## Configuration

Via the Homebridge UI (recommended), or manually in `config.json`:

```json
{
  "platforms": [
    {
      "platform": "PetkitBridge",
      "bridgeUrl": "http://192.168.1.10:8787",
      "token": "YOUR_BRIDGE_TOKEN",
      "pollInterval": 60,
      "feedAmount": 1
    }
  ]
}
```

| Option | Default | Description |
|---|---|---|
| `bridgeUrl` | — | Base URL of your petkit-bridge instance |
| `token` | — | The `BRIDGE_TOKEN` from your bridge's `.env` |
| `pollInterval` | `60` | Seconds between state refreshes (min 15) |
| `feedAmount` | `1` | Portions dispensed by the Feed switch |

## Development

```bash
npm install
npm run build     # or: npm run watch
```

To test against a local Homebridge without publishing: `npm link` in this folder, then `npm link homebridge-petkit-bridge` in your Homebridge folder (or install by path).

## License

MIT
