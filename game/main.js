import { Settings, detectQuality } from './app/settings.js';
import { Journal } from './gameplay/discoveries.js';
import { Run } from './gameplay/run.js';
import { HUD } from './ui/hud.js';
import { Panels } from './ui/panels.js';
import { fetchGlobalScores, submitGlobalScore } from './leaderboard.js';
import { loadScores, saveScore, sanitizeName } from './model.js';

/**
 * Entry point. The HTML, portfolio panels and launch screen work immediately;
 * the 3D universe (three.js, workers, models) streams in behind them and the
 * launch button unlocks when it is ready. If WebGL is unavailable the page
 * degrades to the reading version.
 */
const $ = id => document.getElementById(id);
const settings = new Settings();
const journal = new Journal();
const run = new Run();
const hud = new HUD();
let game = null;
let local = []; try { local = loadScores(localStorage); } catch { /* storage unavailable */ }
const board = { mode: 'local', rows: local, loading: false, notice: 'Saved on this device only.', lastSaved: '' };

const provider = {
  get journal() { return journal; }, get settings() { return settings; }, get run() { return run; }, get board() { return board; },
  get ready() { return Boolean(game?.ready); }, get playing() { return Boolean(game?.playing); },
  get world() { return game?.worldId ?? null; }, get quality() { return game?.quality ?? detectQuality(settings.get('quality')); },
  get medals() { return game?.slipstream?.medals ?? null; },
};

const panels = new Panels(provider, (type, detail = {}) => {
  switch (type) {
    case 'travel': game?.travel(detail.world); break;
    case 'settings': settings.set(detail); break;
    case 'saveScore': saveRun(detail.name); break;
    case 'reset': journal.reset(); game?.onJournalReset(); hud.toast('Journal cleared. Every discovery is waiting again.'); break;
    case 'respawn': panels.close(); game?.respawn(); break;
    case 'course': panels.close(); game?.course(detail.target); break;
    case 'buyPedal': {
      const level = journal.buyPedal(detail.pedal);
      if (level) { game?.applyLoadout(); game?.sound.play('levelUp'); hud.setTone(journal.data.tone); panels.justEngaged = detail.pedal; }
      else game?.sound.play('denied');
      panels.render();
      break;
    }
    case 'panelOpened': game?.setPaused(true, detail.panel); break;
    case 'panelClosed': game?.setPaused(false, detail.panel); break;
    default: break;
  }
});

// ---- topbar sound toggle
const soundButton = $('sound-toggle');
function reflectSound() {
  const on = Boolean(settings.get('sound'));
  soundButton.setAttribute('aria-pressed', String(on));
  soundButton.setAttribute('aria-label', on ? 'Turn sound off' : 'Turn sound on');
  soundButton.classList.toggle('is-on', on);
}
soundButton.addEventListener('click', () => settings.set({ sound: !settings.get('sound') }));
settings.onChange(patch => { if ('sound' in patch) reflectSound(); });
reflectSound();
document.body.classList.toggle('reduce-motion', settings.reducedMotion);
settings.onChange(() => document.body.classList.toggle('reduce-motion', settings.reducedMotion));

// ---- flight log
// Time spent in a hidden tab is not play time.
document.addEventListener('visibilitychange', () => run.pause(document.hidden, 'hidden'));
async function saveRun(name) {
  if (board.loading) return;
  const signature = `${run.score}:${run.kills}:${run.xp}`;
  if (signature === board.lastSaved) { hud.toast('This run is already in your flight log.'); return; }
  if (!run.score) { hud.toast('Explore or discover something to earn a score first.'); return; }
  const row = run.record(sanitizeName(name));
  if (board.mode === 'global') {
    board.loading = true; panels.renderScores();
    try {
      const result = await submitGlobalScore(row);
      board.rows = result.scores; board.lastSaved = signature;
      board.notice = result.ranked === false ? 'Score submitted. The public board keeps the top 100 runs.' : 'Score published to the community flight log.';
    } catch (error) {
      board.notice = error.status === 429 ? 'Too many requests. Wait a minute before publishing again.' : 'Publishing failed. Your run is still here; try again shortly.';
    } finally { board.loading = false; panels.renderScores(true); }
  } else {
    let result; try { result = saveScore(localStorage, board.rows, row); } catch { result = { rows: [...board.rows, row], persisted: false }; }
    board.rows = result.rows; board.lastSaved = signature;
    board.notice = result.persisted ? 'Run saved on this device.' : 'Run recorded for this visit; browser storage is unavailable.';
    panels.renderScores(true);
  }
}
(async () => {
  try {
    const result = await fetchGlobalScores();
    Object.assign(board, { mode: 'global', rows: result.scores, notice: 'Public community scores. Casual, unverified runs.' });
  } catch {
    board.notice = 'The community board is unavailable here. Runs are saved on this device.';
  }
  panels.renderScores(true);
})();

// ---- launch
const launchButton = $('launch-button'), launchText = $('launch-button-text');
function setLaunch(text, enabled) { launchText.textContent = text; launchButton.disabled = !enabled; }
function fail(message) {
  console.error(message);
  document.body.classList.add('is-error'); document.body.classList.remove('is-playing');
  $('launch-note').textContent = typeof message === 'string' ? message : 'This browser could not start the 3D world. The complete reading version is ready.';
}

launchButton.addEventListener('click', () => {
  if (!game?.ready) return;
  game.start();
});

if (location.hash === '#long-form') panels.open('philosophy');

function webglAvailable() {
  try { const c = document.createElement('canvas'); return Boolean(c.getContext('webgl2')); } catch { return false; }
}

if (!webglAvailable()) {
  fail('Your browser does not support WebGL 2, so the 3D world cannot start. The complete reading version is ready.');
} else {
  setLaunch('Initializing universe', false);
  import('./app/game.js').then(async ({ Game }) => {
    game = new Game({ canvas: $('game-canvas'), hud, panels, settings, journal, run, onProgress: text => setLaunch(text, false) });
    window.__unfolding = game;
    await game.init();
    setLaunch('Explore the universe', true);
  }).catch(error => {
    console.error('Unable to start the 3D portfolio', error);
    fail('The 3D world could not load in this browser. The complete reading version is ready.');
  });
}
