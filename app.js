const TARGET_SAMPLE_RATE = 16000;
const FRAME_MS = 30;
const FRAME_SIZE = Math.round(TARGET_SAMPLE_RATE * FRAME_MS / 1000);

const DEFAULTS = {
  silenceMs: 420,
  maxSegmentMs: 18000,
  minTurnMs: 260,
  seedMs: 900,
  updateMs: 700,
  centroidAlpha: 0.18,
  maxQueuedSegments: 24,
  interimFlushMs: 1100,
  staleInterimMs: 2600,
};

const $ = (id) => document.getElementById(id);

const els = {
  statusDot: $("statusDot"),
  statusText: $("statusText"),
  statusDetail: $("statusDetail"),
  startBtn: $("startBtn"),
  pauseBtn: $("pauseBtn"),
  newMeetingBtn: $("newMeetingBtn"),
  downloadTxtBtn: $("downloadTxtBtn"),
  downloadJsonBtn: $("downloadJsonBtn"),
  clearBtn: $("clearBtn"),
  language: $("language"),
  vadSensitivity: $("vadSensitivity"),
  vadSensitivityValue: $("vadSensitivityValue"),
  speakerThreshold: $("speakerThreshold"),
  speakerThresholdValue: $("speakerThresholdValue"),
  maxSpeakers: $("maxSpeakers"),
  meter: $("meter"),
  micDb: $("micDb"),
  vadGate: $("vadGate"),
  noiseFloor: $("noiseFloor"),
  currentSpeaker: $("currentSpeaker"),
  segmentCount: $("segmentCount"),
  recognitionState: $("recognitionState"),
  speakerDebug: $("speakerDebug"),
  transcript: $("transcript"),
  interim: $("interim"),
  meetingName: $("meetingName"),
  turnTemplate: $("turnTemplate"),
};

class FloatRing {
  constructor(maxFrames) {
    this.maxFrames = maxFrames;
    this.frames = [];
  }
  push(frame) {
    this.frames.push(frame);
    while (this.frames.length > this.maxFrames) this.frames.shift();
  }
  snapshot() {
    return this.frames.map((f) => new Float32Array(f));
  }
  clear() { this.frames = []; }
}

class VADSegmenter {
  constructor({ onSegment, onMeter }) {
    this.onSegment = onSegment;
    this.onMeter = onMeter;
    this.reset();
  }

  reset() {
    this.pending = new Float32Array(0);
    this.segmentFrames = [];
    this.preRoll = new FloatRing(8);
    this.inSpeech = false;
    this.segmentStartMs = 0;
    this.segmentSpeechMs = 0;
    this.segmentMs = 0;
    this.silenceMs = 0;
    this.sampleClock = 0;
    this.noiseFloorDb = -62;
    this.lastSpeechDb = -90;
    this.segmentId = 0;
    this.lastMeterPaintMs = 0;
  }

  updateConfig() {
    this.marginDb = Number(els.vadSensitivity.value);
  }

  accept(input, inputSampleRate) {
    this.updateConfig();
    const samples = downsample(input, inputSampleRate, TARGET_SAMPLE_RATE);
    const joined = concatFloat32([this.pending, samples]);
    let offset = 0;
    while (offset + FRAME_SIZE <= joined.length) {
      const frame = joined.slice(offset, offset + FRAME_SIZE);
      this.processFrame(frame);
      offset += FRAME_SIZE;
    }
    this.pending = joined.slice(offset);
  }

  processFrame(frame) {
    const nowMs = (this.sampleClock / TARGET_SAMPLE_RATE) * 1000;
    this.sampleClock += frame.length;

    const rms = rootMeanSquare(frame);
    const db = 20 * Math.log10(rms + 1e-8);
    const zcr = zeroCrossingRate(frame);
    const floorGate = this.noiseFloorDb + this.marginDb;
    const minSpeechDb = -62;
    const openGate = Math.max(minSpeechDb, floorGate);
    const continueGate = Math.max(minSpeechDb - 3, openGate - 4);
    const gate = this.inSpeech ? continueGate : openGate;

    // Be deliberately permissive at the detection layer. Transcript assembly and
    // Chrome recognition can reject junk later, but if VAD misses a quiet phrase
    // there is nothing to recover for diarization. ZCR is kept only as a broad
    // noise guard, not a hard speech-quality classifier.
    const speech = db > gate && zcr < 0.44;

    if (!speech) {
      this.noiseFloorDb = 0.995 * this.noiseFloorDb + 0.005 * db;
    } else {
      this.lastSpeechDb = db;
    }

    // Painting every 30ms can bog down lower-end laptops, so throttle UI updates.
    if (nowMs - this.lastMeterPaintMs > 90) {
      this.lastMeterPaintMs = nowMs;
      this.onMeter?.({ rms, db, noiseFloorDb: this.noiseFloorDb, gate, speech, zcr });
    }

    if (speech) {
      if (!this.inSpeech) {
        this.inSpeech = true;
        this.segmentStartMs = Math.max(0, nowMs - this.preRoll.frames.length * FRAME_MS);
        this.segmentFrames = this.preRoll.snapshot();
        this.segmentSpeechMs = 0;
        this.segmentMs = this.segmentFrames.length * FRAME_MS;
      }
      this.segmentFrames.push(frame);
      this.segmentSpeechMs += FRAME_MS;
      this.segmentMs += FRAME_MS;
      this.silenceMs = 0;
    } else {
      this.preRoll.push(frame);
      if (this.inSpeech) {
        this.segmentFrames.push(frame);
        this.segmentMs += FRAME_MS;
        this.silenceMs += FRAME_MS;
      }
    }

    if (this.inSpeech && (this.silenceMs >= DEFAULTS.silenceMs || this.segmentMs >= DEFAULTS.maxSegmentMs)) {
      this.flush(nowMs);
    }
  }

  flush(endMs = (this.sampleClock / TARGET_SAMPLE_RATE) * 1000) {
    if (!this.inSpeech) return;
    const audio = concatFloat32(this.segmentFrames);
    const trimmedEndMs = Math.max(this.segmentStartMs, endMs - this.silenceMs);
    const durationMs = trimmedEndMs - this.segmentStartMs;
    if (this.segmentSpeechMs >= DEFAULTS.minTurnMs && audio.length > TARGET_SAMPLE_RATE * 0.18) {
      this.onSegment({
        id: ++this.segmentId,
        startMs: this.segmentStartMs,
        endMs: trimmedEndMs,
        durationMs,
        speechMs: this.segmentSpeechMs,
        audio,
      });
    }
    this.segmentFrames = [];
    this.inSpeech = false;
    this.segmentSpeechMs = 0;
    this.segmentMs = 0;
    this.silenceMs = 0;
  }
}

