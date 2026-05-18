#!/usr/bin/env python3
"""
Interview Assistant — Audio Transcription Server
Captures mic (you) and system audio (interviewer) separately,
transcribes with Whisper, sends results to Electron via stdout JSON.

Usage:
  python3 transcribe.py --mic-device 0 --system-device 1
  python3 transcribe.py --list-devices
"""

import sys
import json
import time
import argparse
import threading

_list_only = '--list-devices' in sys.argv

try:
    import numpy as np
    import sounddevice as sd
    if not _list_only:
        import whisper
except ImportError as e:
    print(json.dumps({"type": "error", "message": f"Missing dependency: {e}. Run: pip3 install openai-whisper sounddevice numpy"}), flush=True)
    sys.exit(1)

# Shared lock — Whisper/PyTorch model is not thread-safe for concurrent inference
_transcribe_lock = threading.Lock()

# ─── Config ──────────────────────────────────────────────────────────────────
SAMPLE_RATE = 16000
CHUNK_SECONDS = 0.5          # How often we sample audio
SILENCE_THRESHOLD = 0.01     # RMS below this = silence
SILENCE_DURATION = 1.2       # Seconds of silence before we transcribe the chunk
MIN_SPEECH_DURATION = 0.6    # Ignore clips shorter than this (avoids noise pops)
MAX_BUFFER_SECONDS = 30      # Cap buffer to avoid memory issues

def send(obj):
    """Send a JSON message to Electron via stdout."""
    print(json.dumps(obj), flush=True)

def list_devices():
    """Print all audio devices and exit."""
    devices = sd.query_devices()
    hostapis = sd.query_hostapis()
    result = []
    for i, d in enumerate(devices):
        api_name = hostapis[d['hostapi']]['name'] if d['hostapi'] < len(hostapis) else ''
        result.append({
            "index": i,
            "name": d["name"],
            "inputs": d["max_input_channels"],
            "outputs": d["max_output_channels"],
            "default_sr": d["default_samplerate"],
            "hostapi": api_name
        })
    send({"type": "devices", "devices": result})
    sys.exit(0)

def rms(data):
    """Root mean square amplitude."""
    if len(data) == 0:
        return 0.0
    return float(np.sqrt(np.mean(data ** 2)))

class AudioStream:
    """
    Captures audio from a device, detects speech segments by silence gaps,
    and transcribes them with Whisper.
    """
    def __init__(self, device_index, role, model, samplerate=SAMPLE_RATE):
        self.device_index = device_index
        self.role = role          # 'interviewer' or 'you'
        self.model = model
        self.samplerate = samplerate
        self.buffer = []          # Accumulates audio while speech is happening
        self.silence_start = None
        self.is_speaking = False
        self.lock = threading.Lock()
        self.stream = None

    def start(self):
        chunk_size = int(self.samplerate * CHUNK_SECONDS)
        self.stream = sd.InputStream(
            device=self.device_index,
            channels=1,
            samplerate=self.samplerate,
            blocksize=chunk_size,
            dtype='float32',
            callback=self._callback
        )
        self.stream.start()
        send({"type": "stream_started", "role": self.role, "device": self.device_index})

    def stop(self):
        if self.stream:
            self.stream.stop()
            self.stream.close()

    def _callback(self, indata, frames, time_info, status):
        audio = indata[:, 0].copy()
        amplitude = rms(audio)

        with self.lock:
            if amplitude > SILENCE_THRESHOLD:
                self.is_speaking = True
                self.silence_start = None
                self.buffer.append(audio)

                max_samples = MAX_BUFFER_SECONDS * self.samplerate
                total = sum(len(c) for c in self.buffer)
                while total > max_samples and self.buffer:
                    removed = self.buffer.pop(0)
                    total -= len(removed)
            else:
                if self.is_speaking:
                    self.buffer.append(audio)
                    if self.silence_start is None:
                        self.silence_start = time.time()
                    elif time.time() - self.silence_start >= SILENCE_DURATION:
                        snapshot = list(self.buffer)
                        self.buffer = []
                        self.is_speaking = False
                        self.silence_start = None
                        threading.Thread(target=self._transcribe, args=(snapshot,), daemon=True).start()

    def _transcribe(self, buffer):
        if not buffer:
            return

        audio_data = np.concatenate(buffer)
        duration = len(audio_data) / self.samplerate

        if duration < MIN_SPEECH_DURATION:
            return

        send({"type": "transcribing", "role": self.role})

        # Ensure 1-D contiguous float32 array in [-1, 1] as Whisper expects
        audio_data = np.ascontiguousarray(audio_data.flatten(), dtype=np.float32)
        audio_data = np.clip(audio_data, -1.0, 1.0)

        try:
            with _transcribe_lock:
                result = self.model.transcribe(
                    audio_data,
                    language='en',
                    fp16=False,
                    condition_on_previous_text=False,
                    no_speech_threshold=0.6,
                    logprob_threshold=-1.0
                )
            text = result['text'].strip()
            if text and len(text) > 1:
                send({
                    "type": "transcript",
                    "role": self.role,
                    "text": text,
                    "duration": round(duration, 1)
                })
        except Exception as e:
            send({"type": "error", "message": f"Transcription error: {e}"})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--list-devices', action='store_true')
    parser.add_argument('--mic-device', type=int, default=None)
    parser.add_argument('--system-device', type=int, default=None)
    parser.add_argument('--model', type=str, default='base.en',
                        help='Whisper model: tiny.en, base.en, small.en (larger = more accurate but slower)')
    args = parser.parse_args()

    if args.list_devices:
        list_devices()
        return

    # Load Whisper model
    send({"type": "loading", "message": f"Loading Whisper model ({args.model})..."})
    try:
        model = whisper.load_model(args.model)
    except Exception as e:
        send({"type": "error", "message": f"Failed to load Whisper: {e}"})
        sys.exit(1)

    send({"type": "ready", "model": args.model})

    streams = []

    # Start system audio stream (interviewer)
    if args.system_device is not None:
        interviewer_stream = AudioStream(args.system_device, 'interviewer', model)
        interviewer_stream.start()
        streams.append(interviewer_stream)

    # Start mic stream (you)
    if args.mic_device is not None:
        you_stream = AudioStream(args.mic_device, 'you', model)
        you_stream.start()
        streams.append(you_stream)

    if not streams:
        send({"type": "error", "message": "No devices specified. Use --mic-device and/or --system-device."})
        sys.exit(1)

    # Keep alive — read commands from stdin
    try:
        while True:
            line = sys.stdin.readline()
            if line:
                if line.strip() == 'quit':
                    break
            else:
                # EOF on stdin (Windows pipe) — stay alive until killed
                time.sleep(0.25)
    except KeyboardInterrupt:
        pass
    finally:
        for s in streams:
            s.stop()
        send({"type": "stopped"})


if __name__ == '__main__':
    main()
