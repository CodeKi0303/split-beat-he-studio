// Protocol-level simulation only: no navigator.hid, network or OS key injection.
import { rawToTravel } from "./hall-curve.mjs?v=studio-owlab1";
import {
  OP,
  CAP_KEY_CHORD,
  CAP_SAVE_OUTPUT,
  CAP_RETRIGGER_BEFORE_RELEASE,
  packet,
  unpackPacket,
  encodeKey,
  decodeKey,
  encodeBinding,
  decodeBinding,
  validateProfile,
} from "./protocol.mjs?v=studio-retrigger1";
const fresh = () =>
  validateProfile({
    schema: "c77-profile-v1",
    board: "C77",
    keys: Array.from({ length: 14 }, (_, key) => ({
      key,
      flags: 3,
      released: 0,
      pressed: 0,
      actuation: 200,
      rt_press: 100,
      rt_release: 100,
      top_deadzone: 20,
      noise_deadband: 5,
    })),
    bindings: Array.from({ length: 28 }, (_, input) => ({
      input,
      kind: input < 20 ? 1 : 2,
      code: input < 20 ? 4 + input : input % 2 ? -1 : 1,
      modifiers: 0,
    })),
  });

// Snapshot-rate simulation of src/engine.c noise filtering and
// src/rapid_trigger.c. This is not a 64kHz execution/timing model.
export function demoRTState(filtered = null) {
  return { filtered, travel: 0, extreme: 0, pressed: false, rapidCycle: false, retriggerTrough: null, retriggered: false };
}
export function demoRTStep(state, key, raw) {
  const before = state.pressed, previousTravel = state.travel;
  state.retriggered = false;
  if (state.filtered === null || Math.abs(raw - state.filtered) >= key.noise_deadband)
    state.filtered = raw;
  const signedSpan = key.pressed - key.released;
  const span = Math.abs(signedSpan);
  if (span < 128) {
    state.travel = 0;
    state.pressed = false;
    state.rapidCycle = false;
    state.extreme = 0;
    state.retriggerTrough = null;
    return state;
  }
  state.travel = rawToTravel(state.filtered, key);
  if ((key.flags & 5) !== 5 || state.travel <= key.top_deadzone) {
    state.pressed = false;
    state.rapidCycle = false;
    state.extreme = state.travel;
  } else if (!(key.flags & 2)) {
    state.pressed = state.travel >= key.actuation;
    state.rapidCycle = false;
    state.extreme = state.travel;
  } else if (key.bottom_deadzone && state.travel >= 1000 - key.bottom_deadzone) {
    state.pressed = true;
    state.rapidCycle = true;
    state.extreme = 1000 - key.bottom_deadzone;
  } else if (!state.rapidCycle) {
    if (state.travel >= key.actuation) {
      state.pressed = true;
      state.rapidCycle = true;
      state.extreme = state.travel;
    }
  } else if (state.pressed) {
    state.extreme = Math.max(state.extreme, state.travel);
    if (state.extreme - state.travel >= key.rt_release) {
      state.pressed = false;
      state.extreme = state.travel;
    }
  } else {
    state.extreme = Math.min(state.extreme, state.travel);
    if (state.travel - state.extreme >= key.rt_press) {
      state.pressed = true;
      state.extreme = state.travel;
    }
  }
  const canRetrigger = (key.flags & 10) === 10 && before && state.pressed && state.travel > key.top_deadzone &&
    !(key.bottom_deadzone && state.travel >= 1000 - key.bottom_deadzone);
  if (!canRetrigger) state.retriggerTrough = null;
  else {
    if (state.travel < previousTravel && state.retriggerTrough === null) state.retriggerTrough = state.travel;
    if (state.retriggerTrough !== null) {
      state.retriggerTrough = Math.min(state.retriggerTrough, state.travel);
      if (state.travel - state.retriggerTrough >= key.rt_press) {
        state.retriggered = true; state.retriggerTrough = null;
      }
    }
  }
  return state;
}
export class DemoTransport {
  demo = true;
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.profile = fresh();
    this.pose = Array(14).fill(0);
    this.generation = 0;
    this.stored = null;
    this.storedOutput = false;
    this.enabled = false;
    this.dirty = false;
    this.start = this.clock();
    this.cal = { key: 255, state: 0, rest: 0, pressed: 0, count: 0 };
    this.rt = Array.from({ length: 14 }, () => demoRTState());
    this.pressedMask = 0;
  }
  resetRT() {
    this.rt = this.rt.map((state) => demoRTState(state.filtered));
    this.pressedMask = 0;
  }
  keyboardReport() {
    const report = new Uint8Array(32);
    if (!this.enabled) return report;
    const setUsage = (usage) => { report[usage >> 3] |= 1 << (usage & 7); };
    for (const binding of this.profile.bindings) {
      if (!(this.pressedMask & (1 << binding.input))) continue;
      if (binding.kind === 6) {
        for (const usage of binding.keys) setUsage(usage);
      } else if (binding.kind === 1) {
        if (binding.code) setUsage(binding.code);
      } else continue;
      for (let bit = 0; bit < 8; bit++)
        if (binding.modifiers & (1 << bit)) setUsage(0xe0 + bit);
    }
    return report;
  }
  async close() {
    this.enabled = false;
    this.resetRT();
  }
  async reconnect() {
    this.profile = structuredClone(this.stored);
    this.enabled = this.storedOutput;
    this.dirty = false;
    this.resetRT();
  }
  async exchange(data) {
    const p = unpackPacket(data);
    if (p.status || p.op & 128) throw Error("request invalid");
    let reply,
      status = 0;
    try {
      reply = this.command(p.op, p.payload);
    } catch (e) {
      status = e.message === "NOT_READY" ? 7 : 4;
      reply = new Uint8Array();
    }
    return unpackPacket(packet(p.op | 128, p.seq, reply, status));
  }
  command(op, p) {
    const out = (n) => {
      let a = new Uint8Array(n);
      return [a, new DataView(a.buffer)];
    };
    if (this.cal.state === 1 || this.cal.state === 3) {
      if (this.clock() >= this.readyAt) {
        this.cal.state++;
        this.cal.count = 256;
        this.cal[this.cal.state === 2 ? "rest" : "pressed"] =
          this.cal.state === 2 ? 1000 : 3000;
      }
    }
    if (op === OP.INFO) {
      if (p.length) throw Error();
      let [a, v] = out(34);
      a.set([0, 3, 22, 0, 14, 6, 4, 28]);
      [64000, 125, 0x33f | CAP_KEY_CHORD | CAP_SAVE_OUTPUT | CAP_RETRIGGER_BEFORE_RELEASE, this.generation, 0].forEach((x, i) =>
        v.setUint32(8 + i * 4, x, true),
      );
      v.setUint16(28, 1024, true);
      a.set([86, 1, 2, Number(!!this.stored)], 30);
      return a;
    }
    if (op === OP.STATUS) {
      if (p.length !== 1 || p[0] > 1) throw Error();
      let [a, v] = out(54),
        t = (this.clock() - this.start) / 1000;
      [Math.floor(t * 1000), Math.floor(t * 64000), 0, 100].forEach((x, i) =>
        v.setUint32(i * 4, x, true),
      );
      const rawSamples = [];
      this.pressedMask = 0;
      for (let key = 0; key < 14; key++) {
        const pose = this.pose[key];
        const neighboring = this.pose.reduce((sum, x, j) => sum + (j === key ? 0 : x), 0) * 0.001;
        const raw = Math.round(1000 + pose * 2 + Math.sin(t * 31 + key) * 2 + neighboring);
        rawSamples.push(raw);
        const state = demoRTStep(this.rt[key], this.profile.keys[key], raw);
        if (state.pressed) this.pressedMask |= 1 << key;
      }
      for (let i = 0; i < 7; i++) {
        const key = p[0] * 7 + i;
        v.setUint16(16 + i * 2, rawSamples[key], true);
        v.setUint16(30 + i * 2, this.rt[key].travel, true);
      }
      a[45] =
        Number(this.enabled) |
        2 |
        (Number(this.dirty) << 2) |
        (Number(!!this.stored) << 3);
      a[46] = this.cal.key;
      a[47] = this.cal.state;
      v.setUint32(48, this.pressedMask, true);
      return a;
    }
    if (op === OP.GET_KEY) {
      if (p.length !== 1) throw Error();
      return encodeKey(this.profile.keys[p[0]]);
    }
    if (op === OP.GET_BINDING) {
      if (p.length !== 1) throw Error();
      return encodeBinding(this.profile.bindings[p[0]]);
    }
    if (op === OP.SET_KEY) {
      let k = decodeKey(p);
      this.profile.keys[k.key] = k;
      this.enabled = false;
      this.dirty = true;
      this.resetRT();
      return encodeKey(k);
    }
    if (op === OP.SET_BINDING) {
      let b = decodeBinding(p);
      this.profile.bindings[b.input] = b;
      this.enabled = false;
      this.dirty = true;
      this.resetRT();
      return encodeBinding(b);
    }
    if (op === OP.OUTPUT) {
      if (p.length !== 1 || p[0] > 1) throw Error();
      if (p[0] && this.profile.keys.some((k) => k.flags & 1 && !(k.flags & 4)))
        throw Error("NOT_READY");
      this.enabled = !!p[0];
      this.resetRT();
      return p;
    }
    if (op === OP.CALIBRATE) {
      if (p.length !== 2 || p[0] > 13 || p[1] > 3) throw Error();
      let [key, action] = p;
      this.enabled = false;
      this.resetRT();
      if (action === 0) {
        this.cal = { key, state: 1, rest: 0, pressed: 0, count: 0 };
        this.readyAt = this.clock() + 50;
      } else if (action === 3)
        this.cal = { key: 255, state: 0, rest: 0, pressed: 0, count: 0 };
      else if (key !== this.cal.key) throw Error("NOT_READY");
      else if (action === 1 && this.cal.state === 2) {
        this.cal.state = 3;
        this.cal.count = 0;
        this.readyAt = this.clock() + 50;
      } else if (action === 2 && this.cal.state === 4) {
        Object.assign(this.profile.keys[key], {
          released: this.cal.rest,
          pressed: this.cal.pressed,
          flags: this.profile.keys[key].flags | 4,
        });
        this.cal.state = 0;
        this.dirty = true;
      } else throw Error("NOT_READY");
      let [a, v] = out(8);
      a[0] = this.cal.key;
      a[1] = this.cal.state;
      v.setUint16(2, this.cal.rest, true);
      v.setUint16(4, this.cal.pressed, true);
      v.setUint16(6, this.cal.count, true);
      return a;
    }
    if (op === OP.SAVE) {
      if (p.length) throw Error();
      this.stored = structuredClone(this.profile);
      this.storedOutput = this.enabled;
      this.enabled = false;
      this.resetRT();
      let [a, v] = out(4);
      this.generation = ((this.generation + 1) >>> 0) || 1;
      v.setUint32(0, this.generation, true);
      return a;
    }
    throw Error("unknown");
  }
}