class SpeakerTracker {
  constructor() { this.reset(); }

  reset() {
    this.centroids = new Map();
    this.nextId = 1;
    this.lastSpeaker = null;
    this.lastDistance = null;
    this.lastDecision = "none";
  }

  assign(segment) {
    const duration = segment.durationMs;
    if (duration < DEFAULTS.minTurnMs && this.lastSpeaker) {
      this.lastDecision = "short turn inherited";
      return this.lastSpeaker;
    }

    const embedding = buildAcousticEmbedding(segment.audio, TARGET_SAMPLE_RATE);
    if (!embedding || vectorNorm(embedding) === 0) {
      this.lastDecision = "no usable voiceprint";
      return this.lastSpeaker ?? 1;
    }

    if (this.centroids.size === 0) {
      this.centroids.set(1, embedding);
      this.nextId = 2;
      this.lastSpeaker = 1;
      this.lastDistance = 0;
      this.lastDecision = "seeded speaker 1";
      return 1;
    }

    const { id: bestId, distance } = this.closest(embedding);
    const threshold = Number(els.speakerThreshold.value) / 100;
    const maxSpeakers = Number(els.maxSpeakers.value);
    this.lastDistance = distance;

    if (duration >= DEFAULTS.seedMs && distance > threshold && this.centroids.size < maxSpeakers) {
      const id = this.nextId++;
      this.centroids.set(id, embedding);
      this.lastSpeaker = id;
      this.lastDecision = `new speaker: distance ${distance.toFixed(2)} > ${threshold.toFixed(2)}`;
      return id;
    }

    if (duration >= DEFAULTS.updateMs) {
      const old = this.centroids.get(bestId);
      this.centroids.set(bestId, l2Normalize(weightedAdd(old, 1 - DEFAULTS.centroidAlpha, embedding, DEFAULTS.centroidAlpha)));
    }

    this.lastSpeaker = bestId;
    this.lastDecision = `matched speaker ${bestId}: distance ${distance.toFixed(2)} ≤ ${threshold.toFixed(2)}`;
    return bestId;
  }

  closest(embedding) {
    let bestId = 1;
    let bestDistance = Infinity;
    for (const [id, centroid] of this.centroids) {
      const distance = cosineDistance(embedding, centroid);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestId = id;
      }
    }
    return { id: bestId, distance: bestDistance };
  }
}

class TranscriptStore {
  constructor() { this.reset(); }

  reset() {
    this.meetingStartedAt = new Date();
    this.turns = [];
  }

  getTurn(id) {
    return this.turns.find((turn) => turn.id === id) || null;
  }

  updateTurn(id, patch) {
    const turn = this.getTurn(id);
    if (!turn) return null;
    if (patch.text !== undefined) {
      const clean = cleanTranscriptText(patch.text);
      if (clean) turn.text = clean;
    }
    if (patch.startMs !== undefined) turn.startMs = Math.min(turn.startMs, patch.startMs);
    if (patch.endMs !== undefined) turn.endMs = Math.max(turn.endMs, patch.endMs);
    if (patch.speaker !== undefined) turn.speaker = patch.speaker;
    if (patch.confidence !== undefined) turn.confidence = patch.confidence;
    if (patch.source !== undefined) turn.source = patch.source;
    if (patch.tentative !== undefined) turn.tentative = Boolean(patch.tentative);
    if (patch.segments !== undefined) turn.segments = mergeSegmentLists(turn.segments || [], patch.segments || []);
    turn.durationMs = Math.max(0, turn.endMs - turn.startMs);
    return turn;
  }

  addTextTurn(turn) {
    const clean = cleanTranscriptText(turn.text);
    if (!clean) return null;

    const incomingTentative = Boolean(turn.tentative);
    const previous = this.turns[this.turns.length - 1];
    if (previous && previous.speaker === turn.speaker && turn.startMs - previous.endMs < 900) {
      // Interim fallback text is allowed into the transcript so speech is not
      // lost, but it remains revisable. If a later Chrome hypothesis/final is a
      // fuller version of that same draft, replace the draft instead of merging
      // prefix artifacts like "St. Stag. Stagger." into the transcript.
      if (previous.tentative && shouldReplaceDraftTurn(previous.text, clean)) {
        previous.text = clean;
        previous.endMs = Math.max(previous.endMs, turn.endMs);
        previous.durationMs = Math.max(0, previous.endMs - previous.startMs);
        previous.confidence = turn.confidence ?? previous.confidence;
        previous.source = turn.source || previous.source;
        previous.tentative = incomingTentative;
        previous.segments = mergeSegmentLists(previous.segments || [], turn.segments || []);
        return previous;
      }

      previous.text = mergeTranscriptTexts(previous.text, clean);
      previous.endMs = Math.max(previous.endMs, turn.endMs);
      previous.durationMs = Math.max(0, previous.endMs - previous.startMs);
      previous.confidence = turn.confidence ?? previous.confidence;
      previous.source = turn.source || previous.source;
      previous.tentative = previous.tentative && incomingTentative;
      previous.segments = mergeSegmentLists(previous.segments || [], turn.segments || []);
      return previous;
    }

    const stored = {
      id: crypto.randomUUID(),
      startMs: turn.startMs,
      endMs: turn.endMs,
      durationMs: Math.max(0, turn.endMs - turn.startMs),
      speaker: turn.speaker,
      text: clean,
      confidence: turn.confidence ?? null,
      source: turn.source || "recognizer",
      tentative: incomingTentative,
      segments: turn.segments || [],
    };
    this.turns.push(stored);
    return stored;
  }

  toText() {
    const header = `[${this.meetingStartedAt.toISOString()}] Browser transcript started`;
    const lines = this.turns
      .filter((t) => t.text && t.text.trim())
      .map((t) => `[${formatClock(t.endMs)}] speaker ${t.speaker}: ${t.text.trim()}`);
    return [header, ...lines].join("\n") + "\n";
  }

