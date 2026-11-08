import {
  VID,
  PID,
  USAGE_PAGE,
  USAGE,
  OP,
  STATUS_NAMES,
  packet,
  unpackPacket,
  encodeKey,
  decodeKey,
  encodeBinding,
  decodeBinding,
  validateProfile,
  decodeInfo,
  decodeStatus,
  CAP_SAVE_OUTPUT,
  integer,
  requireBindingCapability,
  requireKeyCapability,
} from "./protocol.mjs?v=studio-owlab1";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
// Native HID open/close promises are not cancellable. Share a per-object
// barrier across transport instances so a late cleanup cannot close a new
// owner's handle after the UI has released its browser lock.
const hidOperations = new WeakMap(), hidOwners = new WeakMap();
async function deviceOperation(device, fn) {
  while (hidOperations.has(device))
    await hidOperations.get(device).catch(() => {});
  const operation = Promise.resolve().then(fn);
  hidOperations.set(device, operation);
  try {
    return await operation;
  } finally {
    if (hidOperations.get(device) === operation) hidOperations.delete(device);
  }
}
const within = async (promise, timeout, message) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(Error(message), { timedOut: true })), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const manualRecovery = (message) =>
  Object.assign(Error(message), { manualRecovery: true });
export const compatible = (d) =>
  d.vendorId === VID &&
  d.productId === PID &&
  d.collections.some((c) => c.usagePage === USAGE_PAGE && c.usage === USAGE);
