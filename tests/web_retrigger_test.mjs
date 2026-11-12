import assert from "node:assert/strict";
import { keyRecord, encodeKey, decodeKey, CAP_RETRIGGER_BEFORE_RELEASE, OP } from "../web/protocol.mjs";
import { proposePerformanceSettings, applyPerformanceSettings } from "../web/performance-settings.mjs";
import { DemoTransport, demoRTState, demoRTStep } from "../web/demo.mjs";
import { KeyboardClient } from "../web/device.mjs";
import { SampledRT, RhythmCapture } from "../web/rhythm-analysis.mjs";
import { analyzeAutoFit } from "../web/auto-fit.mjs";

const key = keyRecord({ key:0, flags:15, released:1000, pressed:2000,
  actuation:150, rt_press:150, rt_release:200, top_deadzone:10,
  bottom_deadzone:0, noise_deadband:0, curve_id:0 });
assert.deepEqual(decodeKey(encodeKey(key)), key);
assert.throws(() => keyRecord({...key,flags:16}));
// Four-mm stroke: depths 2.0 -> 1.3 -> 1.9 while still held.
const traces = [0,500,325,475,490,500,300,450,0];
for (const flags of [7,15,13]) {
  const config={...key,flags}, sampled=new SampledRT(config), demo=demoRTState();
  const seen=[];
  for(const travel of traces){
    const a=sampled.step(1000+travel), b=demoRTStep(demo,config,1000+travel);
    assert.equal(a.pressed,b.pressed);
    assert.equal(a.retriggered,b.retriggered);
    seen.push(a);
  }
  assert.deepEqual(seen.map(row=>row.retriggered), flags===15 ?
    [false,false,false,true,false,false,false,false,false] : traces.map(()=>false));
  assert.equal(seen[3].pressed,true);
  if(flags!==13) assert.equal(seen[6].pressed,false);
  assert.equal(seen[7].pressed,true);
  assert.equal(seen.at(-1).pressed,false);
}
const bottom={...key, bottom_deadzone:200, rt_press:20, rt_release:250};
const held=new SampledRT(bottom);
for(const travel of [0,900,850,900,810,950]) assert.equal(held.step(1000+travel).retriggered,false);

class Transport extends DemoTransport {
  mutations=[];
  constructor(old=false){super();this.old=old;}
  command(op,payload){
    if([4,5,6,7,8,10].includes(op))this.mutations.push(op);
    const reply=super.command(op,payload);
    if(this.old && op===OP.INFO){const v=new DataView(reply.buffer,reply.byteOffset,reply.byteLength);v.setUint32(16,v.getUint32(16,true)&~CAP_RETRIGGER_BEFORE_RELEASE,true);}
    return reply;
  }
}
const transport=new Transport(),client=new KeyboardClient(transport);
transport.profile.keys=transport.profile.keys.map((before,index)=>({...key,key:index,flags:7}));
const original=await client.getConfig(), travel=Array(14).fill(4);
const candidates=proposePerformanceSettings(original,[0,7],travel,{retrigger_before_release:true},CAP_RETRIGGER_BEFORE_RELEASE);
assert(candidates.every(row=>row.flags===15));
for(const row of candidates)assert.deepEqual({...row,flags:7},original.keys[row.key]);
const outcome=await applyPerformanceSettings(client,original,candidates);
assert(outcome.complete);
assert.deepEqual(outcome.profile.keys.filter((_,i)=>i!==0&&i!==7),original.keys.filter((_,i)=>i!==0&&i!==7));
assert(!transport.mutations.includes(OP.SAVE));
assert.equal(proposePerformanceSettings(outcome.profile,[0],travel,{rapid_trigger:false},CAP_RETRIGGER_BEFORE_RELEASE)[0].flags,13);
assert.equal(proposePerformanceSettings(outcome.profile,[0],travel,{retrigger_before_release:false},0)[0].flags,7);
assert.throws(()=>proposePerformanceSettings(original,[0],travel,{retrigger_before_release:true},0),/0.3.37/);
assert.throws(()=>proposePerformanceSettings(original,[0],travel,{retrigger_before_release:1},CAP_RETRIGGER_BEFORE_RELEASE));

const oldTransport=new Transport(true),old=new KeyboardClient(oldTransport);
oldTransport.profile=structuredClone(original);
await assert.rejects(()=>old.setKey(key),/0.3.37/);
await assert.rejects(()=>old.importProfile(outcome.profile),/0.3.37/);
assert.equal((await applyPerformanceSettings(old,original,candidates)).complete,false);
assert.deepEqual(oldTransport.mutations,[],"unsupported mode rejects before output/config mutation");
assert.throws(()=>new RhythmCapture({keyConfig:key}),/미해제 재입력/);
assert.equal(analyzeAutoFit({keyConfig:key}).ready,false);
assert.match(analyzeAutoFit({keyConfig:key}).reasons[0],/미해제 재입력/);
console.log("Retrigger: flag roundtrip, default-off/parity, partial release/repress, no monotonic repeat, deadzones, group preservation, old-firmware zero writes and snapshot-analysis gates PASS");