  toJSON() {
    return JSON.stringify({
      meetingStartedAt: this.meetingStartedAt.toISOString(),
      engine: "Chrome Web Speech API + Web Audio VAD + local browser acoustic diarization",
      turns: this.turns,
    }, null, 2);
  }
}

class BrowserTranscriber {
  constructor() {
    this.running = false;
    this.audioContext = null;
    this.stream = null;
    this.worklet = null;
    this.recognition = null;
    this.recognitionRestartTimer = null;
    this.stopRequested = false;

    // Recognition ledger state. Chrome's result list is mutable: interim rows
    // are hypotheses, final rows are stable. We mirror that model instead of
    // treating every interim snapshot as transcript text.
    this.recognitionSessionId = 0;
    this.committedFinalCursor = 0;
    this.currentInterim = "";
    this.currentInterimUpdatedAt = 0;
    this.currentDraftTurnId = null;
    this.interimIdleTimer = null;
    this.speechEndTimer = null;
    this.lastRecognitionEventAt = 0;
    this.lastStatusUpdateAt = 0;

    this.pendingSegments = [];
    this.totalSegments = 0;
    this.lastKnownSpeaker = 1;
    this.lastTurnEndMs = 0;
    this.store = new TranscriptStore();
    this.speakers = new SpeakerTracker();
    this.segmenter = new VADSegmenter({
      onSegment: (segment) => this.handleSegment(segment),
      onMeter: (meter) => this.handleMeter(meter),
    });
    this.renderMeetingName();
  }

