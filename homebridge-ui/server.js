'use strict';

// Custom UI backend for the Homebridge config screen.
//   /discover  probes the usual addresses for a running bridge (no token
//              needed: /healthz is unauthenticated) so users who already
//              installed the bridge do not have to type anything.
//   /test      calls /devices with the values currently in the form, so the
//              URL and token can be verified before saving.
const os = require('os');
const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');

const TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 1200;
const DEFAULT_PORT = 8787;

function normalizeUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) {
    return '';
  }
  if (!/^https?:\/\//i.test(url)) {
    url = 'http://' + url;
  }
  return url.replace(/\/+$/, '');
}

class PetkitBridgeUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/discover', this.discover.bind(this));
    this.onRequest('/test', this.testConnection.bind(this));
    this.onRequest('/cameras', this.checkCameras.bind(this));
    this.ready();
  }

  /** Addresses worth probing: loopback plus this host's own LAN addresses. */
  candidateUrls() {
    const hosts = ['127.0.0.1'];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const addr of ifaces[name] || []) {
        if (addr.family === 'IPv4' && !addr.internal && !hosts.includes(addr.address)) {
          hosts.push(addr.address);
        }
      }
    }
    return hosts.map((h) => `http://${h}:${DEFAULT_PORT}`);
  }

  /** Is there a petkit-bridge answering at this URL? */
  async probe(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(url + '/healthz', { signal: controller.signal });
      if (!res.ok && res.status !== 503) {
        return null;
      }
      const body = await res.json();
      // /healthz always reports these two fields; anything else is not us.
      if (typeof body !== 'object' || body === null || !('session_ok' in body)) {
        return null;
      }
      return { url, sessionOk: Boolean(body.session_ok) };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async discover() {
    const results = await Promise.all(this.candidateUrls().map((u) => this.probe(u)));
    const found = results.filter(Boolean);
    return { found };
  }

  /**
   * Check the video half of the chain: is go2rtc up, and are the camera
   * streams already registered on it? Called only when cameras are enabled.
   * cameraIds are the device ids the bridge reported as having a camera.
   */
  async checkCameras({ go2rtcUrl, cameraIds } = {}) {
    const url = normalizeUrl(go2rtcUrl) || 'http://127.0.0.1:1984';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url + '/api/streams', { signal: controller.signal });
      if (!res.ok) {
        throw new RequestError(`go2rtc answered HTTP ${res.status} at ${url}.`, { status: res.status });
      }
      const streams = await res.json();
      if (typeof streams !== 'object' || streams === null || Array.isArray(streams)) {
        throw new RequestError(
          `Something is listening at ${url}, but it does not look like go2rtc.`,
          { status: 502 },
        );
      }
      const names = Object.keys(streams);
      const ids = Array.isArray(cameraIds) ? cameraIds.map(String) : [];
      const registered = ids.filter((id) => names.includes(`petkit_${id}`));
      return {
        url,
        totalStreams: names.length,
        expected: ids.length,
        registered: registered.length,
      };
    } catch (err) {
      if (err instanceof RequestError) {
        throw err;
      }
      const reason = err && err.name === 'AbortError'
        ? `no answer within ${TIMEOUT_MS / 1000}s`
        : (err && err.message) || String(err);
      throw new RequestError(
        `go2rtc is not reachable at ${url} (${reason}). Camera streaming needs it: `
        + 'start the go2rtc service (it is part of the bridge\'s docker-compose file) '
        + 'or correct the go2rtc URL below.',
        { status: 502 },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async testConnection({ bridgeUrl, token } = {}) {
    const url = normalizeUrl(bridgeUrl);
    if (!url) {
      throw new RequestError('Enter the bridge URL first.', { status: 400 });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url + '/devices', {
        headers: { 'X-Auth-Token': String(token || '') },
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        throw new RequestError(
          'The bridge is reachable, but it rejected the token. It must match the '
          + 'BRIDGE_TOKEN value you set when deploying the bridge — you can read it '
          + 'back from the bridge\'s environment configuration.',
          { status: res.status },
        );
      }
      if (!res.ok) {
        throw new RequestError(`The bridge answered HTTP ${res.status}.`, { status: res.status });
      }
      const devices = await res.json();
      if (!Array.isArray(devices)) {
        throw new RequestError('Unexpected reply: this does not look like petkit-bridge.', { status: 502 });
      }
      return {
        url,
        devices: devices.map((d) => ({
          id: d.id,
          name: d.name || `Device ${d.id}`,
          type: d.type || 'unknown',
          camera: Boolean(d.camera),
        })),
      };
    } catch (err) {
      if (err instanceof RequestError) {
        throw err;
      }
      const reason = err && err.name === 'AbortError'
        ? `no answer within ${TIMEOUT_MS / 1000}s`
        : (err && err.message) || String(err);
      throw new RequestError(
        `Could not reach the bridge at ${url} (${reason}). Is it running, and is `
        + 'the address reachable from the machine Homebridge runs on?',
        { status: 502 },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

(() => new PetkitBridgeUiServer())();