export class WebHIDTransport {
  demo = false;
  constructor(device, onDisconnect = () => {}, { hid = navigator.hid } = {}) {
    if (!compatible(device)) throw Error("허용되지 않은 HID collection");
    this.device = device;
    this.pending = null;
    this.onDisconnect = onDisconnect;
    this.hid = hid;
    this.saveIdentity = null;
    this.closed = false;
    this.handleReport = (e) => {
      if (e.reportId !== 0 || !this.pending) return;
      let p;
      try {
        p = unpackPacket(
          new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength),
        );
      } catch {
        return;
      }
      if (p.seq !== this.pending.seq || p.op !== this.pending.op) return;
      let done = this.pending;
      this.pending = null;
      clearTimeout(done.timer);
      done.resolve(p);
    };
    this.handleDisconnect = (e) => {
      if (e.device !== this.device) return;
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending.reject(Error("USB 연결 끊김; 변경 자동 재시도 안 함"));
        this.pending = null;
      }
      this.onDisconnect();
    };
    device.addEventListener("inputreport", this.handleReport);
    this.hid.addEventListener("disconnect", this.handleDisconnect);
  }
  async open(timeout = 5000) {
    const device = this.device;
    const opening = deviceOperation(device, async () => {
      if (this.closed || device !== this.device) throw Error("종료된 USB 연결");
      if (hidOwners.has(device) && hidOwners.get(device) !== this)
        throw Error("다른 연결이 USB 장치를 사용 중입니다.");
      hidOwners.set(device, this);
      try {
        if (!device.opened) await device.open();
        if (this.closed || device !== this.device) throw Error("종료된 USB 연결");
      } catch (e) {
        // A timed-out open may finish after close(). Keep this cleanup inside
        // the shared barrier; the next transport cannot open until it ends.
        if (hidOwners.get(device) === this) {
          try { if (device.opened) await device.close(); }
          finally { hidOwners.delete(device); }
        }
        throw e;
      }
    });
    try {
      return await within(opening, timeout, "USB 열기 시간 초과");
    } catch (e) {
      if (e.timedOut) {
        this.closed = true;
        throw manualRecovery("USB 열기가 지연됩니다. 핸들 정리 후 직접 다시 연결하세요.");
      }
      throw e;
    }
  }
  async releaseHandle(device = this.device) {
    return deviceOperation(device, async () => {
      if (hidOwners.has(device) && hidOwners.get(device) !== this) return;
      try { if (device.opened) await device.close(); }
      finally { if (hidOwners.get(device) === this) hidOwners.delete(device); }
    });
  }
  async exchange(data, timeout = 1500) {
    if (this.pending) throw Error("HID owner busy");
    if (!this.device.opened) throw Error("USB 연결되지 않음");
    let request = unpackPacket(data);
    return new Promise((resolve, reject) => {
      let timer = setTimeout(() => {
        this.pending = null;
        reject(Error("응답 시간 초과; 저장/변경 자동 재시도 안 함"));
      }, timeout);
      this.pending = {
        seq: request.seq,
        op: request.op | 128,
        resolve,
        reject,
        timer,
      };
      this.device.sendReport(0, data).catch((e) => {
        if (this.pending?.seq === request.seq) {
          clearTimeout(timer);
          this.pending = null;
          reject(e);
        }
      });
    });
  }
  async prepareSaveReconnect() {
    const devices = (await within(this.hid.getDevices(), 1500,
      "허가된 USB 장치를 확인하지 못했습니다. 저장하지 않았습니다.")).filter(compatible);
    // WebHID has no public serial number. Keep the exact selected object when
    // possible; a new object is eligible only for an unambiguous single-device
    // session. Recovery never opens a chooser or writes to a candidate.
    this.saveIdentity = {
      soleDevice: devices.length === 1 && devices[0] === this.device,
      productName: this.device.productName,
    };
  }
  async reconnect(timeout = 15000) {
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw Error("잘못된 USB 재연결 제한 시간");
    const stop = Date.now() + timeout;
    const remaining = () => Math.max(1, stop - Date.now());
    // opened can stay true across the SAVE reset. Release that stale handle;
    // open() returning is not proof of reboot or successful persistence.
    try {
      await within(this.releaseHandle(), remaining(), "USB 닫기 시간 초과");
    } catch (e) {
      if (e.timedOut) {
        this.closed = true;
        throw manualRecovery("USB 핸들 정리가 지연됩니다. 잠시 후 직접 다시 연결하세요.");
      }
      // Reset may already have removed the old handle.
    }
    while (Date.now() < stop) {
      try {
        const devices = (await within(this.hid.getDevices(), remaining(),
          "USB 장치 조회 시간 초과")).filter(compatible);
        let candidate = devices.includes(this.device) ? this.device : null;
        if (!candidate && devices.length) {
          if (!this.saveIdentity?.soleDevice || devices.length !== 1 ||
              devices[0].productName !== this.saveIdentity.productName)
            throw manualRecovery("같은 키보드인지 구분할 수 없습니다. 장치를 직접 다시 선택해 저장된 설정을 확인하세요.");
          candidate = devices[0];
        }
        if (candidate) {
          if (candidate !== this.device) {
            this.device.removeEventListener("inputreport", this.handleReport);
            this.device = candidate;
            candidate.addEventListener("inputreport", this.handleReport);
          }
          await this.open(remaining());
          if (Date.now() < stop) return;
        }
      } catch (e) {
        if (e.manualRecovery) throw e;
      }
      if (Date.now() < stop) await delay(Math.min(250, remaining()));
    }
    throw Error(
      "같은 장치 재연결 실패. SAVE 영구 반영 미확인. 다시 저장하지 말고 재연결 후 프로필 확인",
    );
  }
  async close() {
    this.closed = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(Error("연결 종료"));
      this.pending = null;
    }
    this.device.removeEventListener("inputreport", this.handleReport);
    this.hid.removeEventListener("disconnect", this.handleDisconnect);
    await within(this.releaseHandle(), 1500, "USB 닫기 시간 초과");
  }
}
export class KeyboardClient {
  constructor(transport, { clock = () => Date.now(), sleep = delay } = {}) {
    this.transport = transport;
    this.seq = 0;
    this.chain = Promise.resolve();
    this.outputEnabled = false;
    this.identified = false;
    this.deviceInfo = null;
    this.clock = clock;
    this.sleep = sleep;
  }
  run(fn) {
    const result = this.chain.then(fn);
    this.chain = result.catch(() => {});
    return result;
  }
  async request(op, payload = new Uint8Array(), timeout = 1500) {
    // FirmwareClient owns update confirmation and sequencing. Right update
    // INFO also pauses scan/output, so it must not enter through this client.
    if (!Number.isInteger(op) || !((op >= 1 && op <= 10) || op === 0x40 || op === 0x41 || op === 0x42 || op === 0x43 || op === 0x44 || op === 0x45 || op === 0x46))
      throw Error("지원하지 않는 설정 명령입니다. 펌웨어 업데이트는 전용 업데이터를 사용하세요.");
    if ([4, 5, 6, 7, 8, 10].includes(op) && !this.identified) {
      this.deviceInfo = decodeInfo(await this.request(OP.INFO));
      this.identified = true;
    }
    if (op === OP.SET_BINDING)
      requireBindingCapability(decodeBinding(payload), this.deviceInfo?.capabilities ?? 0);
    if (op === OP.SET_KEY)
      requireKeyCapability(decodeKey(payload), this.deviceInfo?.capabilities ?? 0);
    this.seq = (this.seq % 65535) + 1;
    try {
      const p = await this.transport.exchange(packet(op, this.seq, payload), timeout);
      if (p.op !== (op | 128) || p.seq !== this.seq)
        throw Error("거래번호 불일치");
      if (p.status) throw Error(STATUS_NAMES[p.status] || `status ${p.status}`);
      if ([4, 5, 6, 7, 8, 10].includes(op)) this.outputEnabled = false;
      return p.payload;
    } catch (e) {
      this.outputEnabled = false;
      throw e;
    }
  }
  info() {
    return this.run(async () => {
      this.deviceInfo = decodeInfo(await this.request(OP.INFO));
      this.identified = true;
      return { ...this.deviceInfo, demo: this.transport.demo };
    });
  }
  status(side) {
    integer(side, 0, 1, "side");
    return this.run(async () => {
      let r = decodeStatus(
        await this.request(OP.STATUS, new Uint8Array([side])),
      );
      this.outputEnabled = r.output_enabled;
      return r;
    });
  }
  async _config(read = (op, payload) => this.request(op, payload)) {
    let keys = [],
      bindings = [];
    for (let i = 0; i < 14; i++)
      keys.push(decodeKey(await read(OP.GET_KEY, new Uint8Array([i]))));
    for (let i = 0; i < 28; i++)
      bindings.push(
        decodeBinding(await read(OP.GET_BINDING, new Uint8Array([i]))),
      );
    return validateProfile({
      schema: "c77-profile-v1",
      board: "C77",
      keys,
      bindings,
    });
  }
  getConfig() {
    return this.run(() => this._config());
  }
  setKey(key) {
    const bytes = encodeKey(key);
    return this.run(async () =>
      decodeKey(await this.request(OP.SET_KEY, bytes)),
    );
  }
  setBinding(binding) {
    const bytes = encodeBinding(binding);
    return this.run(async () =>
      decodeBinding(await this.request(OP.SET_BINDING, bytes)),
    );
  }
  calibrate(key, action) {
    integer(key, 0, 13, "key");
    integer(action, 0, 3, "action");
    return this.run(async () => {
      let p = await this.request(OP.CALIBRATE, new Uint8Array([key, action]));
      if (p.length !== 8) throw Error("calibration reply");
      let v = new DataView(p.buffer, p.byteOffset, p.byteLength);
      return {
        key: p[0],
        state: p[1],
        rest: v.getUint16(2, true),
        pressed: v.getUint16(4, true),
        count: v.getUint16(6, true),
      };
    });
  }
  output(enabled) {
    if (typeof enabled !== "boolean") throw Error("boolean 필요");
    return this.run(async () => {
      let p = await this.request(OP.OUTPUT, new Uint8Array([Number(enabled)]));
      if (p.length !== 1 || p[0] > 1) throw Error("output reply");
      this.outputEnabled = Boolean(p[0]);
      return this.outputEnabled;
    });
  }
  importProfile(value) {
    const p = validateProfile(value);
    return this.run(async () => {
      // Reject an unsupported profile before OUTPUT or any partial RAM writes.
      this.deviceInfo = decodeInfo(await this.request(OP.INFO));
      this.identified = true;
      for (const k of p.keys)
        requireKeyCapability(k, this.deviceInfo.capabilities);
      for (const b of p.bindings)
        requireBindingCapability(b, this.deviceInfo.capabilities);
      await this.request(OP.OUTPUT, new Uint8Array([0]));
      let count = 0;
      try {
        for (const k of p.keys) {
          await this.request(OP.SET_KEY, encodeKey(k));
          count++;
        }
        for (const b of p.bindings) {
          await this.request(OP.SET_BINDING, encodeBinding(b));
          count++;
        }
        if (JSON.stringify(await this._config()) !== JSON.stringify(p))
          throw Error("readback mismatch");
        return { ram: true, persisted: false };
      } catch (e) {
        throw Error(
          `RAM ${count}개 적용 후 중단. 부분 변경 가능, 출력 꺼짐, flash 미변경: ${e.message}`,
        );
      }
    });
  }
  save() {
    return this.run(async () => {
      const expected = await this._config(),
        before = decodeInfo(await this.request(OP.INFO));
      const expectedOutput = !!(before.capabilities & CAP_SAVE_OUTPUT) &&
        decodeStatus(await this.request(OP.STATUS, new Uint8Array([0]))).output_enabled;
      await this.transport.prepareSaveReconnect?.();
      const generation = before.generation === 0xffffffff ? 1 : before.generation + 1;
      let acknowledged = false, lastError;
      try {
        // Exactly one write. A lost ACK can still mean that Flash was saved.
        const ack = await this.request(OP.SAVE);
        if (ack.length !== 4 || new DataView(ack.buffer, ack.byteOffset,
          ack.byteLength).getUint32(0, true) !== generation)
          throw Error("SAVE 응답의 저장 세대 불일치");
        acknowledged = true;
      } catch (e) {
        lastError = e;
      }
      this.outputEnabled = false;
      const stop = this.clock() + 20000;
      const read = (op, payload) => {
        const remaining = stop - this.clock();
        if (remaining <= 0) throw Error("저장 확인 제한 시간 초과");
        return this.request(op, payload, Math.min(1500, remaining));
      };
      // Re-enumeration and INFO can succeed before Flash programming starts,
      // or fail part-way through a reboot. Retry only reads, never SAVE/OUTPUT.
      for (let attempt = 0; attempt < 80 && this.clock() < stop; attempt++) {
        try {
          await this.transport.reconnect(Math.min(1000, stop - this.clock()));
          const after = decodeInfo(await read(OP.INFO));
          if (after.generation === before.generation)
            throw Error("이전 저장 세대 응답: 재부팅 대기 중");
          if (after.generation !== generation || !after.storage_valid ||
              ["major", "minor", "patch", "board_rev"].some((k) => after[k] !== before[k]))
            throw manualRecovery("저장 세대 또는 장치 정보 불일치");
          const actual = await this._config(read);
          if (JSON.stringify(actual) !== JSON.stringify(expected))
            throw manualRecovery("저장된 전체 프로필 불일치");
          // A final read after a short settling interval rejects an early
          // response from the handle that is just about to disappear.
          await this.sleep(Math.min(250, Math.max(0, stop - this.clock())));
          const finalInfo = decodeInfo(await read(OP.INFO));
          const status = decodeStatus(await read(OP.STATUS, new Uint8Array([0])));
          if (finalInfo.generation !== generation || !finalInfo.storage_valid ||
              status.dirty || !status.stored_valid)
            throw manualRecovery("저장 후 상태 불일치: 출력·저장 상태를 직접 확인하세요.");
          if (expectedOutput && !status.output_enabled &&
              (!status.fresh || !decodeStatus(await read(OP.STATUS, new Uint8Array([1]))).fresh))
            throw Error("양쪽 센서 준비 대기 중");
          if (status.output_enabled !== expectedOutput)
            throw manualRecovery("저장 후 출력 상태가 저장 직전과 다릅니다.");
          this.deviceInfo = finalInfo;
          this.identified = true;
          this.outputEnabled = status.output_enabled;
          return {
            persisted: true, verified: true, generation, acknowledged,
            demo: this.transport.demo, config: actual, outputEnabled: status.output_enabled,
            info: { ...finalInfo, demo: this.transport.demo },
          };
        } catch (e) {
          lastError = e;
          if (e.manualRecovery) break;
        }
        if (this.clock() < stop)
          await this.sleep(Math.min(250, stop - this.clock()));
      }
      this.identified = false;
      throw Error(`영구 저장 검증 실패: ${lastError?.message || "USB 재연결 실패"}. 저장은 다시 전송하지 않았습니다. 다시 연결하여 설정을 확인하세요.`);
    });
  }
}