  supported() {
    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition) && Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(window.AudioWorkletNode);
  }

  async start() {
    if (this.running) return;
    if (!this.supported()) {
      this.setStatus("Unsupported", "Use a current Chrome desktop build over HTTPS or localhost.", "error");
      return;
    }

    this.running = true;
    this.stopRequested = false;
    this.setButtons();
    this.setStatus("Starting", "Requesting microphone permission…", "");

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      await this.startAudioGraph();
      this.startRecognition();
      this.setStatus("Live", "Listening. Chrome text is mirrored first; local VAD only annotates speaker turns.", "live");
    } catch (err) {
      this.running = false;
      this.stopRequested = true;
      this.setButtons();
      this.setStatus("Start failed", err?.message || String(err), "error");
      throw err;
    }
  }

  async startAudioGraph() {
    this.audioContext = new AudioContext({ latencyHint: "interactive" });
    await this.audioContext.resume();

    const workletUrl = URL.createObjectURL(new Blob([`
      class MicTapProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const input = inputs[0];
          if (input && input[0]) this.port.postMessage(input[0].slice(0));
          return true;
        }
      }
      registerProcessor('mic-tap-processor', MicTapProcessor);
    `], { type: "text/javascript" }));

    await this.audioContext.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);

    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.audioContext, "mic-tap-processor");
    const sink = this.audioContext.createGain();
    sink.gain.value = 0;
    this.worklet.port.onmessage = (event) => {
      if (this.running) this.segmenter.accept(event.data, this.audioContext.sampleRate);
    };
    source.connect(this.worklet).connect(sink).connect(this.audioContext.destination);
  }

  startRecognition() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new Recognition();
    this.recognition.lang = els.language.value || "en-US";
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = 1;

    // Experimental properties are guarded. Chrome may ignore them, but setting
    // them when present improves punctuation/local-processing behavior on
    // engines that implement newer Web Speech pieces.
    try {
      if ("unspokenPunctuation" in this.recognition) this.recognition.unspokenPunctuation = true;
    } catch {}

    this.recognition.onstart = () => {
      this.recognitionSessionId += 1;
      this.committedFinalCursor = 0;
      this.currentInterim = "";
      this.currentInterimUpdatedAt = 0;
      this.currentDraftTurnId = null;
      this.paintInterim();
      els.recognitionState.textContent = "listening";
    };
    this.recognition.onaudiostart = () => { els.recognitionState.textContent = "audio"; };
    this.recognition.onspeechstart = () => {
      els.recognitionState.textContent = "speech";
      this.setStatus("Live", "Chrome speech recognizer hears speech.", "live");
      clearTimeout(this.speechEndTimer);
    };
    this.recognition.onspeechend = () => {
      els.recognitionState.textContent = "processing";
      this.scheduleInterimPromotion("speechend", 700);
    };
    this.recognition.onerror = (event) => {
      els.recognitionState.textContent = event.error;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        this.stopRequested = true;
        this.running = false;
        this.setStatus("Speech blocked", "Chrome denied speech recognition access.", "error");
        this.setButtons();
      }
    };
    this.recognition.onend = () => {
      this.promoteCurrentInterim("recognizer-ended", { close: true });
      if (!this.running || this.stopRequested) {
        els.recognitionState.textContent = "idle";
        return;
      }
      els.recognitionState.textContent = "restarting";
      clearTimeout(this.recognitionRestartTimer);
      this.recognitionRestartTimer = setTimeout(() => {
        if (!this.running || this.stopRequested) return;
        try { this.recognition.start(); } catch {}
      }, 350);
    };
    this.recognition.onresult = (event) => this.handleRecognitionResult(event);

    try { this.recognition.start(); } catch {}
  }

  handleRecognitionResult(event) {
    this.lastRecognitionEventAt = performance.now();
    clearTimeout(this.speechEndTimer);

    // The Web Speech model is a mutable result list: stable final results first,
    // then mutable interim hypotheses. Consume new final indexes exactly once.
    let committedAnyFinal = false;
    while (this.committedFinalCursor < event.results.length) {
      const result = event.results[this.committedFinalCursor];
      if (!result?.isFinal) break;
      const alt = result[0];
      const finalText = cleanRecognizerSpacing(alt?.transcript || "");
      if (finalText) {
        this.commitFinalText(finalText, typeof alt.confidence === "number" ? alt.confidence : null);
        committedAnyFinal = true;
      }
      this.committedFinalCursor += 1;
    }

    let interim = "";
    for (let i = this.committedFinalCursor; i < event.results.length; i++) {
      const result = event.results[i];
      if (result?.isFinal) continue;
      const alt = result?.[0];
      if (alt?.transcript) interim += ` ${alt.transcript}`;
    }

    const interimClean = cleanRecognizerSpacing(interim);
    if (interimClean) {
      this.receiveInterimHypothesis(interimClean);
    } else {
      // If Chrome removes an interim hypothesis without producing a final, keep
      // the last visible hypothesis as the single provisional transcript turn.
      if (!committedAnyFinal) this.promoteCurrentInterim("interim-removed", { close: true });
      else this.clearInterim({ keepDraft: false });
    }
  }

  receiveInterimHypothesis(text) {
    const clean = cleanRecognizerSpacing(text);
    if (!clean) return;

    if (this.currentInterim && !looksLikeSameUtterance(this.currentInterim, clean)) {
      // Rollover means Chrome started a new hypothesis without finalizing the
      // previous one. Commit the previous hypothesis once, then start fresh.
      this.promoteCurrentInterim("interim-rollover", { close: true });
    }

    this.currentInterim = chooseMoreCompleteRecognizerText(this.currentInterim, clean);
    this.currentInterimUpdatedAt = performance.now();
    this.paintInterim();

    // This is a fallback, not the primary commit path. If Chrome sends a final,
    // it replaces the draft. If it never does, the visible interim text is still
    // preserved after it stops changing.
    this.scheduleInterimPromotion("interim-idle", 1800);
  }

  scheduleInterimPromotion(reason, delayMs) {
    clearTimeout(this.interimIdleTimer);
    this.interimIdleTimer = setTimeout(() => {
      this.promoteCurrentInterim(reason, { close: false });
    }, delayMs);
  }

  promoteCurrentInterim(reason = "interim-fallback", { close = false } = {}) {
    const text = cleanRecognizerSpacing(this.currentInterim);
    if (!text) return null;

    // Force-close the current acoustic turn before assigning speaker metadata.
    // This affects diarization only; it never decides whether text survives.
    this.segmenter.flush();

    let turn;
    if (this.currentDraftTurnId) {
      const existing = this.store.getTurn(this.currentDraftTurnId);
      if (existing) {
        const chosen = chooseMoreCompleteRecognizerText(existing.text, text);
        const extra = this.consumeSegmentsForText();
        const update = this.buildTurnPatchFromSegments(extra, {
          text: chosen,
          confidence: existing.confidence,
          source: reason,
          tentative: true,
        });
        turn = this.store.updateTurn(this.currentDraftTurnId, update);
      }
    }

    if (!turn) {
      turn = this.commitText(text, null, reason, { tentative: true });
      if (turn) this.currentDraftTurnId = turn.id;
    }

    if (close) {
      this.clearInterim({ keepDraft: false });
    } else {
      this.paintInterim();
    }
    this.renderTranscript();
    return turn;
  }

  commitFinalText(text, confidence = null) {
    const finalText = cleanRecognizerSpacing(text);
    if (!finalText) return null;

    this.segmenter.flush();

    let turn = null;
    if (this.currentDraftTurnId) {
      const draft = this.store.getTurn(this.currentDraftTurnId);
      if (draft && looksLikeSameUtterance(draft.text, finalText)) {
        const chosen = chooseBestRecognizerText(finalText, draft.text);
        const extra = this.consumeSegmentsForText();
        const patch = this.buildTurnPatchFromSegments(extra, {
          text: chosen,
          confidence,
          source: "chrome-final",
          tentative: false,
        });
        turn = this.store.updateTurn(this.currentDraftTurnId, patch);
        this.currentDraftTurnId = null;
      }
    }

    if (!turn) {
      turn = this.commitText(finalText, confidence, "chrome-final", { tentative: false });
    }

    if (this.currentInterim && looksLikeSameUtterance(this.currentInterim, finalText)) {
      this.clearInterim({ keepDraft: false });
    }
    this.renderTranscript();
    return turn;
  }

  paintInterim() {
    els.interim.textContent = this.currentInterim ? `… ${this.currentInterim}` : "";
  }

  clearInterim({ keepDraft = false } = {}) {
    this.currentInterim = "";
    this.currentInterimUpdatedAt = 0;
    if (!keepDraft) this.currentDraftTurnId = null;
    els.interim.textContent = "";
    clearTimeout(this.interimIdleTimer);
    clearTimeout(this.speechEndTimer);
    this.interimIdleTimer = null;
    this.speechEndTimer = null;
  }

  async pause() {
    this.running = false;
    this.stopRequested = true;
    this.segmenter.flush();
    this.promoteCurrentInterim("pause", { close: true });
    clearTimeout(this.recognitionRestartTimer);
    clearTimeout(this.interimIdleTimer);
    clearTimeout(this.speechEndTimer);
    try { this.recognition?.stop(); } catch {}
    this.stream?.getTracks().forEach((track) => track.stop());
    try { await this.audioContext?.close(); } catch {}
    this.stream = null;
    this.audioContext = null;
    this.worklet = null;
    this.setStatus("Paused", "Meeting capture is paused.", "");
    this.setButtons();
  }

  async newMeeting() {
    if (this.running) await this.pause();
    this.store.reset();
    this.speakers.reset();
    this.segmenter.reset();
    this.pendingSegments = [];
    this.totalSegments = 0;
    this.lastKnownSpeaker = 1;
    this.lastTurnEndMs = 0;
    this.currentInterim = "";
    this.currentInterimUpdatedAt = 0;
    this.currentDraftTurnId = null;
    this.committedFinalCursor = 0;
    clearTimeout(this.interimIdleTimer);
    clearTimeout(this.speechEndTimer);
    this.interimIdleTimer = null;
    this.speechEndTimer = null;
    els.transcript.innerHTML = "";
    els.interim.textContent = "";
    els.segmentCount.textContent = "0";
    els.currentSpeaker.textContent = "—";
    els.speakerDebug.textContent = "—";
    this.renderMeetingName();
    await this.start();
  }

  clear() {
    this.store.reset();
    this.speakers.reset();
    this.segmenter.reset();
    this.pendingSegments = [];
    this.totalSegments = 0;
    this.lastKnownSpeaker = 1;
    this.lastTurnEndMs = 0;
    this.currentInterim = "";
    this.currentInterimUpdatedAt = 0;
    this.currentDraftTurnId = null;
    this.committedFinalCursor = 0;
    clearTimeout(this.interimIdleTimer);
    clearTimeout(this.speechEndTimer);
    this.interimIdleTimer = null;
    this.speechEndTimer = null;
    els.transcript.innerHTML = "";
    els.interim.textContent = "";
    els.segmentCount.textContent = "0";
    els.currentSpeaker.textContent = "—";
    els.speakerDebug.textContent = "—";
    this.renderMeetingName();
    this.setButtons();
  }

  handleMeter({ rms, db, noiseFloorDb, gate, speech }) {
    const level = Math.min(100, Math.max(0, (20 * Math.log10(rms + 1e-8) + 72) * 2.2));
    els.meter.style.width = `${level}%`;
    if (els.micDb) els.micDb.textContent = `${db.toFixed(1)} dB`;
    if (els.vadGate) els.vadGate.textContent = `${gate.toFixed(1)} dB`;
    els.noiseFloor.textContent = `${noiseFloorDb.toFixed(1)} dB`;
    const now = performance.now();
    if (speech && now - this.lastStatusUpdateAt > 900) {
      this.lastStatusUpdateAt = now;
      els.statusDetail.textContent = "Local VAD sees speech for speaker labeling. Transcript text is controlled by Chrome results.";
    }
  }

  handleSegment(segment) {
    const speaker = this.speakers.assign(segment);
    const enriched = { ...segment, speaker };
    this.pendingSegments.push(enriched);
    while (this.pendingSegments.length > DEFAULTS.maxQueuedSegments) this.pendingSegments.shift();

    this.totalSegments += 1;
    this.lastKnownSpeaker = speaker;
    els.currentSpeaker.textContent = `speaker ${speaker}`;
    els.segmentCount.textContent = String(this.totalSegments);
    els.speakerDebug.textContent = `${this.speakers.lastDecision}; known speakers: ${this.speakers.centroids.size}`;
    this.setButtons();
    return enriched;
  }

  consumeSegmentsForText() {
    if (!this.pendingSegments.length) return [];
    const segments = this.pendingSegments.slice();
    this.pendingSegments = [];
    return segments;
  }

  buildTurnPatchFromSegments(segments, base) {
    if (segments.length) {
      return {
        ...base,
        startMs: segments[0].startMs,
        endMs: segments[segments.length - 1].endMs,
        speaker: dominantSpeaker(segments),
        segments: segments.map(({ id, startMs, endMs, durationMs, speaker }) => ({ id, startMs, endMs, durationMs, speaker })),
      };
    }
    return base;
  }

  commitText(text, confidence = null, source = "recognizer", { tentative = false } = {}) {
    const clean = restoreBasicPunctuation(text);
    if (!clean) return null;

    const segments = this.consumeSegmentsForText();
    const speaker = segments.length ? dominantSpeaker(segments) : this.lastKnownSpeaker;
    const nowMs = this.segmenter.sampleClock ? (this.segmenter.sampleClock / TARGET_SAMPLE_RATE) * 1000 : this.lastTurnEndMs;
    const estimatedMs = Math.max(650, normalizedWords(clean).length * 320);
    const startMs = segments.length ? segments[0].startMs : Math.max(this.lastTurnEndMs, nowMs - estimatedMs);
    const endMs = segments.length ? segments[segments.length - 1].endMs : Math.max(startMs + estimatedMs, nowMs);

    const turn = this.store.addTextTurn({
      startMs,
      endMs,
      speaker,
      text: clean,
      confidence,
      source,
      tentative,
      segments: segments.map(({ id, startMs, endMs, durationMs, speaker }) => ({ id, startMs, endMs, durationMs, speaker })),
    });

    if (turn) {
      this.lastTurnEndMs = Math.max(this.lastTurnEndMs, turn.endMs);
      this.renderTranscript();
      this.setStatus("Live", turn.tentative ? "Transcript draft preserved from interim recognizer text." : "Transcript updated from final recognizer text.", "live");
    }
    return turn;
  }

  renderMeetingName() {
    els.meetingName.textContent = `Started ${this.store.meetingStartedAt.toLocaleString()}`;
  }

  renderTranscript() {
    els.transcript.innerHTML = "";
    for (const turn of this.store.turns) {
      if (!turn.text || !turn.text.trim()) continue;
      const node = els.turnTemplate.content.firstElementChild.cloneNode(true);
      node.querySelector(".speaker-pill").textContent = `speaker ${turn.speaker}${turn.tentative ? " · draft" : ""}`;
      node.querySelector(".turn-meta").textContent = `${formatClock(turn.startMs)} – ${formatClock(turn.endMs)}${turn.confidence ? ` · confidence ${(turn.confidence * 100).toFixed(0)}%` : ""}${turn.source ? ` · ${turn.source}` : ""}`;
      node.querySelector(".turn-text").textContent = turn.text.trim();
      els.transcript.appendChild(node);
    }
    els.transcript.scrollTop = els.transcript.scrollHeight;
    this.setButtons();
  }

  download(kind) {
    const isJson = kind === "json";
    const content = isJson ? this.store.toJSON() : this.store.toText();
    const blob = new Blob([content], { type: isJson ? "application/json" : "text/plain" });
    const a = document.createElement("a");
    const stamp = this.store.meetingStartedAt.toISOString().replace(/[:.]/g, "-");
    a.href = URL.createObjectURL(blob);
    a.download = `browser_transcript_${stamp}.${isJson ? "json" : "txt"}`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  setStatus(title, detail, state) {
    els.statusText.textContent = title;
    els.statusDetail.textContent = detail;
    els.statusDot.className = `dot ${state || ""}`;
  }

  setButtons() {
    els.startBtn.disabled = this.running;
    els.pauseBtn.disabled = !this.running;
    els.newMeetingBtn.disabled = false;
    const hasTranscript = this.store.turns.some((t) => t.text && t.text.trim());
    els.downloadTxtBtn.disabled = !hasTranscript;
    els.downloadJsonBtn.disabled = !hasTranscript;
  }
}

