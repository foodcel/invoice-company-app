const WAV_SAMPLE_RATE = 16000;
const PROCESSOR_BUFFER_SIZE = 512;

function encodeWav(chunks, frameCount, inputRate) {
  const input = new Float32Array(frameCount);
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.length;
  }

  const outputFrames = Math.max(1, Math.round(frameCount * WAV_SAMPLE_RATE / inputRate));
  const bytes = new ArrayBuffer(44 + outputFrames * 2);
  const view = new DataView(bytes);
  const label = (at, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
  };

  label(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  label(8, 'WAVE');
  label(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, WAV_SAMPLE_RATE, true);
  view.setUint32(28, WAV_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, 'data');
  view.setUint32(40, outputFrames * 2, true);

  const ratio = inputRate / WAV_SAMPLE_RATE;
  for (let i = 0; i < outputFrames; i++) {
    let sample;
    if (ratio > 1) {
      // Average the source interval when reducing the sample rate.
      const start = i * ratio;
      const end = i === outputFrames - 1 ? frameCount : Math.min((i + 1) * ratio, frameCount);
      let position = start;
      let sum = 0;
      while (position < end) {
        const index = Math.floor(position);
        const next = Math.min(end, index + 1);
        sum += input[index] * (next - position);
        position = next;
      }
      sample = end > start ? sum / (end - start) : input[frameCount - 1];
    } else {
      const position = i * ratio;
      const left = Math.min(Math.floor(position), frameCount - 1);
      const right = Math.min(left + 1, frameCount - 1);
      sample = input[left] + (input[right] - input[left]) * (position - left);
    }
    const clipped = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
    view.setInt16(44 + i * 2, Math.round(clipped * (clipped < 0 ? 32768 : 32767)), true);
  }

  return new Blob([bytes], { type: 'audio/wav' });
}

/** Start recording consecutive mono WAV blobs; onSegment receives one Blob per segment. */
export async function startCapture({ segmentMs, onSegment, onError } = {}) {
  if (!Number.isFinite(segmentMs) || segmentMs <= 0) {
    throw new TypeError('segmentMs must be a positive number of milliseconds.');
  }
  if (typeof onSegment !== 'function' || typeof onError !== 'function') {
    throw new TypeError('onSegment and onError must be functions.');
  }

  const mediaDevices = globalThis.navigator?.mediaDevices;
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!mediaDevices?.getUserMedia || !AudioContextClass) {
    throw new Error('Microphone capture is unavailable in this browser or context.');
  }

  let stream;
  let context;
  let source;
  let processor;
  let silentOutput;
  let state = 'starting';
  let closing;
  let delivery = Promise.resolve();
  let chunks = [];
  let frames = 0;
  let segmentFrames;
  let errorReported = false;

  const tracks = () => stream?.getTracks() || [];
  const handleTrackEnded = () => reportError(new Error('Microphone capture ended unexpectedly.'));
  const handleContextState = () => {
    if (context.state === 'closed' || context.state === 'interrupted') {
      reportError(new Error('Microphone audio processing stopped unexpectedly.'));
    }
  };

  function reportError(error) {
    if (!errorReported) {
      errorReported = true;
      try { void Promise.resolve(onError(error)).catch(() => {}); }
      catch { /* Error handlers must not block cleanup. */ }
    }
    if (state === 'running') void shutdown(false).catch(() => {});
  }

  function emitSegment() {
    if (!frames) return;
    const blob = encodeWav(chunks, frames, context.sampleRate);
    chunks = [];
    frames = 0;
    delivery = delivery.then(() => {
      if (state !== 'cancelled') return onSegment(blob);
    }).catch(error => {
      reportError(error);
      throw error;
    });
    // A caller may never call stop(), so observe delivery failures immediately.
    void delivery.catch(() => {});
  }

  function collect(samples) {
    let offset = 0;
    while (offset < samples.length) {
      const count = Math.min(segmentFrames - frames, samples.length - offset);
      chunks.push(new Float32Array(samples.subarray(offset, offset + count)));
      frames += count;
      offset += count;
      if (frames === segmentFrames) emitSegment();
    }
  }

  async function shutdown(flush) {
    if (closing) return closing;
    state = flush ? 'stopping' : 'cancelled';
    closing = (async () => {
      if (processor) processor.onaudioprocess = null;
      for (const track of tracks()) track.removeEventListener('ended', handleTrackEnded);
      context?.removeEventListener?.('statechange', handleContextState);

      let failure;
      if (flush) {
        try { emitSegment(); } catch (error) { failure = error; reportError(error); }
      } else { chunks = []; frames = 0; }

      try { processor?.disconnect(); } catch { /* Already disconnected. */ }
      try { source?.disconnect(); } catch { /* Already disconnected. */ }
      try { silentOutput?.disconnect(); } catch { /* Already disconnected. */ }
      for (const track of tracks()) {
        try { track.stop(); } catch (error) { failure ??= error; reportError(error); }
      }

      try { await context?.close(); } catch (error) { failure ??= error; reportError(error); }
      try { await delivery; } catch (error) { if (flush) failure ??= error; }
      state = 'stopped';
      if (failure) throw failure;
    })();
    return closing;
  }

  try {
    stream = await mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
    if (!tracks().length) throw new Error('No microphone audio track was provided.');
    try {
      context = new AudioContextClass({ sampleRate: WAV_SAMPLE_RATE });
    } catch {
      context = new AudioContextClass();
    }
    if (!context.createScriptProcessor || !Number.isFinite(context.sampleRate) || context.sampleRate <= 0) {
      throw new Error('Microphone audio processing is unavailable.');
    }
    segmentFrames = Math.max(1, Math.round(context.sampleRate * segmentMs / 1000));

    source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
    silentOutput = context.createGain();
    silentOutput.gain.value = 0;
    processor.onaudioprocess = event => {
      if (state !== 'running') return;
      try { collect(event.inputBuffer.getChannelData(0)); }
      catch (error) { reportError(error); }
    };
    source.connect(processor);
    processor.connect(silentOutput);
    silentOutput.connect(context.destination);
    for (const track of tracks()) track.addEventListener('ended', handleTrackEnded);
    context.addEventListener?.('statechange', handleContextState);
    await context.resume();
    if (context.state !== 'running') {
      throw new Error('Microphone audio processing could not start.');
    }
    if (tracks().some(track => track.readyState === 'ended')) {
      throw new Error('Microphone capture ended before recording started.');
    }
    state = 'running';
    return { stop: () => shutdown(true), cancel: () => shutdown(false) };
  } catch (error) {
    state = 'cancelled';
    if (processor) processor.onaudioprocess = null;
    for (const track of tracks()) {
      track.removeEventListener('ended', handleTrackEnded);
      try { track.stop(); } catch { /* Preserve the startup error. */ }
    }
    try { source?.disconnect(); } catch { /* Setup may have stopped before connection. */ }
    try { processor?.disconnect(); } catch { /* Setup may have stopped before connection. */ }
    try { silentOutput?.disconnect(); } catch { /* Setup may have stopped before connection. */ }
    try { await context?.close(); } catch { /* Preserve the startup error. */ }
    throw error;
  }
}

