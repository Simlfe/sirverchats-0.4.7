package com.sirverdata.chat;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;

import java.util.List;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Selects the physical output used by an active voice session in the
 * Capacitor Android shell. The browser client still has a standards-based
 * fallback for platforms where this bridge is not available.
 */
@CapacitorPlugin(name = "AudioRoute")
public class AudioRoutePlugin extends Plugin {

    @PluginMethod
    public void setRoute(PluginCall call) {
        String route = call.getString("route", "default");
        if (!"default".equals(route) && !"speaker".equals(route) && !"earpiece".equals(route)) {
            call.reject("Unsupported audio route");
            return;
        }

        AudioManager audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (audioManager == null) {
            call.reject("Audio manager is unavailable");
            return;
        }

        try {
            boolean applied = applyRoute(audioManager, route);
            JSObject result = new JSObject();
            result.put("route", route);
            result.put("applied", applied);
            call.resolve(result);
        } catch (Exception ex) {
            call.reject("Unable to change audio output", "AUDIO_ROUTE_FAILED", ex);
        }
    }

    private boolean applyRoute(AudioManager audioManager, String route) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if ("default".equals(route)) {
                audioManager.clearCommunicationDevice();
                audioManager.setSpeakerphoneOn(false);
                audioManager.setMode(AudioManager.MODE_NORMAL);
                return true;
            }

            int requestedType = "speaker".equals(route)
                ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
            AudioDeviceInfo device = findCommunicationDevice(audioManager, requestedType);
            if (device != null && audioManager.setCommunicationDevice(device)) {
                return true;
            }
        }

        // Android versions before 12, and devices that do not expose a
        // communication device, use the legacy communication-mode switch.
        audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
        audioManager.setSpeakerphoneOn("speaker".equals(route));
        if ("default".equals(route)) {
            audioManager.setMode(AudioManager.MODE_NORMAL);
        }
        return true;
    }

    private AudioDeviceInfo findCommunicationDevice(AudioManager audioManager, int requestedType) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null;
        List<AudioDeviceInfo> devices = audioManager.getAvailableCommunicationDevices();
        for (AudioDeviceInfo device : devices) {
            if (device.getType() == requestedType) return device;
        }
        return null;
    }
}