function concatFloat32(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function downsample(input, fromRate, toRate) {
  const src = input instanceof Float32Array ? input : new Float32Array(input);
  if (fromRate === toRate) return src;
  const ratio = fromRate / toRate;
  const newLength = Math.max(1, Math.floor(src.length / ratio));
  const out = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(src.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) { sum += src[j]; count++; }
    out[i] = count ? sum / count : src[start] || 0;
  }
  return out;
}

function rootMeanSquare(frame) {
  let sum = 0;
  for (const x of frame) sum += x * x;
  return Math.sqrt(sum / frame.length);
}

function zeroCrossingRate(frame) {
  let crossings = 0;
  for (let i = 1; i < frame.length; i++) {
    if ((frame[i - 1] >= 0 && frame[i] < 0) || (frame[i - 1] < 0 && frame[i] >= 0)) crossings++;
  }
  return crossings / frame.length;
}

function buildAcousticEmbedding(audio, sampleRate) {
  const voiced = trimToSpeechCore(audio, sampleRate);
  const frameSize = Math.round(sampleRate * 0.030);
  const hop = Math.round(sampleRate * 0.012);
  if (voiced.length < frameSize) return null;

  const melCenters = melSpacedFrequencies(80, Math.min(7600, sampleRate / 2 - 100), 26);
  const vectorFrames = [];

  for (let start = 0; start + frameSize <= voiced.length; start += hop) {
    const frame = voiced.slice(start, start + frameSize);
    applyPreEmphasis(frame);
    applyHann(frame);

    const rms = rootMeanSquare(frame);
    if (rms < 0.002) continue;

    const logBands = melCenters.map((freq) => Math.log(goertzelPower(frame, sampleRate, freq) + 1e-12));
    const meanBand = mean(logBands);
    const normalizedBands = logBands.map((x) => x - meanBand);
    const cepstra = dct(normalizedBands, 12);
    const pitchHz = estimatePitch(frame, sampleRate);
    const pitchNorm = pitchHz ? Math.log(pitchHz / 120) : 0;
    const voicing = pitchHz ? 1 : 0;
    const zcr = zeroCrossingRate(frame);
    const centroid = spectralCentroidFromBands(logBands, melCenters) / (sampleRate / 2);
    const flatness = spectralFlatness(logBands);

    // Pitch and spectral-shape weights are intentionally >1 because browser-only
    // diarization needs the most speaker-specific primitive cues available.
    vectorFrames.push([
      ...cepstra.map((x, i) => i === 0 ? x * 0.5 : x),
      pitchNorm * 2.2,
      voicing * 1.4,
      zcr,
      centroid,
      flatness,
      Math.log(rms + 1e-8) * 0.25,
    ]);
  }

  if (vectorFrames.length < 3) return null;
  const dims = vectorFrames[0].length;
  const means = new Array(dims).fill(0);
  for (const v of vectorFrames) for (let i = 0; i < dims; i++) means[i] += v[i];
  for (let i = 0; i < dims; i++) means[i] /= vectorFrames.length;

  const stds = new Array(dims).fill(0);
  for (const v of vectorFrames) for (let i = 0; i < dims; i++) stds[i] += (v[i] - means[i]) ** 2;
  for (let i = 0; i < dims; i++) stds[i] = Math.sqrt(stds[i] / vectorFrames.length);

  const p10 = percentileVector(vectorFrames, 0.10);
  const p90 = percentileVector(vectorFrames, 0.90);
  return l2Normalize([...means, ...stds, ...p10, ...p90]);
}