/** Local Nemotron realtime session. Audio leaves the WebView only for the authenticated loopback service. */
export async function startStreamingRecognition({ url, onPartial, onFinal, onError }) {
  if (!url?.startsWith('ws://127.0.0.1:')) throw new Error('Adresse du moteur vocal local invalide.');
  let socket;
  let lastFailure;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      socket = await new Promise((resolve, reject) => {
        const candidate = new WebSocket(url);
        candidate.binaryType = 'arraybuffer';
        candidate.onopen = () => resolve(candidate);
        candidate.onerror = () => { candidate.close(); reject(new Error('Le moteur vocal démarre…')); };
      });
      break;
    } catch (error) {
      lastFailure = error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  if (!socket) throw lastFailure || new Error('Le moteur vocal local ne répond pas.');

  let closed = false;
  let partial = '';
  let committed = false;
  let cancelled = false;
  let finishResolve;
  let finishReject;
  const finished = new Promise((resolve, reject) => { finishResolve = resolve; finishReject = reject; });
  socket.onmessage = event => {
    if (cancelled) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'error') {
      const error = new Error(message.error?.message || message.message || 'Erreur du moteur vocal.');
      finishReject(error); onError(error); return;
    }
    if (message.type === 'conversation.item.input_audio_transcription.delta') {
      const delta = String(message.delta ?? message.text ?? '');
      partial += delta;
      try { onPartial(partial); } catch (error) { onError(error); }
    }
    if (message.type === 'conversation.item.input_audio_transcription.completed') {
      const text = String(message.transcript ?? message.text ?? partial).trim();
      partial = '';
      try { onPartial(''); if (text) onFinal(text); }
      catch (error) { onError(error); }
    }
    if (message.type === 'input_audio_buffer.committed' && closed) {
      committed = true;
      finishResolve();
    }
  };
  socket.onerror = () => {
    if (cancelled) return;
    const error = new Error('La connexion au moteur vocal a été interrompue.');
    finishReject(error); onError(error);
  };
  socket.onclose = () => {
    if (committed || cancelled) finishResolve();
    else {
      const error = new Error('Le moteur vocal s’est arrêté avant la fin de la dictée.');
      finishReject(error);
      if (!closed) onError(error);
    }
  };
  socket.send(JSON.stringify({ type: 'session.update', session: {
    sample_rate: 16000, language: 'fr-CA', automatic_punctuation: true,
    endpointing_ms: 800
  } }));

  let capture;
  try {
    capture = await startCapture({ segmentMs: 120,
      onSegment: async blob => {
        if (socket.readyState !== WebSocket.OPEN) throw new Error('Connexion vocale fermée.');
        const wav = await blob.arrayBuffer();
        socket.send(wav.slice(44)); // PCM16 mono, little-endian, 16 kHz
      },
      onError: error => { cancelled = true; finishResolve(); socket.close(); onError(error); }
    });
  } catch (error) { cancelled = true; finishResolve(); socket.close(); throw error; }
  return {
    async stop() {
      await capture.stop();
      closed = true;
      socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('La dernière phrase n’a pas pu être confirmée.')), 20000); });
      try { await Promise.race([finished, timeout]); }
      finally { clearTimeout(timer); socket.close(); }
    },
    async cancel() {
      closed = true; cancelled = true; finishResolve();
      await capture.cancel();
      socket.close();
    }
  };
}
