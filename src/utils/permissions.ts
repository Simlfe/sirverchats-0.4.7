export interface PermissionResult {
  granted: boolean;
  state?: 'granted' | 'denied' | 'prompt';
  error?: string;
}

export interface MicrophoneAcquisitionResult extends PermissionResult {
  track?: MediaStreamTrack;
}

type PermissionChangeCallback = (type: 'microphone' | 'camera', state: 'granted' | 'denied' | 'prompt') => void;
const permissionListeners = new Set<PermissionChangeCallback>();

let isMonitoringStarted = false;

function startPermissionMonitoring() {
  if (isMonitoringStarted || typeof navigator === 'undefined' || !navigator.permissions?.query) return;
  isMonitoringStarted = true;

  const monitorDevice = async (name: 'microphone' | 'camera') => {
    try {
      const status = await navigator.permissions.query({ name: name as any });
      status.onchange = () => {
        console.log(`[Permissions] OS permission changed for ${name}: ${status.state}`);
        permissionListeners.forEach((cb) => cb(name, status.state as any));
      };
    } catch {
      // Permission query not supported for this name on this platform
    }
  };

  monitorDevice('microphone');
  monitorDevice('camera');

  if (navigator.mediaDevices) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      console.log('[Permissions] Media devices changed in OS');
      permissionListeners.forEach((cb) => cb('microphone', 'granted'));
    });
  }
}

export function subscribeToPermissionChanges(callback: PermissionChangeCallback): () => void {
  startPermissionMonitoring();
  permissionListeners.add(callback);
  return () => {
    permissionListeners.delete(callback);
  };
}

/**
 * Checks and requests runtime microphone permissions cleanly.
 * Never assumes permissions exist; prompts the user or webview appropriately.
 */
export async function checkAndRequestMicrophonePermission(): Promise<PermissionResult> {
  startPermissionMonitoring();

  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return {
      granted: false,
      state: 'denied',
      error: 'Audio capture device interface is unavailable in this browser environment.',
    };
  }

  try {
    // Check permission state via Permission API if supported
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const status = await navigator.permissions.query({ name: 'microphone' as any });
        if (status.state === 'granted') {
          return { granted: true, state: 'granted' };
        }
        // In WebKit2GTK on Linux, status.state may report 'denied' prior to first prompt;
        // fall through directly to getUserMedia to initiate the system prompt.
      } catch {
        // Fallthrough to getUserMedia test
      }
    }

    // Request stream permission explicitly
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Cleanup probe stream
    stream.getTracks().forEach((track) => track.stop());
    return { granted: true, state: 'granted' };
  } catch (err: any) {
    console.warn('[Permissions] Microphone access denied or failed:', err);
    const isDenied =
      err?.name === 'NotAllowedError' ||
      err?.name === 'PermissionDeniedError' ||
      err?.message?.toLowerCase().includes('denied') ||
      err?.message?.toLowerCase().includes('permission');

    return {
      granted: false,
      state: isDenied ? 'denied' : 'prompt',
      error: isDenied
        ? 'Voice chat requires microphone access to transmit your audio. Microphone permission was denied in your browser or OS settings. Please grant microphone access and try again.'
        : err?.message || 'Failed to access microphone.',
    };
  }
}

/**
 * Acquires the microphone exactly once for an explicit Join/Accept action.
 * The caller owns the returned track until the media provider adopts it and
 * must stop it if token/module preparation or the join itself fails.
 */
export async function acquireMicrophoneForJoin(): Promise<MicrophoneAcquisitionResult> {
  startPermissionMonitoring();

  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return {
      granted: false,
      state: 'denied',
      error: 'Audio capture device interface is unavailable in this browser environment.',
    };
  }

  const selectedMicId = typeof window !== 'undefined' ? window.localStorage?.getItem('selected_audio_input') : null;
  const audio: MediaTrackConstraints & Record<string, unknown> = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 },
    googEchoCancellation: true,
    googAutoGainControl: true,
    googNoiseSuppression: true,
    googHighpassFilter: true,
    googTypingNoiseDetection: false,
  };
  if (selectedMicId && selectedMicId !== 'default') {
    audio.deviceId = { exact: selectedMicId };
  }

  try {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audio as MediaTrackConstraints });
    } catch (initialErr: any) {
      if (initialErr?.name === 'NotAllowedError' || initialErr?.name === 'PermissionDeniedError') {
        throw initialErr;
      }
      // A removed/stale selected device must not block joining with the OS
      // default input.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    }

    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach((candidate) => candidate.stop());
      return {
        granted: false,
        state: 'prompt',
        error: 'No microphone track was returned by the selected input device.',
      };
    }
    track.enabled = true;
    return { granted: true, state: 'granted', track };
  } catch (err: any) {
    const isDenied =
      err?.name === 'NotAllowedError' ||
      err?.name === 'PermissionDeniedError' ||
      err?.message?.toLowerCase().includes('denied') ||
      err?.message?.toLowerCase().includes('permission');
    return {
      granted: false,
      state: isDenied ? 'denied' : 'prompt',
      error: isDenied
        ? 'Voice chat requires microphone access to transmit your audio. Microphone permission was denied in your browser or OS settings. Please grant microphone access and try again.'
        : err?.message || 'Failed to access microphone.',
    };
  }
}

/**
 * Checks and requests runtime camera permissions cleanly.
 */
export async function checkAndRequestCameraPermission(): Promise<PermissionResult> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return {
      granted: false,
      error: 'Camera device interface is unavailable in this browser environment.',
    };
  }

  try {
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const status = await navigator.permissions.query({ name: 'camera' as any });
        if (status.state === 'granted') {
          return { granted: true };
        }
      } catch {
        // Fallthrough
      }
    }

    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach((track) => track.stop());
    return { granted: true };
  } catch (err: any) {
    console.warn('[Permissions] Camera access denied or failed:', err);
    const isDenied =
      err?.name === 'NotAllowedError' ||
      err?.name === 'PermissionDeniedError' ||
      err?.message?.toLowerCase().includes('denied') ||
      err?.message?.toLowerCase().includes('permission');

    return {
      granted: false,
      error: isDenied
        ? 'Camera permission was denied. Please grant camera access in your browser or device settings.'
        : err?.message || 'Failed to access camera.',
    };
  }
}

/**
 * Checks screen sharing / MediaProjection availability.
 */
export async function checkAndRequestScreenSharePermission(): Promise<PermissionResult> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
    return {
      granted: false,
      error: 'Screen sharing / MediaProjection is not supported on this device/browser platform.',
    };
  }
  return { granted: true };
}
