import { useEffect } from 'react';
import { useChatSocket } from '../../hooks/useChatSocket';
import { playNotificationSound, unlockSounds } from '../../lib/sounds';

/**
 * NotificationSoundBridge — plays the notification chime for every
 * notification, regardless of where it was raised.
 *
 * In Electron the main process owns the notification WebSocket (it must run
 * even when no window is focused) and asks the renderer to play the sound over
 * IPC. In the browser the bridge listens to the same chat WebSocket the rest of
 * the UI uses.
 *
 * Incoming calls are excluded: their ringtone is driven by the call state, and
 * a chime on top of it would be noise.
 */
export default function NotificationSoundBridge({ userId }) {
  const electronBridge =
    typeof window !== 'undefined' ? window.electronAPI?.notifications : null;
  const hasElectronSound = !!electronBridge?.onSound;

  useEffect(() => {
    if (!hasElectronSound) return undefined;
    return electronBridge.onSound(() => {
      unlockSounds();
      playNotificationSound();
    });
  }, [hasElectronSound, electronBridge]);

  useChatSocket(hasElectronSound ? null : userId, (message) => {
    if (message?.type !== 'NOTIFICATION') return;
    if (message.notification?.type === 'call_incoming') return;
    unlockSounds();
    playNotificationSound();
  });

  return null;
}
