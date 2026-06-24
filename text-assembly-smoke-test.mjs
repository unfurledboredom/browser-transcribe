import fs from 'node:fs';
import vm from 'node:vm';

function el(id) {
  const base = {
    id,
    textContent: '',
    innerHTML: '',
    value: id === 'speakerThreshold' ? '12' : id === 'maxSpeakers' ? '6' : id === 'vadSensitivity' ? '6' : id === 'language' ? 'en-US' : '',
    disabled: false,
    style: {},
    className: '',
    addEventListener() {},
    appendChild() {},
    querySelector() { return el('child'); },
    scrollTop: 0,
    scrollHeight: 0,
  };
  if (id === 'turnTemplate') {
    base.content = { firstElementChild: { cloneNode: () => ({ querySelector: () => el('child') }) } };
  }
  return base;
}

const context = {
  console,
  setTimeout,
  clearTimeout,
  performance: { now: () => Date.now() },
  crypto: { randomUUID: () => `uuid-${Math.random()}` },
  Blob: class {},
  URL: { createObjectURL: () => 'blob:', revokeObjectURL() {} },
  AudioContext: class {},
  window: {},
  navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
  document: { getElementById: (id) => el(id), createElement: () => ({ click() {} }) },
};
context.window = context.window;
context.window.SpeechRecognition = function() {};
context.window.webkitSpeechRecognition = context.window.SpeechRecognition;
context.window.AudioWorkletNode = function() {};
context.AudioWorkletNode = context.window.AudioWorkletNode;

vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8'), context);
const t = context.window.__browserTranscriberTest;

const store = new t.TranscriptStore();
store.addTextTurn({ startMs: 0, endMs: 100, speaker: 1, text: 'St.', source: 'vad-segment-closed', tentative: true, segments: [{ id: 1 }] });
store.addTextTurn({ startMs: 100, endMs: 200, speaker: 1, text: 'Stag.', source: 'recognition-interim', tentative: true, segments: [{ id: 1 }] });
store.addTextTurn({ startMs: 200, endMs: 300, speaker: 1, text: 'Stagger.', source: 'recognition-interim', tentative: true, segments: [{ id: 1 }] });
store.addTextTurn({ startMs: 300, endMs: 800, speaker: 1, text: 'Staggered out of bed and glared', source: 'chrome-final', tentative: false, segments: [{ id: 1 }] });

const shortStore = new t.TranscriptStore();
shortStore.addTextTurn({ startMs: 0, endMs: 300, speaker: 1, text: 'go', source: 'vad-segment-closed', tentative: true, segments: [{ id: 2 }] });
shortStore.addTextTurn({ startMs: 1400, endMs: 1800, speaker: 1, text: 'I agree', source: 'chrome-final', tentative: false, segments: [{ id: 3 }] });



// Recognition-ledger tests: interim snapshots update one live hypothesis; only
// a single fallback draft is committed when Chrome fails to send a final.
const app = t.app;
app.clear();
app.receiveInterimHypothesis('St.');
app.receiveInterimHypothesis('Stag.');
app.receiveInterimHypothesis('Stagger.');
app.receiveInterimHypothesis('Staggered out of bed and glared');
app.promoteCurrentInterim('test-idle', { close: false });
app.commitFinalText('Staggered out of bed and glared', 0.9);

app.clear();
app.receiveInterimHypothesis('this sentence was visible in the detection area');
app.promoteCurrentInterim('test-interim-removed', { close: true });
const recoveredInterim = app.store.turns[0]?.text;

const checks = [
  ['prefix St -> Stag is same utterance', t.looksLikeSameUtterance('St.', 'Stag.') === true],
  ['prefix Stag -> Stagger is same utterance', t.looksLikeSameUtterance('Stag.', 'Stagger.') === true],
  ['prefix Stagger -> full is same utterance', t.looksLikeSameUtterance('Stagger.', 'Staggered out of bed and glared') === true],
  ['long interim beats short overlapping final', t.chooseBestRecognizerText('bed and glared', 'Staggered out of bed and glared') === 'Staggered out of bed and glared'],
  ['draft prefix turns are replaced', store.turns.length === 1],
  ['final text replaces prefix chain', store.turns[0]?.text === 'Staggered out of bed and glared.'],
  ['final replacement is no longer tentative', store.turns[0]?.tentative === false],
  ['short VAD-backed speech remains', shortStore.turns[0]?.text === 'Go.'],
  ['later distinct short speech is not swallowed', shortStore.turns[1]?.text === 'I agree.'],
  ['ledger keeps one draft for growing prefixes', app.store.turns.length === 1],
  ['ledger final replaces fallback draft', app.store.turns[0]?.text === 'This sentence was visible in the detection area.'],
  ['visible interim is recoverable without final', recoveredInterim === 'This sentence was visible in the detection area.'],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
