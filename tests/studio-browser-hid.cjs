// Exercise the production WebHID path without opening a physical device.
async function installStudioTestHid(page) {
  await page.evaluate(async () => {
    const { DemoTransport } = await import('./demo.mjs');
    const { VID, PID, USAGE_PAGE, USAGE, OP, packet, unpackPacket } = await import('./protocol.mjs');
    const mock = { device: null, simulator: null };
    const hid = new EventTarget();
    hid.requestDevice = async () => {
      const simulator = new DemoTransport();
      const device = Object.assign(new EventTarget(), {
        vendorId: VID,
        productId: PID,
        serialNumber: 'TEST-ONLY-STUDIO',
        collections: [{ usagePage: USAGE_PAGE, usage: USAGE }],
        opened: false,
        async open() { this.opened = true; },
        async close() { this.opened = false; },
        async sendReport(id, bytes) {
          if (id !== 0 || !this.opened) throw Error('Invalid test device exchange');
          const response = await simulator.exchange(bytes);
          if (unpackPacket(bytes).op === OP.SAVE && !response.status) await simulator.reconnect();
          const encoded = packet(response.op, response.seq, response.payload, response.status);
          const event = Object.assign(new Event('inputreport'), {
            reportId: 0, device: this, data: new DataView(encoded.buffer),
          });
          this.dispatchEvent(event);
        },
      });
      Object.assign(mock, { device, simulator });
      return [device];
    };
    hid.getDevices = async () => mock.device ? [mock.device] : [];
    Object.defineProperty(navigator, 'hid', { configurable: true, value: hid });
    window.__studioTestHid = mock;
  });
}

function setTestPose(page, value) {
  return page.evaluate((depth) => {
    const key = Number(document.querySelector('.key.selected')?.id.slice(4));
    if (!Number.isInteger(key) || key < 0 || key >= 14) throw Error('Select a Hall key first');
    window.__studioTestHid.simulator.pose[key] = depth;
  }, value);
}

function releaseTestKeys(page) {
  return page.evaluate(() => window.__studioTestHid.simulator.pose.fill(0));
}

module.exports = { installStudioTestHid, setTestPose, releaseTestKeys };