function trimToSpeechCore(audio, sampleRate) {
  const frameSize = Math.round(sampleRate * 0.020);
  const hop = frameSize;
  if (audio.length < frameSize * 3) return audio;

  const energies = [];
  for (let start = 0; start + frameSize <= audio.length; start += hop) {
    energies.push(rootMeanSquare(audio.slice(start, start + frameSize)));
  }
  const sorted = [...energies].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.25)] || 0;
  const peak = sorted[sorted.length - 1] || floor;
  const threshold = Math.max(0.002, floor + (peak - floor) * 0.18);

  let first = 0;
  let last = energies.length - 1;
  while (first < energies.length && energies[first] < threshold) first++;
  while (last > first && energies[last] < threshold) last--;

  const startSample = Math.max(0, (first - 1) * hop);
  const endSample = Math.min(audio.length, (last + 2) * hop);
  return audio.slice(startSample, endSample);
}

function applyPreEmphasis(frame) {
  let previous = frame[0];
  for (let i = 1; i < frame.length; i++) {
    const current = frame[i];
    frame[i] = current - 0.97 * previous;
    previous = current;
  }
}

function applyHann(frame) {
  const n = frame.length;
  for (let i = 0; i < n; i++) frame[i] *= 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
}

function goertzelPower(samples, sampleRate, freq) {
  const n = samples.length;
  const k = Math.max(1, Math.min(Math.floor(n / 2) - 1, Math.round((n * freq) / sampleRate)));
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);
  let q0 = 0, q1 = 0, q2 = 0;
  for (let i = 0; i < n; i++) {
    q0 = coeff * q1 - q2 + samples[i];
    q2 = q1;
    q1 = q0;
  }
  return q1 * q1 + q2 * q2 - coeff * q1 * q2;
}

function spectralCentroidFromBands(logPowers, centers) {
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < logPowers.length; i++) {
    const power = Math.exp(logPowers[i]);
    weighted += power * centers[i];
    total += power;
  }
  return total ? weighted / total : 0;
}

function spectralFlatness(logPowers) {
  const powers = logPowers.map(Math.exp);
  const geo = Math.exp(powers.reduce((s, p) => s + Math.log(p + 1e-12), 0) / powers.length);
  const arith = powers.reduce((s, p) => s + p, 0) / powers.length;
  return arith ? geo / arith : 0;
}

function estimatePitch(frame, sampleRate) {
  const minLag = Math.floor(sampleRate / 420);
  const maxLag = Math.floor(sampleRate / 70);
  let bestLag = 0;
  let best = 0;
  let energy = 0;
  for (const x of frame) energy += x * x;
  if (energy < 1e-5) return 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    let delayedEnergy = 0;
    for (let i = 0; i < frame.length - lag; i++) {
      corr += frame[i] * frame[i + lag];
      delayedEnergy += frame[i + lag] * frame[i + lag];
    }
    const norm = corr / Math.sqrt(Math.max(1e-12, energy * delayedEnergy));
    if (norm > best) { best = norm; bestLag = lag; }
  }
  return best > 0.30 && bestLag ? sampleRate / bestLag : 0;
}

