import React, { useEffect, useState } from 'react';
import { Activity, X, Cpu, Gauge, Zap, AlertTriangle } from 'lucide-react';
import { ParticipantDiagnosticsData } from '../types/media';

interface ParticipantDiagnosticsOverlayProps {
  userId: string;
  displayName: string;
  lang?: 'en' | 'ar';
  onClose: () => void;
}

export const ParticipantDiagnosticsOverlay: React.FC<ParticipantDiagnosticsOverlayProps> = ({
  userId,
  displayName,
  lang = 'en',
  onClose,
}) => {
  const isAr = lang === 'ar';
  const [diag, setDiag] = useState<ParticipantDiagnosticsData | null>(null);

  useEffect(() => {
    let isMounted = true;
    const pollDiagnostics = async () => {
      try {
        const { default: liveKitManager } = await import('../media/livekit/LiveKitManager');
        const data = await liveKitManager.getParticipantDiagnostics(userId);
        if (isMounted) setDiag(data);
      } catch {
        if (isMounted) setDiag(null);
      }
    };

    pollDiagnostics();
    const interval = setInterval(pollDiagnostics, 1000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [userId]);

  return (
    <div
      className="absolute inset-x-2 top-2 p-3 rounded-2xl bg-slate-950 border border-emerald-500/40 text-slate-100 shadow-2xl z-40 text-xs font-mono space-y-2.5 animate-in fade-in zoom-in-95 duration-200 select-text"
      dir={isAr ? 'rtl' : 'ltr'}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 pb-2">
        <div className="flex items-center gap-1.5 text-emerald-400 font-extrabold text-[11px]">
          <Activity className="w-4 h-4 animate-pulse shrink-0" />
          <span>{isAr ? 'تشخيصات البث والتليمتري' : 'Live Stream Telemetry'}</span>
          <span className="text-[10px] text-slate-400 font-normal">({displayName})</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors cursor-pointer"
          title={isAr ? 'إغلاق' : 'Close'}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {diag ? (
        <div className="grid grid-cols-2 gap-2 text-[10px] leading-tight">
          <div className="p-1.5 rounded-xl bg-white/5 border border-white/10">
            <span className="text-slate-400 block mb-0.5">{isAr ? 'دقة الالتقاط:' : 'Capture Res / FPS'}</span>
            <span className="font-bold text-white">{diag.captureResolution} @ {diag.captureFps} FPS</span>
          </div>

          <div className="p-1.5 rounded-xl bg-white/5 border border-white/10">
            <span className="text-slate-400 block mb-0.5">{isAr ? 'دقة التشفير:' : 'Encoded Res / FPS'}</span>
            <span className="font-bold text-sky-400">{diag.encodedResolution} @ {diag.encodedFps} FPS</span>
          </div>

          <div className="p-1.5 rounded-xl bg-white/5 border border-white/10">
            <span className="text-slate-400 block mb-0.5">{isAr ? 'الدقة المستلمة:' : 'Received Res / FPS'}</span>
            <span className="font-bold text-emerald-400">{diag.receivedResolution} @ {diag.receivedFps} FPS</span>
          </div>

          <div className="p-1.5 rounded-xl bg-white/5 border border-white/10">
            <span className="text-slate-400 block mb-0.5">{isAr ? 'معدل البث Bitrate:' : 'Bitrate'}</span>
            <span className="font-bold text-amber-400">{(diag.currentBitrateKbps / 1000).toFixed(2)} Mbps</span>
          </div>

          <div className="p-1.5 rounded-xl bg-white/5 border border-white/10">
            <span className="text-slate-400 block mb-0.5">{isAr ? 'فقدان الحزم / RTT:' : 'Packet Loss / RTT'}</span>
            <span className="font-bold text-purple-300">{diag.packetLossPercent}% loss | {diag.rttMs} ms</span>
          </div>

          <div className="p-1.5 rounded-xl bg-white/5 border border-white/10">
            <span className="text-slate-400 block mb-0.5">{isAr ? 'التذبذب Jitter:' : 'Jitter'}</span>
            <span className="font-bold text-cyan-300">{diag.jitterMs} ms</span>
          </div>

          <div className="p-1.5 rounded-xl bg-white/5 border border-white/10">
            <span className="text-slate-400 block mb-0.5">{isAr ? 'إطارات العرض Renderer:' : 'Decoder / Renderer'}</span>
            <span className="font-bold text-emerald-300">{diag.decoderFps} / {diag.rendererFps} FPS</span>
          </div>

          <div className="p-1.5 rounded-xl bg-white/5 border border-white/10">
            <span className="text-slate-400 block mb-0.5">{isAr ? 'حالة القناة والاشتراك:' : 'State / Sub'}</span>
            <span className="font-bold text-teal-300 uppercase">{diag.trackState} | {diag.subscriptionState}</span>
          </div>
        </div>
      ) : (
        <div className="p-3 text-center text-slate-400 text-[10px] animate-pulse">
          {isAr ? 'جاري قياس البيانات...' : 'Collecting RTC statistics...'}
        </div>
      )}
    </div>
  );
};

export default ParticipantDiagnosticsOverlay;
