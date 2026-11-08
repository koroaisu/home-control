// One device-list request per plugin, shared by labels and open property inspectors.
export class DeviceCatalog {
  constructor(bridge, onUpdate, {schedule = setTimeout, cancel = clearTimeout, interval = 60000} = {}) {
    Object.assign(this, {bridge, onUpdate, schedule, cancel, interval});
    this.devices = null;
    this.inFlight = null;
    this.timer = undefined;
    this.started = false;
    this.closed = false;
  }

  async get(force = false) {
    if (this.inFlight) return this.inFlight;
    if (!force && this.devices) return this.devices;
    const request = async () => {
      const result = await this.bridge.api('/api/v1/devices?refresh=1');
      if (!Array.isArray(result.devices) || result.devices.some(d => typeof d.id !== 'string' || typeof d.name !== 'string' || typeof d.provider !== 'string')) {
        throw new Error('機器一覧を取得できませんでした');
      }
      this.devices = result.devices;
      if (!this.closed) this.onUpdate(this.devices);
      return this.devices;
    };
    this.inFlight = request();
    try {return await this.inFlight;} finally {this.inFlight = null;}
  }

  async tick() {
    try {await this.get(true);} catch { /* Keep the last good names and retry at the next interval. */ }
    finally {
      if (this.started && !this.closed) this.timer = this.schedule(() => this.tick(), this.interval);
    }
  }

  start() {
    if (this.started) return this.tickPromise;
    this.started = true;
    this.closed = false;
    this.tickPromise = this.tick();
    return this.tickPromise;
  }

  stop() {
    this.started = false;
    this.closed = true;
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
  }
}