function melSpacedFrequencies(minHz, maxHz, count) {
  const hzToMel = (hz) => 2595 * Math.log10(1 + hz / 700);
  const melToHz = (mel) => 700 * (10 ** (mel / 2595) - 1);
  const minMel = hzToMel(minHz);
  const maxMel = hzToMel(maxHz);
  const out = [];
  for (let i = 0; i < count; i++) out.push(melToHz(minMel + ((maxMel - minMel) * i) / (count - 1)));
  return out;
}

function dct(values, count) {
  const n = values.length;
  const out = [];
  for (let k = 0; k < count; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[i] * Math.cos((Math.PI / n) * (i + 0.5) * k);
    out.push(sum / Math.sqrt(n));
  }
  return out;
}

function percentileVector(frames, p) {
  const dims = frames[0].length;
  const out = [];
  const idx = Math.max(0, Math.min(frames.length - 1, Math.floor((frames.length - 1) * p)));
  for (let d = 0; d < dims; d++) {
    const values = frames.map((v) => v[d]).sort((a, b) => a - b);
    out.push(values[idx]);
  }
  return out;
}

function dominantSpeaker(segments) {
  const bySpeaker = new Map();
  for (const segment of segments) {
    bySpeaker.set(segment.speaker, (bySpeaker.get(segment.speaker) || 0) + Math.max(1, segment.durationMs));
  }
  let bestSpeaker = segments[segments.length - 1]?.speaker || 1;
  let bestMs = -1;
  for (const [speaker, ms] of bySpeaker) {
    if (ms > bestMs) { bestMs = ms; bestSpeaker = speaker; }
  }
  return bestSpeaker;
}

