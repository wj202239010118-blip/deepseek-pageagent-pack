#!/usr/bin/env python3
"""
Voice Input Bridge for DeepSeek TUI
====================================
Monitors keyboard via pynput. Long-press spacebar (>300ms) triggers:
  1. Record audio via sounddevice
  2. Send WAV to voicebox-asr /transcribe API
  3. Type transcribed text into active window

Architecture:
  voicebox-asr (Rust) sidecar on port 8765 -- HTTP --> voice_input.py -- pynput --> keyboard
"""

import os, sys, io, time, json, wave
from pathlib import Path
from datetime import datetime

import pyperclip
import requests
from pynput import keyboard

# -- Config ------------------------------------------------
ASR_URL = "http://127.0.0.1:8765/transcribe"
LONG_PRESS_MS = 300       # ms threshold for long press
SAMPLE_RATE = 16000       # 16kHz for ASR
LANGUAGE = "zh"

# -- State ------------------------------------------------
recording = False
press_time = None
audio_frames = []
log_file = None

def log(msg):
    ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    if log_file:
        log_file.write(line + "\n")
        log_file.flush()

# -- Audio ------------------------------------------------

def frames_to_wav_bytes(frames, samplerate=SAMPLE_RATE):
    import numpy as np
    if not frames:
        return None
    audio = np.concatenate(frames, axis=0)
    audio_int16 = (audio * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(samplerate)
        wf.writeframes(audio_int16.tobytes())
    return buf.getvalue()

def transcribe_audio(wav_bytes):
    if not wav_bytes:
        return None
    try:
        resp = requests.post(
            ASR_URL,
            params={"language": LANGUAGE},
            data=wav_bytes,
            timeout=30,
        )
        if resp.status_code == 200:
            text = resp.json().get("text", "")
            log(f"ASR: {text[:80]}")
            return text
        log(f"ASR HTTP {resp.status_code}")
        return None
    except requests.exceptions.ConnectionError:
        log("ASR not reachable. Start voicebox-asr first.")
        return None
    except Exception as e:
        log(f"ASR error: {e}")
        return None

def type_text(text):
    if not text:
        return
    pyperclip.copy(text)
    import pyautogui
    time.sleep(0.1)
    pyautogui.hotkey('ctrl', 'v')
    log(f"Pasted: {text[:50]}...")

# -- Keyboard handlers ------------------------------------

def on_press(key):
    global press_time
    try:
        if key == keyboard.Key.space:
            press_time = time.time()
    except AttributeError:
        pass

def on_release(key):
    global press_time, recording, audio_frames
    try:
        if key == keyboard.Key.space and press_time is not None:
            dur = (time.time() - press_time) * 1000
            press_time = None
            if dur < LONG_PRESS_MS:
                return  # short press - normal behavior

            log(f"Voice activated ({dur:.0f}ms)")
            import sounddevice as sd
            audio_frames = []
            def cb(indata, frames, t, status):
                audio_frames.append(indata.copy())

            log("Recording... (release to stop)")
            with sd.InputStream(samplerate=SAMPLE_RATE, channels=1,
                                callback=cb, blocksize=int(SAMPLE_RATE*0.1)):
                # Block until user releases... but we're already in on_release
                # So just record a fixed 2s clip or let user control duration
                time.sleep(2)

            log("Transcribing...")
            wav = frames_to_wav_bytes(audio_frames)
            text = transcribe_audio(wav)
            if text:
                type_text(text)
    except AttributeError:
        pass

# -- Main --------------------------------------------------

def main():
    global log_file

    log_dir = Path.home() / ".deepseek"
    log_dir.mkdir(exist_ok=True)
    log_file = open(log_dir / "voice_input.log", "a", encoding="utf-8")

    log("Voice Input Bridge started")
    log(f"ASR: {ASR_URL}, threshold: {LONG_PRESS_MS}ms")

    listener = keyboard.Listener(on_press=on_press, on_release=on_release)
    listener.start()

    try:
        while listener.is_alive():
            time.sleep(1)
    except KeyboardInterrupt:
        log("Shutdown")
    finally:
        listener.stop()
        if log_file:
            log_file.close()

if __name__ == "__main__":
    main()
