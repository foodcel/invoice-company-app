import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startCapture } from '../web/voice-capture.js';

async function withFakeMicrophone(run) {
  const names = ['navigator', 'AudioContext', 'webkitAudioContext'];
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const tracks = [];
  const contexts = [];
  const requests = [];

  class FakeNode {
    disconnected = false;
    connect() {}
    disconnect() { this.disconnected = true; }
  }

  class FakeTrack {
    readyState = 'live';
    stopCalls = 0;
    listeners = new Map();
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    removeEventListener(name) { this.listeners.delete(name); }
    stop() { this.stopCalls++; this.readyState = 'ended'; }
  }

  class FakeAudioContext {
    constructor(options) {
      // Force the native 48 kHz path so the test also exercises resampling.
      if (options?.sampleRate) throw new Error('Requested sample rate unavailable');
      this.sampleRate = 48000;
      this.state = 'suspended';
      this.destination = new FakeNode();
      contexts.push(this);
    }
    createMediaStreamSource() { return this.source = new FakeNode(); }
    createScriptProcessor(size, inputs, outputs) {
      assert.equal(size, 512);
      assert.equal(inputs, 1);
      assert.equal(outputs, 1);
      return this.processor = new FakeNode();
    }
    createGain() {
      this.gainNode = new FakeNode();
      this.gainNode.gain = { value: 1 };
      return this.gainNode;
    }
    addEventListener() {}
    removeEventListener() {}
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
  }

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { async getUserMedia(constraints) {
      requests.push(constraints);
      const track = new FakeTrack();
      tracks.push(track);
      return { getTracks: () => [track] };
    } } }
  });
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext });
  Object.defineProperty(globalThis, 'webkitAudioContext', { configurable: true, value: undefined });

  const feed = (frameCount, value) => {
    const context = contexts.at(-1);
    assert.equal(context?.state, 'running');
    const block = new Float32Array(512).fill(value);
    for (let remaining = frameCount; remaining > 0;) {
      const count = Math.min(remaining, block.length);
      context.processor.onaudioprocess({
        inputBuffer: { getChannelData: channel => {
          assert.equal(channel, 0);
          return block.subarray(0, count);
        } }
      });
      remaining -= count;
    }
  };

  try {
    await run({ tracks, contexts, requests, feed });
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

async function assertWav(blob, frames, expectedSample) {
  assert.equal(blob.type, 'audio/wav');
  const bytes = await blob.arrayBuffer();
  const view = new DataView(bytes);
  const tag = offset => String.fromCharCode(...new Uint8Array(bytes, offset, 4));
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(tag(12), 'fmt ');
  assert.equal(tag(36), 'data');
  assert.equal(view.getUint32(4, true), bytes.byteLength - 8);
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 1); // mono
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(28, true), 32000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), frames * 2);
  assert.equal(bytes.byteLength, 44 + frames * 2);
  assert.equal(view.getInt16(44, true), expectedSample);
  assert.equal(view.getInt16(bytes.byteLength - 2, true), expectedSample);
}

function assertReleased(track, context) {
  assert.equal(track.readyState, 'ended');
  assert.equal(track.stopCalls, 1);
  assert.equal(context.state, 'closed');
  assert.equal(context.source.disconnected, true);
  assert.equal(context.processor.disconnected, true);
  assert.equal(context.gainNode.disconnected, true);
}

test('emits a 5s mono 16 kHz PCM WAV and flushes the final audio on stop', async () => {
  await withFakeMicrophone(async ({ tracks, contexts, requests, feed }) => {
    const segments = [];
    const errors = [];
    const capture = await startCapture({
      segmentMs: 5000,
      onSegment: blob => { segments.push(blob); },
      onError: error => { errors.push(error); }
    });
    assert.deepEqual(requests, [{ audio: { channelCount: 1 }, video: false }]);

    feed(5 * 48000, 0.25);
    await Promise.resolve();
    assert.equal(segments.length, 1, 'full segment arrives before stop');
    await assertWav(segments[0], 5 * 16000, 8192);

    feed(4800, 0.5);
    await capture.stop();
    assert.equal(segments.length, 2);
    await assertWav(segments[1], 1600, 16384);
    assertReleased(tracks[0], contexts[0]);
    assert.deepEqual(errors, []);
  });
});

test('cancel releases the microphone without delivering residual audio', async () => {
  await withFakeMicrophone(async ({ tracks, contexts, feed }) => {
    const segments = [];
    const errors = [];
    const capture = await startCapture({
      segmentMs: 5000,
      onSegment: blob => { segments.push(blob); },
      onError: error => { errors.push(error); }
    });
    feed(4800, 0.25);
    await capture.cancel();
    assert.deepEqual(segments, []);
    assertReleased(tracks[0], contexts[0]);
    assert.deepEqual(errors, []);
  });
});

test('a rejected segment callback reports the error and cleans up automatically', { timeout: 2000 }, async () => {
  await withFakeMicrophone(async ({ tracks, contexts, feed }) => {
    const failure = new Error('Segment delivery failed');
    const errors = [];
    let deliveries = 0;
    let resolveError;
    const errorReported = new Promise(resolve => { resolveError = resolve; });
    await startCapture({
      segmentMs: 10,
      onSegment: async () => { deliveries++; throw failure; },
      onError: error => { errors.push(error); resolveError(); }
    });

    feed(512, 0.25); // 480 frames trigger delivery; 32 residual frames are discarded.
    await errorReported;
    for (let attempt = 0; attempt < 100 && contexts[0].state !== 'closed'; attempt++) {
      await delay(10);
    }
    assert.deepEqual(errors, [failure]);
    assert.equal(deliveries, 1);
    assertReleased(tracks[0], contexts[0]);
  });
});
