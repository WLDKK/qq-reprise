export class ConnectionWatchdog {
  constructor(client, options = {}) {
    this.client = client;
    this.intervalMs = options.intervalMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.failureLimit = options.failureLimit ?? 2;
    this.onHealthy = options.onHealthy || (() => {});
    this.onProbeFailure = options.onProbeFailure || (() => {});
    this.onDisconnect = options.onDisconnect || (() => {});
    this.failures = 0;
    this.stopped = false;
    this.inFlight = false;
    this.timer = null;
  }
  start() {
    if (!this.timer && !this.stopped) {
      this.timer = setInterval(() => { void this.check(); }, this.intervalMs);
      this.timer.unref?.();
    }
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
  }
  disconnect(message) {
    this.onDisconnect(message);
    this.stop();
    this.client.close();
  }
  async check() {
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;
    let timeout;
    try {
      const status = await Promise.race([
        this.client.call('get_status'),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('status_timeout')), this.timeoutMs); }),
      ]);
      if (this.stopped) return;
      if (status?.online === false) {
        this.disconnect('只读心跳确认 QQ 已离线，正在等待原消息接口恢复。');
      } else if (status?.online === true) {
        this.failures = 0;
        this.onHealthy();
      } else {
        throw new Error('invalid_status');
      }
    } catch {
      if (this.stopped) return;
      this.failures++;
      this.onProbeFailure(this.failures);
      if (this.failures >= this.failureLimit) this.disconnect('只读状态查询连续失败，关闭失效连接后退避重连；不重发旧消息。');
    } finally {
      clearTimeout(timeout);
      this.inFlight = false;
    }
  }
}
