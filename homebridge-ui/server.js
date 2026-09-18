'use strict';

// Custom UI backend for the Homebridge config screen.
// Exposes a single request handler, /test, that calls the bridge's
// /devices endpoint with the values currently typed into the form, so
// users can verify URL and token before saving.
const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');

const TIMEOUT_MS = 8000;

class PetkitBridgeUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/test', this.testConnection.bind(this));
    this.ready();
  }

  async testConnection({ bridgeUrl, token } = {}) {
    let url = String(bridgeUrl || '').trim();
    if (!url) {
      throw new RequestError('Enter the bridge URL first.', { status: 400 });
    }
    if (!/^https?:\/\//i.test(url)) {
      url = 'http://' + url;
    }
    url = url.replace(/\/+$/, '');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url + '/devices', {
        headers: { 'X-Auth-Token': String(token || '') },
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        throw new RequestError(
          'The bridge is reachable, but it rejected the token. Check BRIDGE_TOKEN in the bridge\'s .env.',
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
        `Could not reach the bridge at ${url} (${reason}). Is it running, and is the URL correct from this machine?`,
        { status: 502 },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

(() => new PetkitBridgeUiServer())();