function mergeSegmentLists(left, right) {
  const seen = new Set();
  const out = [];
  for (const seg of [...left, ...right]) {
    const key = seg?.id ?? `${seg?.startMs}-${seg?.endMs}-${seg?.speaker}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(seg);
  }
  return out;
}

function shouldReplaceDraftTurn(previousText, nextText) {
  const previous = cleanRecognizerSpacing(previousText);
  const next = cleanRecognizerSpacing(nextText);
  if (!previous || !next) return false;
  if (previous === next) return true;
  if (isTokenPrefixRevision(previous, next) || isCompactPrefixRevision(previous, next)) return true;

  const pw = normalizedWords(previous);
  const nw = normalizedWords(next);
  if (looksLikeSameUtterance(previous, next) && nw.length >= pw.length) return true;
  return false;
}


function wordTokens(text) {
  const tokens = [];
  const re = /[\p{L}\p{N}']+/gu;
  let match;
  const value = String(text || "");
  while ((match = re.exec(value)) !== null) {
    tokens.push({ raw: match[0], norm: match[0].toLowerCase(), start: match.index, end: re.lastIndex });
  }
  return tokens;
}

function normalizedWords(text) {
  return wordTokens(text).map((token) => token.norm);
}

function containsContiguousWords(haystack, needle) {
  if (!needle.length || needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

function tailHeadOverlap(leftWords, rightWords) {
  const max = Math.min(leftWords.length, rightWords.length);
  for (let k = max; k >= 1; k--) {
    let ok = true;
    for (let i = 0; i < k; i++) {
      if (leftWords[leftWords.length - k + i] !== rightWords[i]) { ok = false; break; }
    }
    if (ok) return k;
  }
  return 0;
}

function stripCommittedOverlap(candidate, recentText) {
  const clean = cleanRecognizerSpacing(candidate);
  const tokens = wordTokens(clean);
  const candidateWords = tokens.map((token) => token.norm);
  const recentWords = normalizedWords(recentText);
  if (!candidateWords.length) return "";

  // Same words already committed recently, possibly with different punctuation.
  if (containsContiguousWords(recentWords, candidateWords)) return "";

  const overlap = tailHeadOverlap(recentWords, candidateWords);
  const minimumUsefulOverlap = candidateWords.length <= 5 ? 2 : 3;
  if (overlap >= candidateWords.length) return "";
  if (overlap >= minimumUsefulOverlap && tokens[overlap]) {
    return clean.slice(tokens[overlap].start).replace(/^[\s,.;:!?—-]+/, "").trim();
  }
  return clean;
}


function isTokenPrefixRevision(shorterText, longerText) {
  const shorter = normalizedWords(shorterText);
  const longer = normalizedWords(longerText);
  if (!shorter.length || !longer.length || shorter.length > longer.length) return false;
  for (let i = 0; i < shorter.length; i++) {
    const a = shorter[i];
    const b = longer[i];
    if (a === b) continue;
    // Chrome interim hypotheses often expose partial tokens: "st" → "stag"
    // → "stagger" → "staggered". The shorter one is a draft of the
    // same utterance, not speech to commit.
    if (i === shorter.length - 1 && b.startsWith(a) && a.length >= 1) continue;
    return false;
  }
  return true;
}

function isCompactPrefixRevision(a, b) {
  const compact = (text) => normalizedWords(text).join("").replace(/[^\p{L}\p{N}]+/gu, "");
  const ca = compact(a);
  const cb = compact(b);
  return Boolean(ca && cb && ca !== cb && (ca.startsWith(cb) || cb.startsWith(ca)));
}

function looksLikeSameUtterance(a, b) {
  const aw = normalizedWords(a);
  const bw = normalizedWords(b);
  if (!aw.length || !bw.length) return true;
  if (containsContiguousWords(aw, bw) || containsContiguousWords(bw, aw)) return true;
  if (isTokenPrefixRevision(a, b) || isTokenPrefixRevision(b, a) || isCompactPrefixRevision(a, b)) return true;
  const longer = aw.length >= bw.length ? aw : bw;
  const shorter = aw.length >= bw.length ? bw : aw;
  const overlap = orderedOverlapRatio(longer, shorter);
  if (overlap >= 0.58) return true;
  return tailHeadOverlap(aw, bw) >= 2 || tailHeadOverlap(bw, aw) >= 2;
}

function chooseMoreCompleteRecognizerText(previous, next) {
  const prev = cleanRecognizerSpacing(previous);
  const cur = cleanRecognizerSpacing(next);
  if (!prev) return cur;
  if (!cur) return prev;
  if (!looksLikeSameUtterance(prev, cur)) return cur;

  const pw = normalizedWords(prev);
  const cw = normalizedWords(cur);
  if (isTokenPrefixRevision(prev, cur) || isCompactPrefixRevision(prev, cur)) return cur;
  if (isTokenPrefixRevision(cur, prev) || isCompactPrefixRevision(cur, prev)) return prev;
  if (cw.length > pw.length) return cur;
  if (cw.length === pw.length && cur.length > prev.length && orderedOverlapRatio(cw, pw) > 0.7) return cur;
  if (cw.length === pw.length && punctuationScore(cur) > punctuationScore(prev)) return cur;
  return prev;
}

function punctuationScore(text) {
  const matches = String(text || "").match(/[,.!?;:]/g);
  return matches ? matches.length : 0;
}

function mergeTranscriptTexts(previous, next) {
  const a = cleanRecognizerSpacing(previous);
  const b = cleanRecognizerSpacing(next);
  if (!a) return restoreBasicPunctuation(b);
  if (!b) return restoreBasicPunctuation(a);
  const stripped = stripCommittedOverlap(b, a);
  if (!stripped) return restoreBasicPunctuation(a);
  return restoreBasicPunctuation(`${a} ${stripped}`);
}

function cleanRecognizerSpacing(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

function cleanTranscriptText(text) {
  return restoreBasicPunctuation(cleanRecognizerSpacing(text));
}

function chooseBestRecognizerText(finalText, interimText) {
  const finalClean = cleanRecognizerSpacing(finalText);
  const interimClean = cleanRecognizerSpacing(interimText);
  if (!finalClean) return interimClean;
  if (!interimClean) return finalClean;

  if (looksLikeSameUtterance(finalClean, interimClean)) {
    const chosen = chooseMoreCompleteRecognizerText(finalClean, interimClean);
    if (chosen !== finalClean) return chosen;
  }

  const finalWords = wordsOnly(finalClean);
  const interimWords = wordsOnly(interimClean);
  if (interimWords.length >= finalWords.length + 2) {
    const overlap = orderedOverlapRatio(interimWords, finalWords);
    const finalIsSuffix = finalWords.length > 0 && interimWords.slice(-finalWords.length).join(" ") === finalWords.join(" ");
    if (finalIsSuffix || overlap > 0.72) return interimClean;
  }
  return finalClean;
}

function restoreBasicPunctuation(text) {
  let out = cleanRecognizerSpacing(text);
  if (!out) return "";

  out = out
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\bcomma\b/gi, ",")
    .replace(/\bperiod\b/gi, ".")
    .replace(/\bfull stop\b/gi, ".")
    .replace(/\bquestion mark\b/gi, "?")
    .replace(/\bexclamation mark\b/gi, "!");

  // Preserve browser punctuation when it exists, but make naked recognizer
  // output consistent enough to read. This is deliberately conservative:
  // it only adds punctuation at obvious boundaries instead of inventing a
  // heavily rewritten transcript.
  if (!/[.!?…]$/.test(out)) {
    out += looksLikeQuestion(out) ? "?" : ".";
  }

  out = out.replace(/^\s*(okay|ok|yeah|yes|no|well|so|also|actually|basically|right)\b(?![,])/i, (_, word) => `${word},`);
  out = out.replace(/\bi\b/g, "I");
  out = out.replace(/(^|[.!?]\s+)([a-z])/g, (_, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
  return out.trim();
}

function looksLikeQuestion(text) {
  return /^(who|what|when|where|why|how|do|does|did|is|are|am|can|could|would|should|will|was|were|have|has|had)\b/i.test(cleanRecognizerSpacing(text));
}

function wordsOnly(text) {
  return normalizedWords(text);
}

function orderedOverlapRatio(longer, shorter) {
  if (!shorter.length) return 0;
  let cursor = 0;
  let matched = 0;
  for (const word of shorter) {
    while (cursor < longer.length && longer[cursor] !== word) cursor++;
    if (cursor < longer.length) {
      matched++;
      cursor++;
    }
  }
  return matched / shorter.length;
}

function mean(values) { return values.reduce((s, x) => s + x, 0) / values.length; }
function vectorNorm(v) { return Math.sqrt(v.reduce((s, x) => s + x * x, 0)); }
function l2Normalize(v) {
  const norm = vectorNorm(v);
  return norm > 0 ? v.map((x) => x / norm) : v;
}
function cosineDistance(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 1;
  return 1 - dot / Math.sqrt(na * nb);
}
function weightedAdd(a, aw, b, bw) { return a.map((x, i) => x * aw + b[i] * bw); }
function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

const app = new BrowserTranscriber();

els.vadSensitivity.addEventListener("input", () => {
  els.vadSensitivityValue.textContent = `${els.vadSensitivity.value} dB`;
});
els.speakerThreshold.addEventListener("input", () => {
  els.speakerThresholdValue.textContent = (Number(els.speakerThreshold.value) / 100).toFixed(2);
});
els.startBtn.addEventListener("click", async () => {
  try { await app.start(); } catch { app.running = false; app.setButtons(); }
});
els.pauseBtn.addEventListener("click", () => app.pause());
els.newMeetingBtn.addEventListener("click", () => app.newMeeting());
els.clearBtn.addEventListener("click", () => app.clear());
els.downloadTxtBtn.addEventListener("click", () => app.download("txt"));
els.downloadJsonBtn.addEventListener("click", () => app.download("json"));

els.vadSensitivityValue.textContent = `${els.vadSensitivity.value} dB`;
els.speakerThresholdValue.textContent = (Number(els.speakerThreshold.value) / 100).toFixed(2);

// Service worker registration is intentionally disabled in v7. During rapid
// testing, stale PWA caches made it too easy to run an older build by accident.
// Host this folder as static files; the browser will fetch the current JS.

if (!app.supported()) {
  app.setStatus("Unsupported", "Use Chrome on localhost or HTTPS. SpeechRecognition, getUserMedia, and AudioWorklet are required.", "error");
}

// Exposed only to make local smoke tests possible without changing runtime behavior.
window.__browserTranscriberTest = {
  chooseBestRecognizerText,
  chooseMoreCompleteRecognizerText,
  stripCommittedOverlap,
  restoreBasicPunctuation,
  isTokenPrefixRevision,
  isCompactPrefixRevision,
  looksLikeSameUtterance,
  shouldReplaceDraftTurn,
  mergeSegmentLists,
  buildAcousticEmbedding,
  cosineDistance,
  SpeakerTracker,
  BrowserTranscriber,
  TranscriptStore,
  app,
};
