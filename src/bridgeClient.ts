/**
 * Thin HTTP client for the petkit-bridge local API.
 * https://github.com/raulhartzen/petkit-bridge
 *
 * Uses the global fetch available in Node.js 18+.
 */

export interface BridgeDevice {
  camera?: boolean;
  id: number | string;
  name?: string;
  type?: string;
}

export interface BridgeEvent {
  source: 'litter' | 'feeder';
  type: string | number | null;
  pet_id: number | string | null;
  pet_name: string | null;
  weight_g: number | null;
  start: number | null;
  end: number | null;
  timestamp: number;
  event_id: string | null;
}

export interface FountainHkState {
  LeakDetected?: number;
  BatteryLevel?: number;
  LowBattery?: number;
  StatusFault?: number;
  PowerOn?: number;
}

export class BridgeClient {
  constructor(
    public readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 10000,
  ) {
    // Be lenient: add the scheme if missing, drop trailing slashes.
    let url = baseUrl.trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\//i.test(url)) {
      url = `http://${url}`;
    }
    this.baseUrl = url;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'X-Auth-Token': this.token,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`bridge ${method} ${path} -> HTTP ${res.status} ${text}`);
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        return (await res.json()) as T;
      }
      return (await res.text()) as unknown as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /devices — list of discovered devices. */
  async getDevices(): Promise<BridgeDevice[]> {
    const data = await this.request<unknown>('GET', '/devices');
    // The bridge may return either a bare array or an object wrapping it;
    // accept both shapes defensively.
    if (Array.isArray(data)) {
      return data as BridgeDevice[];
    }
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      for (const key of ['devices', 'items', 'result']) {
        if (Array.isArray(obj[key])) {
          return obj[key] as BridgeDevice[];
        }
      }
    }
    throw new Error('unexpected /devices response shape');
  }

  /** GET /device/{id}/events — normalized event feed (newest first). */
  async getEvents(
    id: number | string,
    since: number,
  ): Promise<BridgeEvent[]> {
    const data = await this.request<{ events: BridgeEvent[] }>(
      'GET',
      `/device/${id}/events?since=${since}&limit=100`,
    );
    return data.events ?? [];
  }

  /** GET /device/{id}/hk-state — fountain state in HomeKit-friendly format. */
  async getFountainHkState(id: number | string): Promise<FountainHkState> {
    return this.request<FountainHkState>('GET', `/device/${id}/hk-state`);
  }

  /** GET /device/{id}/maint-status — '1' if in maintenance, '0' otherwise. */
  async getMaintStatus(id: number | string): Promise<boolean> {
    const text = await this.request<string>('GET', `/device/${id}/maint-status`);
    return String(text).trim() === '1';
  }

  /** POST /device/{id}/feed — dispense food. */
  async feed(id: number | string, amount: number): Promise<void> {
    await this.request('POST', `/device/${id}/feed`, { amount });
  }

  /**
   * POST /feed-all — dispense on every single-hopper feeder at once.
   * Returns the bridge's per-feeder outcome report.
   */
  async feedAll(
    amount: number,
  ): Promise<{ all_ok: boolean; results: Array<{ id: string; name?: string; ok: boolean; amount?: number; error?: string }> }> {
    return this.request('POST', '/feed-all', { amount });
  }

  /** POST /device/{id}/clean — start a cleaning cycle (START only; may not stop on its own). */
  async clean(id: number | string): Promise<void> {
    await this.request('POST', `/device/${id}/clean`, { mode: 'CLEANING' });
  }

  /**
   * POST /device/{id}/scoop — run ONE complete scooping cycle: the bridge
   * sends START, waits (~50s by default, tuned on the Puramax 2), then
   * sends END from a background task. This is the right call for a
   * momentary "Clean" button: unlike /clean, the cycle stops on its own.
   */
  async scoop(id: number | string, wait?: number): Promise<void> {
    await this.request(
      'POST',
      `/device/${id}/scoop`,
      wait !== undefined ? { wait } : {},
    );
  }

  /** POST /device/{id}/litter — flexible action/mode control. */
  async litter(
    id: number | string,
    action: string,
    mode: string,
  ): Promise<void> {
    await this.request('POST', `/device/${id}/litter`, { action, mode });
  }
}
