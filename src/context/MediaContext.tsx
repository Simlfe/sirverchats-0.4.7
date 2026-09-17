import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { User, Channel } from '../types';
import {
  MediaParticipant,
  MediaConnectionState,
  RoomConfig,
  IncomingCallEvent,
  MediaError,
  SFUServerConfig,
  SFUProviderAdapter,
  CameraQualityProfile,
  CameraTelemetryData,
  AudioOutputRoute,
} from '../types/media';
import realtimeMediaProvider from '../media/RealtimeMediaProvider';
import callSignalingService from '../services/callSignaling';
import { playJoinSound, playLeaveSound, setRingtoneMuted, getIsRingtoneMuted, stopAllRingtones, unlockAudioContext } from '../lib/sounds';
import { getServerMemberAvatarUrl, getServerMemberDisplayName, pbService, parseChannelOptions, mergeUserRecord } from '../pocketbase';
import {
  acquireMicrophoneForJoin,
  checkAndRequestCameraPermission,
  checkAndRequestScreenSharePermission,
} from '../utils/permissions';
import { voiceSessionRecovery } from '../services/voiceSessionRecovery';
import { recordCallLog } from '../services/callLogService';

export interface MediaContextType {
  activeRoom: RoomConfig | null;
  participants: MediaParticipant[];
  connectionState: MediaConnectionState;
  isMuted: boolean;
  isDeafened: boolean;
  isCameraEnabled: boolean;
  isScreenSharing: boolean;
  incomingCall: IncomingCallEvent | null;
  outgoingCall: IncomingCallEvent | null;
  isRingMuted: boolean;
  activeCallDuration: number;
  formattedDuration: string;
  error: MediaError | null;
  cameraQualityProfile: CameraQualityProfile;
  cameraTelemetry: CameraTelemetryData | null;
  audioOutputRoute: AudioOutputRoute;
  
  // Actions
  joinVoiceRoom: (channel: Channel, currentUser: User, mode?: 'voice' | 'video' | 'screen') => Promise<void>;
  startDmCall: (targetUser: User, currentUser: User, dmChannel: Channel, mode?: 'voice' | 'video' | 'screen') => Promise<void>;
  inviteUsersToCall: (targets: User[]) => Promise<number>;
  acceptCall: () => Promise<void>;
  declineCall: () => void;
  cancelOutgoingCall: () => void;
  toggleMuteRing: (muted?: boolean) => void;
  leaveRoomOrCall: () => Promise<void>;
  toggleMute: () => void;
  toggleDeafen: () => void;
  toggleCamera: () => Promise<void>;
  switchCamera: () => Promise<boolean>;
  switchMicrophone: (deviceId: string) => Promise<boolean>;
  setCameraQualityProfile: (profile: CameraQualityProfile) => void;
  toggleScreenShare: () => Promise<void>;
  setParticipantVolume: (userId: string, volume: number) => void;
  setAudioOutputRoute: (route: AudioOutputRoute) => Promise<boolean>;
  clearError: () => void;
  
  // Infrastructure integration injection methods
  setSFUAdapter: (adapter: SFUProviderAdapter | null) => void;
  setSFUConfig: (config: SFUServerConfig) => void;
}

type MediaSessionContextType = Omit<
  MediaContextType,
  'participants' | 'activeCallDuration' | 'formattedDuration' | 'cameraTelemetry'
>;

interface MediaDurationContextType {
  activeCallDuration: number;
  formattedDuration: string;
}

// Keep high-frequency media state out of the session context. Duration and
// telemetry update once per second, while speaking/track events can update the
// participant list even faster. Consumers such as App and ChatPanel should not
// re-render for those changes when they only need session state or actions.
const MediaSessionContext = createContext<MediaSessionContextType | null>(null);
const MediaParticipantsContext = createContext<MediaParticipant[] | null>(null);
const MediaDurationContext = createContext<MediaDurationContextType | null>(null);
const MediaTelemetryContext = createContext<CameraTelemetryData | null | undefined>(undefined);

