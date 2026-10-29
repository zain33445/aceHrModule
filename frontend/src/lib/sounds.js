/**
 * sounds.js — tiny Web Audio sound engine for ringtones and notification
 * chimes.
 *
 * Everything is synthesised, so there are no binary assets to ship or load.
 * The engine is intentionally independent of React: the call context drives
 * the ringtones from its status changes, and the notification bridge plays the
 * chime for every notification.
 */

let ctx = null;
let master = null;

/** Looping timers, keyed by sound name. */
const timers = { ringback: null, incoming: null };

/** Oscillators that are currently scheduled, keyed by sound name. */
const sources = {
  ringback: new Set(),
  incoming: new Set(),
  notification: new Set(),
};

function getContext() {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;

  if (!ctx) {
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 1;
      master.connect(ctx.destination);
    } catch {
      ctx = null;
      master = null;
      return null;
    }
  }

  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
  return ctx;
}

/**
 * Resumes the audio context. Browsers only allow audio after a user gesture,
 * so this is wired to the first click/keypress as well as being called from
 * the call buttons.
 */
export function unlockSounds() {
  getContext();
}

if (typeof document !== 'undefined') {
  const unlock = () => {
    unlockSounds();
    document.removeEventListener('pointerdown', unlock, true);
    document.removeEventListener('keydown', unlock, true);
  };
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', unlock, true);
}

function playTone(context, { freq, start, duration, gain = 0.2, type = 'sine', bucket }) {
  const osc = context.createOscillator();
  const amp = context.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);

  // Short attack/release ramps avoid the click an abrupt gain change makes.
  amp.gain.setValueAtTime(0, start);
  amp.gain.linearRampToValueAtTime(gain, start + 0.02);
  amp.gain.setValueAtTime(gain, start + Math.max(0.03, duration - 0.05));
  amp.gain.linearRampToValueAtTime(0, start + duration);

  osc.connect(amp);
  amp.connect(master);
  osc.start(start);
  osc.stop(start + duration + 0.02);

  const set = sources[bucket];
  if (set) {
    set.add(osc);
    osc.onended = () => set.delete(osc);
  }
}

function stopBucket(bucket) {
  if (timers[bucket]) {
    clearInterval(timers[bucket]);
    timers[bucket] = null;
  }

  const set = sources[bucket];
  if (!set) return;
  for (const osc of Array.from(set)) {
    try {
      osc.stop();
    } catch {
      /* already stopped */
    }
    set.delete(osc);
  }
}

/**
 * Caller ringback: a classic 440/480 Hz dual tone, 1.6 s on / 2.4 s off.
 * Plays until the call is answered, declined, cancelled or dropped.
 */
export function startRingback() {
  if (timers.ringback) return;
  const context = getContext();
  if (!context) return;

  const play = () => {
    const start = context.currentTime + 0.05;
    playTone(context, { freq: 440, start, duration: 1.6, gain: 0.14, bucket: 'ringback' });
    playTone(context, { freq: 480, start, duration: 1.6, gain: 0.14, bucket: 'ringback' });
  };

  play();
  timers.ringback = setInterval(play, 4000);
}

export function stopRingback() {
  stopBucket('ringback');
}

/**
 * Incoming ringtone: deliberately louder and more urgent than the ringback.
 * Two short dual-tone bursts repeat until the user answers or declines.
 */
export function startIncomingRing() {
  if (timers.incoming) return;
  const context = getContext();
  if (!context) return;

  const play = () => {
    const start = context.currentTime + 0.05;
    for (const offset of [0, 0.45]) {
      playTone(context, {
        freq: 880,
        start: start + offset,
        duration: 0.35,
        gain: 0.5,
        bucket: 'incoming',
      });
      playTone(context, {
        freq: 1040,
        start: start + offset,
        duration: 0.35,
        gain: 0.5,
        bucket: 'incoming',
      });
    }
  };

  play();
  timers.incoming = setInterval(play, 2000);
}

export function stopIncomingRing() {
  stopBucket('incoming');
}

/** Short two-note chime used for every non-call notification. */
export function playNotificationSound() {
  const context = getContext();
  if (!context) return;

  const start = context.currentTime + 0.02;
  playTone(context, { freq: 880, start, duration: 0.12, gain: 0.2, bucket: 'notification' });
  playTone(context, {
    freq: 1175,
    start: start + 0.14,
    duration: 0.16,
    gain: 0.2,
    bucket: 'notification',
  });
}

/** Stops every looping ringtone (used when a call ends or the app unmounts). */
export function stopAllSounds() {
  stopRingback();
  stopIncomingRing();
}