const createVoiceSessionId = () => `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

async function prepareRoomJoin(config: RoomConfig): Promise<RoomConfig> {
  const joinStartedAtMs = config.joinStartedAtMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const preparedConfig = {
    ...config,
    sessionId: config.sessionId || createVoiceSessionId(),
    joinStartedAtMs,
  };
  const microphoneTask = acquireMicrophoneForJoin().then((result) => {
    console.info('[VOICE_JOIN_TIMING]', {
      phase: result.granted ? 'microphone_ready' : 'microphone_failed',
      durationMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - joinStartedAtMs),
    });
    return result;
  });
  const preflightTask = realtimeMediaProvider.preflightRoom(preparedConfig).then(() => {
    console.info('[VOICE_JOIN_TIMING]', {
      phase: 'code_and_token_ready',
      durationMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - joinStartedAtMs),
    });
  });
  const [microphoneResult, preflightResult] = await Promise.allSettled([
    microphoneTask,
    preflightTask,
  ]);

  const microphone = microphoneResult.status === 'fulfilled' ? microphoneResult.value : null;
  if (preflightResult.status === 'rejected') {
    microphone?.track?.stop();
    throw preflightResult.reason;
  }
  if (!microphone || !microphone.granted || !microphone.track) {
    const error = new Error(
      microphone?.error ||
        (microphoneResult.status === 'rejected'
          ? String(microphoneResult.reason)
          : 'Microphone permission was not granted.')
    );
    (error as any).code = 'PERMISSION_DENIED';
    throw error;
  }

  return { ...preparedConfig, initialMicrophoneTrack: microphone.track };
}

export const MediaProvider: React.FC<{
  children: React.ReactNode;
  currentUser?: User | null;
}> = ({ children, currentUser: propCurrentUser }) => {
  const [internalUser, setInternalUser] = useState<User | null>(() => propCurrentUser || pbService.getCurrentUser());
  const currentUser = propCurrentUser || internalUser || pbService.getCurrentUser();
  const currentUserRef = useRef<User | null>(currentUser);
  currentUserRef.current = currentUser;

  const [activeRoom, setActiveRoom] = useState<RoomConfig | null>(null);
  const [participants, setParticipants] = useState<MediaParticipant[]>([]);
  const [connectionState, setConnectionState] = useState<MediaConnectionState>('idle');
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [isCameraEnabled, setIsCameraEnabled] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [incomingCall, setIncomingCall] = useState<IncomingCallEvent | null>(null);
  const [outgoingCall, setOutgoingCall] = useState<IncomingCallEvent | null>(null);
  const [isRingMuted, setIsRingMuted] = useState(false);
  const [activeCallDuration, setActiveCallDuration] = useState(0);
  const [error, setError] = useState<MediaError | null>(null);
  const [cameraQualityProfile, setCameraQualityProfileState] = useState<CameraQualityProfile>(() => {
    return realtimeMediaProvider.getCameraQualityProfile();
  });
  const [cameraTelemetry, setCameraTelemetry] = useState<CameraTelemetryData | null>(null);
  const [audioOutputRoute, setAudioOutputRouteState] = useState<AudioOutputRoute>(() => realtimeMediaProvider.getAudioOutputRoute());

  const toggleMuteRing = useCallback((override?: boolean) => {
    setIsRingMuted((prev) => {
      const next = typeof override === 'boolean' ? override : !prev;
      setRingtoneMuted(next);
      return next;
    });
  }, []);

  // Listen to PocketBase auth updates and update currentUser state
  useEffect(() => {
    if (propCurrentUser) {
      setInternalUser(propCurrentUser);
      callSignalingService.setCurrentUser(propCurrentUser);
    } else {
      const current = pbService.getCurrentUser();
      if (current) {
        setInternalUser(current);
        callSignalingService.setCurrentUser(current);
      }
    }

    try {
      const unsub = pbService.getPbInstance().authStore.onChange((token, model) => {
        const user = model ? (model as unknown as User) : pbService.getCurrentUser();
        queueMicrotask(() => {
          setInternalUser(user);
          callSignalingService.setCurrentUser(user);
        });
      });
      return () => {
        if (typeof unsub === 'function') {
          unsub();
        }
      };
    } catch (e) {
      // Fallback
    }
  }, [propCurrentUser]);

  useEffect(() => {
    // Camera telemetry is useful while a media session is active, but polling
    // it while the app is idle forces an otherwise unnecessary provider update
    // every second on every platform.
    if (!activeRoom?.roomId && !isCameraEnabled) {
      return;
    }

    const refreshTelemetry = () => {
      const next = realtimeMediaProvider.getActiveCameraTelemetry();
      setCameraTelemetry((previous) => (previous === next ? previous : next));
    };

    refreshTelemetry();
    const timer = setInterval(refreshTelemetry, 1000);
    return () => clearInterval(timer);
  }, [activeRoom?.roomId, isCameraEnabled]);

  const setCameraQualityProfile = useCallback((profile: CameraQualityProfile) => {
    realtimeMediaProvider.setCameraQualityProfile(profile);
    setCameraQualityProfileState(profile);
    setCameraTelemetry(realtimeMediaProvider.getActiveCameraTelemetry());
  }, []);

  const setAudioOutputRoute = useCallback(async (route: AudioOutputRoute) => {
    const applied = await realtimeMediaProvider.setAudioOutputRoute(route);
    setAudioOutputRouteState(realtimeMediaProvider.getAudioOutputRoute());
    return applied;
  }, []);

  const durationTimerRef = useRef<any>(null);
  const activeCallDurationRef = useRef<number>(0);
  const activeCallTargetRef = useRef<{
    callerId: string;
    callerName: string;
    targetUserId: string;
    conversationId: string;
    callType: 'voice' | 'video';
  } | null>(null);
  const joiningRoomIdRef = useRef<string | null>(null);
  const voiceRecoveryAttemptedRef = useRef<string | null>(null);
  // A call-accept can arrive through the local BroadcastChannel and the
  // server WebSocket. Only the first event may start the media join.
  const acceptedCallIdsRef = useRef<Set<string>>(new Set());
  // Ignore late accepts that were already cancelled/ended. WebSocket and
  // BroadcastChannel delivery can be reordered during a reconnect.
  const settledCallIdsRef = useRef<Set<string>>(new Set());
  const outgoingCallRef = useRef<IncomingCallEvent | null>(outgoingCall);
  outgoingCallRef.current = outgoingCall;
  const incomingCallRef = useRef<IncomingCallEvent | null>(incomingCall);
  incomingCallRef.current = incomingCall;
  const activeRoomRef = useRef<RoomConfig | null>(activeRoom);
  activeRoomRef.current = activeRoom;

  // Sync current user with call signaling & self participant state
  useEffect(() => {
    callSignalingService.setCurrentUser(currentUser);
    if (currentUser && activeRoom) {
      const member = activeRoom.serverId ? pbService.getCachedServerMember(activeRoom.serverId, currentUser.id) : null;
      const avatarUrl =
        getServerMemberAvatarUrl(member, currentUser, activeRoom.serverId) ||
        (currentUser.avatar
          ? currentUser.avatar.startsWith('http') || currentUser.avatar.startsWith('blob:') || currentUser.avatar.startsWith('data:')
            ? currentUser.avatar
            : `${pbService.getServerUrl()}/api/files/users/${currentUser.id}/${currentUser.avatar}`
          : '');
      const displayName =
        getServerMemberDisplayName(member, currentUser, activeRoom.serverId) ||
        currentUser.display_name ||
        currentUser.username;

      realtimeMediaProvider.updateSelfParticipant({
        userRef: currentUser,
        avatar: avatarUrl,
        displayName: displayName,
      });
    }
  }, [currentUser, activeRoom]);

  // Subscribe to Media Provider events
  useEffect(() => {
    const unsub = realtimeMediaProvider.subscribe((evt) => {
      queueMicrotask(() => {
        if (evt.type === 'participants_changed' && evt.participants) {
          setParticipants([...evt.participants]);
        } else if (evt.type === 'connection_changed' && evt.connectionState) {
          setConnectionState(evt.connectionState);
        } else if (evt.type === 'error' && evt.error) {
          setError(evt.error);

          // A terminal SFU failure must clear the optimistic call state.  If
          // the LiveKit room was evicted (for example by a duplicate identity
          // from an older client), leaving this state mounted lets the
          // recovery effect immediately start another connect attempt and the
          // UI gets stuck cycling between connecting and disconnected.
          const details = evt.error.details as any;
          const terminalSfuFailure =
            (evt.error.code === 'SFU_UNAVAILABLE' && realtimeMediaProvider.getConnectionState() === 'failed') ||
            details?.reason === 'DUPLICATE_IDENTITY' ||
            /already connected to the call on another device/i.test(evt.error.message || '');
          if (terminalSfuFailure) {
            voiceSessionRecovery.clearSession();
            setActiveRoom(null);
            setParticipants([]);
            setConnectionState('failed');
            setOutgoingCall(null);
            setIncomingCall(null);
            stopDurationTimer();
            realtimeMediaProvider.leaveRoom().catch(() => {});
          }
        } else if (evt.type === 'room_left') {
          setActiveRoom(null);
          setParticipants([]);
          setConnectionState('idle');
          setIsCameraEnabled(false);
          setIsScreenSharing(false);
          setOutgoingCall(null);
          stopDurationTimer();
        }
      });
    });

    return () => unsub();
  }, []);

  // Cleanup media session on page unload
  useEffect(() => {
    const handleUnload = () => {
      stopAllRingtones();
      realtimeMediaProvider.disconnect().catch(() => {});
    };
    window.addEventListener('beforeunload', handleUnload);
    window.addEventListener('pagehide', handleUnload);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      window.removeEventListener('pagehide', handleUnload);
    };
  }, []);

  // Subscribe to Call Signaling events
  useEffect(() => {
    const unsubSignal = callSignalingService.subscribe(async (event) => {
      queueMicrotask(async () => {
        const activeUser = currentUserRef.current || pbService.getCurrentUser();
        const activeUserId = activeUser?.id;
        const myId = String(activeUserId || '').trim();
        const callerId = String(event.callerId || event.callerUser?.id || '').trim();
        const targetUserId = String(event.targetUserId || event.targetUser?.id || '').trim();

        if (event.state === 'ringing') {
          // If current user is the caller, set outgoingCall
          if (myId && callerId === myId) {
            setOutgoingCall(event);
            setIncomingCall(null);
          } else if (myId && targetUserId === myId && callerId !== myId) {
            setIncomingCall(event);
            setOutgoingCall(null);
          }
        } else if (['declined', 'cancelled', 'ended', 'missed', 'busy', 'timeout'].includes(event.state)) {
          acceptedCallIdsRef.current.delete(event.callId);
          if (event.roomType !== 'voice_room') {
            settledCallIdsRef.current.add(event.callId);
            setTimeout(() => settledCallIdsRef.current.delete(event.callId), 60_000);
          }
          // Log call to chat if not already logged
          const callTarget = activeCallTargetRef.current;
          const dur = activeCallDurationRef.current;
          if (callTarget && (myId === callTarget.callerId || myId === callTarget.targetUserId)) {
            const logStatus =
              event.state === 'declined'
                ? 'declined'
                : event.state === 'cancelled'
                ? 'cancelled'
                : event.state === 'timeout' || event.state === 'missed'
                ? 'missed'
                : dur > 0
                ? 'ended'
                : 'cancelled';

            recordCallLog({
              callId: event.callId,
              conversationId: callTarget.conversationId,
              targetUserId: callTarget.targetUserId,
              callerId: callTarget.callerId,
              callerName: callTarget.callerName,
              callType: callTarget.callType,
              status: logStatus,
              duration: dur,
            }).catch(() => {});
          }

          setIncomingCall((curr) => (curr?.callId === event.callId ? null : curr));
          setOutgoingCall((curr) => {
            if (curr && curr.callId === event.callId) {
              return { ...curr, state: event.state };
            }
            return curr;
          });

          setTimeout(() => {
            setOutgoingCall((curr) => (curr?.callId === event.callId ? null : curr));
          }, 1200);

          const currentRoom = activeRoomRef.current;
          if (currentRoom && (currentRoom.callId === event.callId || currentRoom.roomType === 'dm_call') && ['ended', 'cancelled', 'declined', 'busy'].includes(event.state)) {
            realtimeMediaProvider.leaveRoom().catch(() => {});
            setActiveRoom(null);
            setParticipants([]);
            stopDurationTimer();
          }
        } else if (event.state === 'accepted') {
          // A voice-room accept only acknowledges an already-connected room.
          // A DM accept may start media only when this tab still owns the
          // matching outgoing invite. This prevents delayed/stale accepts
          // from starting a call after a reload or navigation.
          const activeOutgoing = outgoingCallRef.current;
          const existingRoom = activeRoomRef.current;
          const isVoiceRoomAcknowledgement =
            event.roomType === 'voice_room' &&
            existingRoom?.roomType === 'voice_room' &&
            existingRoom.roomId === event.conversationId;

          if (isVoiceRoomAcknowledgement) {
            if (!acceptedCallIdsRef.current.has(event.callId)) {
              acceptedCallIdsRef.current.add(event.callId);
              setParticipants(realtimeMediaProvider.getParticipants());
            }
            return;
          }

          const isCaller = Boolean(
            activeOutgoing &&
            activeOutgoing.callId === event.callId &&
            activeOutgoing.callerId === myId
          );

          if (isCaller && activeUser) {
            if (settledCallIdsRef.current.has(event.callId)) return;
            if (acceptedCallIdsRef.current.has(event.callId)) {
              return;
            }
            acceptedCallIdsRef.current.add(event.callId);
            setOutgoingCall(null);

            const targetUser = activeOutgoing?.targetUser || event.targetUser;
            const config: RoomConfig = {
              roomId: event.conversationId,
              roomName: event.roomName || (targetUser ? (targetUser.display_name || targetUser.username) : (event.callerName ? `@${event.callerName}` : 'Voice Call')),
              roomType: event.roomType || 'dm_call',
              maxParticipants: event.maxParticipants || (event.roomType === 'voice_room' ? 8 : 2),
              user: activeUser,
              initialMode: event.callType === 'video' ? 'video' : 'voice',
              callId: event.roomType === 'voice_room' ? undefined : event.callId,
              channelId: event.channelId || event.conversationId,
              serverId: event.serverId,
              sessionId: activeOutgoing?.sessionId || createVoiceSessionId(),
            };

            let preparedConfig: RoomConfig | null = null;
            let mediaConnected = false;
            try {
              preparedConfig = await prepareRoomJoin(config);
              setActiveRoom(preparedConfig);
              await realtimeMediaProvider.joinRoom(preparedConfig);
              mediaConnected = true;
              if (targetUser) {
                const targetAvatarUrl =
                  getServerMemberAvatarUrl(null, targetUser, undefined) ||
                  (targetUser.avatar
                    ? targetUser.avatar.startsWith('http') || targetUser.avatar.startsWith('blob:') || targetUser.avatar.startsWith('data:')
                      ? targetUser.avatar
                      : `${pbService.getServerUrl()}/api/files/users/${targetUser.id}/${targetUser.avatar}`
                    : '');

                realtimeMediaProvider.addOrUpdateParticipant({
                  userId: targetUser.id,
                  username: targetUser.username,
                  displayName: targetUser.display_name || targetUser.username,
                  avatar: targetAvatarUrl,
                  isMuted: false,
                  isDeafened: false,
                  isSpeaking: false,
                  isCameraEnabled: false,
                  isScreenSharing: false,
                  connectionState: 'connected',
                  volume: 100,
                  roomId: event.conversationId,
                  callId: event.callId,
                  userRef: targetUser,
                  joinedAt: Date.now(),
                });
                setParticipants(realtimeMediaProvider.getParticipants());
              }
              playJoinSound();
              startDurationTimer();
            } catch (joinErr) {
              if (!mediaConnected) preparedConfig?.initialMicrophoneTrack?.stop();
              console.warn('[MediaContext] Join room error upon call accept:', joinErr);
              // The callee must not remain in an accepted state when the
              // caller cannot establish media. Tear down the local session
              // and send one terminal signal so both clients leave cleanly.
              await realtimeMediaProvider.leaveRoom().catch(() => {});
              setActiveRoom(null);
              setParticipants([]);
              stopDurationTimer();
              setError({
                code: 'SFU_UNAVAILABLE',
                message: joinErr instanceof Error ? joinErr.message : 'Failed to connect to the LiveKit media server',
              });
              callSignalingService.cancelCall(event.callId, 'cancelled', event);
            }
          }

          if (incomingCallRef.current && incomingCallRef.current.callId === event.callId) {
            setIncomingCall(null);
          }
        }
      });
    });

    return () => unsubSignal();
  }, []);

  // Call duration counter
  const startDurationTimer = () => {
    stopDurationTimer();
    activeCallDurationRef.current = 0;
    setActiveCallDuration(0);
    durationTimerRef.current = setInterval(() => {
      setActiveCallDuration((prev) => {
        const next = prev + 1;
        activeCallDurationRef.current = next;
        return next;
      });
    }, 1000);
  };

  const stopDurationTimer = () => {
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
    setActiveCallDuration(0);
  };

  const formatDuration = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    if (hrs > 0) {
      return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
    }
    return `${pad(mins)}:${pad(secs)}`;
  };

  // Join Voice Room (max 8 participants)
  const joinVoiceRoom = useCallback(
    async (channel: Channel, user: User, mode: 'voice' | 'video' | 'screen' = 'voice') => {
      const roomIsSettled = activeRoom && activeRoom.roomId === channel.id &&
        ['joining', 'connecting', 'connected', 'reconnecting'].includes(connectionState);
      if (joiningRoomIdRef.current === channel.id || roomIsSettled) {
        return;
      }
      joiningRoomIdRef.current = channel.id;
      setConnectionState('connecting');
      let preparedConfig: RoomConfig | null = null;
      let mediaConnected = false;
      try {
        setError(null);

        // Check channel max user limit
        const opts = parseChannelOptions(channel);
        const userLimit = opts.user_limit || channel.user_limit || 8;
        // Participants from a different active room must not make the next
        // channel appear full while the previous room is being torn down.
        const currentCount = activeRoom?.roomId === channel.id ? realtimeMediaProvider.getParticipants().length : 0;
        if (currentCount >= userLimit && activeRoom?.roomId !== channel.id) {
          setError({
            code: 'ROOM_FULL',
            message: `Channel is full (Max limit is ${userLimit} users)`,
          });
          setConnectionState('disconnected');
          voiceSessionRecovery.clearSession();
          voiceRecoveryAttemptedRef.current = channel.id;
          joiningRoomIdRef.current = null;
          return;
        }

        if (activeRoom && activeRoom.roomId !== channel.id) {
          if (activeRoom.callId) {
            callSignalingService.endCall(activeRoom.callId);
          }
          await realtimeMediaProvider.leaveRoom();
        }

        const config: RoomConfig = {
          roomId: channel.id,
          roomName: channel.name,
          roomType: 'voice_room',
          maxParticipants: userLimit,
          user,
          initialMode: mode,
          channelId: channel.id,
          serverId: channel.server,
          sessionId: createVoiceSessionId(),
        };

        // Microphone acquisition, lazy LiveKit loading and token acquisition
        // begin together after the explicit Join click.
        preparedConfig = await prepareRoomJoin(config);
        setActiveRoom(preparedConfig);
        const parts = await realtimeMediaProvider.joinRoom(preparedConfig);
        mediaConnected = true;
        setParticipants(parts);

        // Save session locally for 2-minute recovery window
        voiceSessionRecovery.saveSession({
          channelId: channel.id,
          serverId: channel.server,
          channelName: channel.name,
          userId: user.id,
          joinTimestamp: Date.now(),
          isMuted,
          isDeafened,
          isCameraEnabled,
          isScreenSharing,
          mode,
        });

        playJoinSound();
        startDurationTimer();
      } catch (err: any) {
        if (!mediaConnected) preparedConfig?.initialMicrophoneTrack?.stop();
        const isCancelled =
          err?.name === 'AbortError' ||
          err?.message?.includes('cancelled') ||
          err?.message?.includes('Aborted') ||
          err?.message?.includes('aborted');

        if (isCancelled) {
          console.log('[MediaContext] Join voice room cancelled by user');
          voiceSessionRecovery.clearSession();
          setActiveRoom(null);
          setParticipants([]);
          setConnectionState('disconnected');
          setError(null);
          return;
        }

        console.error('Failed to join voice room:', err);
        // Do not immediately retry a failed recovery session. Keeping the
        // two-minute marker here caused an effect-driven connect/disconnect
        // loop whenever the VPS or token endpoint was unavailable.
        voiceSessionRecovery.clearSession();
        voiceRecoveryAttemptedRef.current = channel.id;
        setActiveRoom(null);
        setParticipants([]);
        setConnectionState('disconnected');
        setError({
          code: err?.code === 'PERMISSION_DENIED' ? 'PERMISSION_DENIED' : 'SFU_UNAVAILABLE',
          message: err?.message || 'Failed to connect to voice server',
        });
      } finally {
        joiningRoomIdRef.current = null;
      }
    },
    [activeRoom, connectionState, isMuted, isDeafened, isCameraEnabled, isScreenSharing]
  );

  // Do not automatically rejoin a voice room from local storage.  A stale
  // recovery marker could start the microphone and LiveKit as soon as the app
  // opened, even though the user had not chosen to call.  LiveKit itself
  // handles transient reconnects while the app is open; a new app session
  // must always require an explicit join/call action.
  useEffect(() => {
    if (!currentUser) return;
    voiceSessionRecovery.clearSession();
    voiceRecoveryAttemptedRef.current = null;
  }, [currentUser]);

  // Start DM Call (1-to-1)
  const startDmCall = useCallback(
    async (
      targetUser: User,
      currentUserObj: User,
      dmChannel: Channel,
      mode: 'voice' | 'video' | 'screen' = 'voice'
    ) => {
      const roomIsSettled = activeRoom && activeRoom.roomId === dmChannel.id &&
        ['joining', 'connecting', 'connected', 'reconnecting'].includes(connectionState);
      if (joiningRoomIdRef.current === dmChannel.id || roomIsSettled) {
        return;
      }
      joiningRoomIdRef.current = dmChannel.id;
      try {
        setError(null);

        const callId = `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const sessionId = createVoiceSessionId();
        const callType = mode === 'video' ? 'video' : 'voice';
        const roomName = targetUser.display_name || targetUser.username || 'Voice Call';

        // Acquire the token before notifying the other user. A dead VPS or
        // SFU should fail locally and immediately, rather than leaving a
        // ringing notification and a queued call record behind.
        await realtimeMediaProvider.preflightRoom({
          roomId: dmChannel.id,
          roomName,
          roomType: 'dm_call',
          maxParticipants: 2,
          user: currentUserObj,
          initialMode: mode,
          callId,
          channelId: dmChannel.id,
          sessionId,
        });

        if (activeRoom && activeRoom.roomId !== dmChannel.id) {
          if (activeRoom.callId) {
            callSignalingService.endCall(activeRoom.callId);
          }
          await realtimeMediaProvider.leaveRoom().catch(() => {});
        }

        activeCallDurationRef.current = 0;
        activeCallTargetRef.current = {
          callerId: currentUserObj.id,
          callerName: currentUserObj.display_name || currentUserObj.username,
          targetUserId: targetUser.id,
          conversationId: dmChannel.id,
          callType: mode === 'video' ? 'video' : 'voice',
        };

        const callerAvatarUrl =
          getServerMemberAvatarUrl(null, currentUserObj, undefined) ||
          (currentUserObj.avatar
            ? currentUserObj.avatar.startsWith('http') || currentUserObj.avatar.startsWith('blob:') || currentUserObj.avatar.startsWith('data:')
              ? currentUserObj.avatar
              : `${pbService.getServerUrl()}/api/files/users/${currentUserObj.id}/${currentUserObj.avatar}`
            : '');

        const signalEvent: IncomingCallEvent = {
          callId,
          callerId: currentUserObj.id,
          callerName: currentUserObj.display_name || currentUserObj.username,
          callerAvatar: callerAvatarUrl,
          callerUser: currentUserObj,
          targetUser,
          targetUserId: targetUser.id,
          callType,
          conversationId: dmChannel.id,
          roomType: 'dm_call',
          roomName,
          maxParticipants: 2,
          channelId: dmChannel.id,
          sessionId,
          state: 'ringing',
          timestamp: Date.now(),
        };

        // 1. Set outgoingCall synchronously in React state (Screen appears instantly FIRST at 0ms)
        setOutgoingCall(signalEvent);

        // 2. Dispatch signaling & start outgoing ringback chime
        await callSignalingService.sendCallInvite({
          caller: currentUserObj,
          targetUser,
          conversationId: dmChannel.id,
          callType,
          existingEvent: signalEvent,
        });
      } catch (err: any) {
        const isCancelled =
          err?.name === 'AbortError' ||
          err?.message?.includes('cancelled') ||
          err?.message?.includes('Aborted') ||
          err?.message?.includes('aborted');

        if (isCancelled) {
          console.log('[MediaContext] DM call cancelled by user');
          activeCallTargetRef.current = null;
          setOutgoingCall(null);
          setError(null);
          return;
        }

        console.error('Failed to start DM call:', err);
        activeCallTargetRef.current = null;
        setOutgoingCall(null);
        setError({
          code: err?.code === 'TOKEN_ERROR' ? 'TOKEN_ERROR' : 'SFU_UNAVAILABLE',
          message: err?.message || 'Failed to start DM call',
        });
      } finally {
        joiningRoomIdRef.current = null;
      }
    },
    [activeRoom, connectionState]
  );

  // Invite additional users to an already-connected server voice room. The
  // room remains shared and no extra caller overlay is created locally.
  const inviteUsersToCall = useCallback(async (targets: User[]): Promise<number> => {
    const room = activeRoomRef.current || activeRoom;
    const caller = currentUserRef.current || currentUser || pbService.getCurrentUser();
    if (!room || room.roomType !== 'voice_room' || !caller || !Array.isArray(targets)) return 0;

    const occupied = new Set(realtimeMediaProvider.getParticipants().map((participant) => participant.userId));
    const limit = room.maxParticipants || 8;
    let sent = 0;
    for (const target of targets) {
      if (!target?.id || target.id === caller.id || occupied.has(target.id)) continue;
      if (occupied.size >= limit) break;
      try {
        await callSignalingService.inviteToActiveRoom({ caller, targetUser: target, room });
        occupied.add(target.id);
        sent += 1;
      } catch (err) {
        console.warn('[MediaContext] Could not invite user to voice room:', err);
      }
    }
    return sent;
  }, [activeRoom, currentUser]);

  // Accept incoming call
  const acceptCall = useCallback(async () => {
    unlockAudioContext();
    const activeUser = currentUserRef.current || currentUser || pbService.getCurrentUser();
    const event = incomingCallRef.current || incomingCall;
    if (!event || !activeUser) return;
    let preparedConfig: RoomConfig | null = null;
    let mediaConnected = false;

    try {
      setError(null);
      activeCallDurationRef.current = 0;
      activeCallTargetRef.current = {
        callerId: event.callerId,
        callerName: event.callerName,
        targetUserId: activeUser.id,
        conversationId: event.conversationId,
        callType: event.callType || 'voice',
      };

      const config: RoomConfig = {
        roomId: event.conversationId,
        roomName: event.roomName || event.callerName,
        roomType: event.roomType || 'dm_call',
        maxParticipants: event.maxParticipants || (event.roomType === 'voice_room' ? 8 : 2),
        user: activeUser,
        initialMode: event.callType === 'video' ? 'video' : 'voice',
        callId: event.roomType === 'voice_room' ? undefined : event.callId,
        channelId: event.channelId || event.conversationId,
        serverId: event.serverId,
        sessionId: createVoiceSessionId(),
      };

      preparedConfig = await prepareRoomJoin(config);
      callSignalingService.acceptCall(event.callId, event);
      setIncomingCall(null);
      setActiveRoom(preparedConfig);
      await realtimeMediaProvider.joinRoom(preparedConfig);
      mediaConnected = true;

      if (event.callerUser) {
        const callerAvatarUrl =
          getServerMemberAvatarUrl(null, event.callerUser, undefined) ||
          (event.callerUser.avatar
            ? event.callerUser.avatar.startsWith('http') || event.callerUser.avatar.startsWith('blob:') || event.callerUser.avatar.startsWith('data:')
              ? event.callerUser.avatar
              : `${pbService.getServerUrl()}/api/files/users/${event.callerUser.id}/${event.callerUser.avatar}`
            : '');

        realtimeMediaProvider.addOrUpdateParticipant({
          userId: event.callerUser.id,
          username: event.callerUser.username,
          displayName: event.callerName || event.callerUser.username,
          avatar: callerAvatarUrl,
          isMuted: false,
          isDeafened: false,
          isSpeaking: false,
          isCameraEnabled: false,
          isScreenSharing: false,
          connectionState: 'connected',
          volume: 100,
          roomId: event.conversationId,
          callId: event.callId,
          userRef: event.callerUser,
          joinedAt: Date.now(),
        });
      }

      setParticipants(realtimeMediaProvider.getParticipants());
      playJoinSound();
      startDurationTimer();
    } catch (err: any) {
      if (!mediaConnected) preparedConfig?.initialMicrophoneTrack?.stop();
      const isCancelled =
        err?.name === 'AbortError' ||
        err?.message?.includes('cancelled') ||
        err?.message?.includes('Aborted') ||
        err?.message?.includes('aborted');

      if (isCancelled) {
        console.log('[MediaContext] Accept call cancelled by user');
        setActiveRoom(null);
        setParticipants([]);
        setConnectionState('disconnected');
        setError(null);
        return;
      }

      console.error('Error accepting call:', err);
      setActiveRoom(null);
      setParticipants([]);
      setConnectionState('disconnected');
      setError({
        code: err?.code === 'PERMISSION_DENIED' ? 'PERMISSION_DENIED' : 'SFU_UNAVAILABLE',
        message: err?.message || 'Failed to connect to the LiveKit media server',
      });
      callSignalingService.endCall(event.callId);
    }
  }, [incomingCall, currentUser]);

  // Decline incoming call
  const declineCall = useCallback(() => {
    const callToDecline = incomingCallRef.current || incomingCall;
    if (!callToDecline) return;
    stopAllRingtones();
    recordCallLog({
      callId: callToDecline.callId,
      conversationId: callToDecline.conversationId,
      targetUserId: callToDecline.targetUserId,
      callerId: callToDecline.callerId,
      callerName: callToDecline.callerName,
      callType: callToDecline.callType,
      status: 'declined',
      duration: 0,
    }).catch(() => {});

    callSignalingService.declineCall(callToDecline.callId, 'declined', callToDecline);
    setIncomingCall(null);
  }, [incomingCall]);

  // Cancel outgoing ringing call (Instant 0ms cancellation)
  const cancelOutgoingCall = useCallback(async () => {
    stopAllRingtones();
    const callToCancel = outgoingCallRef.current || outgoingCall;
    if (callToCancel) {
      recordCallLog({
        callId: callToCancel.callId,
        conversationId: callToCancel.conversationId,
        targetUserId: callToCancel.targetUserId,
        callerId: callToCancel.callerId,
        callerName: callToCancel.callerName,
        callType: callToCancel.callType,
        status: 'cancelled',
        duration: 0,
      }).catch(() => {});

      callSignalingService.cancelCall(callToCancel.callId, 'cancelled', callToCancel);
      setOutgoingCall(null);
    }
    const currentRoom = activeRoomRef.current || activeRoom;
    if (currentRoom && currentRoom.roomType === 'dm_call') {
      await realtimeMediaProvider.leaveRoom().catch(() => {});
      setActiveRoom(null);
    }
  }, [outgoingCall, activeRoom]);

  // Leave active call or room
  const leaveRoomOrCall = useCallback(async () => {
    stopAllRingtones();
    const currentDur = activeCallDurationRef.current;
    const callTarget = activeCallTargetRef.current;
    const currentRoom = activeRoomRef.current || activeRoom;
    if (currentRoom?.callId && callTarget) {
      recordCallLog({
        callId: currentRoom.callId,
        conversationId: callTarget.conversationId,
        targetUserId: callTarget.targetUserId,
        callerId: callTarget.callerId,
        callerName: callTarget.callerName,
        callType: callTarget.callType,
        status: 'ended',
        duration: currentDur,
      }).catch(() => {});
    }

    setOutgoingCall(null);
    voiceSessionRecovery.clearSession();
    joiningRoomIdRef.current = null;
    if (currentRoom?.callId) {
      const activeCall = callSignalingService.getActiveCall();
      if (activeCall && activeCall.callId === currentRoom.callId && activeCall.state === 'ringing') {
        callSignalingService.cancelCall(currentRoom.callId);
      } else {
        callSignalingService.endCall(currentRoom.callId);
      }
    }
    await realtimeMediaProvider.leaveRoom();
    playLeaveSound();
  }, [activeRoom]);

  // Audio & Video controls
  const toggleMute = useCallback(() => {
    if (isMuted) {
      realtimeMediaProvider.enableMicrophone().then(() => {
        setIsMuted(false);
        voiceSessionRecovery.updateState({ isMuted: false });
      });
    } else {
      realtimeMediaProvider.disableMicrophone();
      setIsMuted(true);
      voiceSessionRecovery.updateState({ isMuted: true });
    }
  }, [isMuted]);

  const toggleDeafen = useCallback(() => {
    const nextState = !isDeafened;
    setIsDeafened(nextState);
    realtimeMediaProvider.setDeafened(nextState);
    voiceSessionRecovery.updateState({ isDeafened: nextState });
  }, [isDeafened]);

  const toggleCamera = useCallback(async () => {
    if (isCameraEnabled) {
      realtimeMediaProvider.disableCamera();
      setIsCameraEnabled(false);
      voiceSessionRecovery.updateState({ isCameraEnabled: false });
    } else {
      const perm = await checkAndRequestCameraPermission();
      if (!perm.granted) {
        setError({
          code: 'PERMISSION_DENIED',
          message: perm.error || 'Camera permission was not granted.',
        });
        return;
      }
      const track = await realtimeMediaProvider.enableCamera();
      if (track) {
        setIsCameraEnabled(true);
        voiceSessionRecovery.updateState({ isCameraEnabled: true });
      }
    }
  }, [isCameraEnabled]);

  const switchCamera = useCallback(async () => {
    return await realtimeMediaProvider.switchCamera();
  }, []);

  const switchMicrophone = useCallback(async (deviceId: string) => {
    return await realtimeMediaProvider.switchMicrophone(deviceId);
  }, []);

  const toggleScreenShare = useCallback(async () => {
    if (isScreenSharing) {
      realtimeMediaProvider.stopScreenShare();
      setIsScreenSharing(false);
      voiceSessionRecovery.updateState({ isScreenSharing: false });
    } else {
      const perm = await checkAndRequestScreenSharePermission();
      if (!perm.granted) {
        setError({
          code: 'PERMISSION_DENIED',
          message: perm.error || 'Screen sharing is unavailable on this device.',
        });
        return;
      }
      const track = await realtimeMediaProvider.startScreenShare();
      if (track) {
        setIsScreenSharing(true);
        voiceSessionRecovery.updateState({ isScreenSharing: true });
      }
    }
  }, [isScreenSharing]);

  const setParticipantVolume = useCallback((userId: string, volume: number) => {
    realtimeMediaProvider.setParticipantVolume(userId, volume);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const setSFUAdapter = useCallback((adapter: SFUProviderAdapter | null) => {
    realtimeMediaProvider.setSFUAdapter(adapter);
  }, []);

  const setSFUConfig = useCallback((config: SFUServerConfig) => {
    realtimeMediaProvider.setSFUConfig(config);
  }, []);

  const formattedDuration = React.useMemo(() => formatDuration(activeCallDuration), [activeCallDuration]);

  const sessionValue = React.useMemo<MediaSessionContextType>(
    () => ({
      activeRoom,
      connectionState,
      isMuted,
      isDeafened,
      isCameraEnabled,
      isScreenSharing,
      incomingCall,
      outgoingCall,
      isRingMuted,
      error,
      cameraQualityProfile,
      audioOutputRoute,

      joinVoiceRoom,
      startDmCall,
      inviteUsersToCall,
      acceptCall,
      declineCall,
      cancelOutgoingCall,
      toggleMuteRing,
      leaveRoomOrCall,
      toggleMute,
      toggleDeafen,
      toggleCamera,
      switchCamera,
      switchMicrophone,
      setCameraQualityProfile,
      toggleScreenShare,
      setParticipantVolume,
      setAudioOutputRoute,
      clearError,
      setSFUAdapter,
      setSFUConfig,
    }),
    [
      activeRoom,
      connectionState,
      isMuted,
      isDeafened,
      isCameraEnabled,
      isScreenSharing,
      incomingCall,
      outgoingCall,
      isRingMuted,
      error,
      cameraQualityProfile,
      audioOutputRoute,
      joinVoiceRoom,
      startDmCall,
      inviteUsersToCall,
      acceptCall,
      declineCall,
      cancelOutgoingCall,
      toggleMuteRing,
      leaveRoomOrCall,
      toggleMute,
      toggleDeafen,
      toggleCamera,
      switchCamera,
      switchMicrophone,
      setCameraQualityProfile,
      toggleScreenShare,
      setParticipantVolume,
      setAudioOutputRoute,
      clearError,
      setSFUAdapter,
      setSFUConfig,
    ]
  );

  const durationValue = React.useMemo(
    () => ({ activeCallDuration, formattedDuration }),
    [activeCallDuration, formattedDuration]
  );

  return (
    <MediaSessionContext.Provider value={sessionValue}>
      <MediaParticipantsContext.Provider value={participants}>
        <MediaDurationContext.Provider value={durationValue}>
          <MediaTelemetryContext.Provider value={cameraTelemetry}>
            {children}
          </MediaTelemetryContext.Provider>
        </MediaDurationContext.Provider>
      </MediaParticipantsContext.Provider>
    </MediaSessionContext.Provider>
  );
};

export const useMediaSession = (): MediaSessionContextType => {
  const ctx = useContext(MediaSessionContext);
  if (!ctx) {
    throw new Error('useMediaSession must be used within a MediaProvider');
  }
  return ctx;
};

export const useMediaParticipants = (): MediaParticipant[] => {
  const ctx = useContext(MediaParticipantsContext);
  if (!ctx) {
    throw new Error('useMediaParticipants must be used within a MediaProvider');
  }
  return ctx;
};

export const useMediaDuration = (): MediaDurationContextType => {
  const ctx = useContext(MediaDurationContext);
  if (!ctx) {
    throw new Error('useMediaDuration must be used within a MediaProvider');
  }
  return ctx;
};

export const useMediaTelemetry = (): CameraTelemetryData | null => {
  const ctx = useContext(MediaTelemetryContext);
  if (ctx === undefined) {
    throw new Error('useMediaTelemetry must be used within a MediaProvider');
  }
  return ctx;
};

// Compatibility hook for external callers. In-app consumers use the focused
// hooks above so they subscribe only to the state they actually render.
export const useRealtimeMedia = (): MediaContextType => {
  const session = useMediaSession();
  const participants = useMediaParticipants();
  const duration = useMediaDuration();
  const cameraTelemetry = useMediaTelemetry();
  return { ...session, participants, ...duration, cameraTelemetry };
};

export default useRealtimeMedia;
