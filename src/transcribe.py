#!/usr/bin/env python3
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
        from faster_whisper import WhisperModel
except ImportError as e:
    print(json.dumps({"type": "error", "message": f"Missing dependency: {e}. Run: pip install faster-whisper sounddevice numpy"}), flush=True)
    sys.exit(1)

SAMPLE_RATE  = 16000
MIN_DURATION = 0.8   # skip audio shorter than this

_transcribe_lock = threading.Lock()

def send(obj):
    print(json.dumps(obj), flush=True)

def list_devices():
    devices  = sd.query_devices()
    hostapis = sd.query_hostapis()
    result   = []
    for i, d in enumerate(devices):
        api = hostapis[d['hostapi']]['name'] if d['hostapi'] < len(hostapis) else ''
        result.append({
            "index": i, "name": d["name"],
            "inputs": d["max_input_channels"], "outputs": d["max_output_channels"],
            "default_sr": d["default_samplerate"], "hostapi": api
        })
    send({"type": "devices", "devices": result})
    sys.exit(0)


class Recorder:
    def __init__(self, device_indices, model):
        self.device_indices = device_indices
        self.model          = model
        self.buffers        = {idx: [] for idx in device_indices}
        self.recording      = False
        self.lock           = threading.Lock()
        self.streams        = []

    def open_streams(self):
        for idx in self.device_indices:
            try:
                stream = sd.InputStream(
                    device=idx, channels=1, samplerate=SAMPLE_RATE,
                    blocksize=int(SAMPLE_RATE * 0.1), dtype='float32',
                    callback=self._make_callback(idx)
                )
                stream.start()
                self.streams.append(stream)
            except Exception as e:
                send({"type": "error", "message": f"Could not open device {idx}: {e}"})

    def _make_callback(self, idx):
        def cb(indata, frames, time_info, status):
            if self.recording:
                with self.lock:
                    self.buffers[idx].append(indata[:, 0].copy())
        return cb

    def start(self):
        with self.lock:
            self.buffers   = {idx: [] for idx in self.device_indices}
            self.recording = True
        send({"type": "recording_started"})

    def stop(self):
        self.recording = False
        threading.Thread(target=self._finish, daemon=True).start()

    def _finish(self):
        self._drain_and_transcribe()   # get the last partial chunk
        send({"type": "recording_stopped"})

    def _drain_and_transcribe(self):
        with self.lock:
            snapshot       = {idx: list(chunks) for idx, chunks in self.buffers.items()}
            self.buffers   = {idx: [] for idx in self.device_indices}

        segments = [np.concatenate(c) for c in snapshot.values() if c]
        if not segments:
            return

        max_len = max(len(s) for s in segments)
        padded  = [np.pad(s, (0, max_len - len(s))) for s in segments]
        mixed   = np.mean(np.stack(padded), axis=0)
        mixed   = np.ascontiguousarray(mixed.flatten(), dtype=np.float32)
        mixed   = np.clip(mixed, -1.0, 1.0)

        if len(mixed) / SAMPLE_RATE < MIN_DURATION:
            return

        try:
            with _transcribe_lock:
                segments, _ = self.model.transcribe(
                    mixed, language='en',
                    condition_on_previous_text=False
                )
            text = ' '.join(s.text for s in segments).strip()
            if text:
                send({"type": "chunk", "text": text})
        except Exception:
            pass   # silently skip bad chunks

    def close(self):
        for s in self.streams:
            try: s.stop(); s.close()
            except Exception: pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--list-devices', action='store_true')
    parser.add_argument('--mic-device',    type=int, default=None)
    parser.add_argument('--system-device', type=int, default=None)
    parser.add_argument('--model',         type=str, default='base.en')
    args = parser.parse_args()

    if args.list_devices:
        list_devices(); return

    send({"type": "loading", "message": f"Loading Whisper ({args.model})..."})
    try:
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
    except Exception as e:
        send({"type": "error", "message": f"Failed to load Whisper: {e}"}); sys.exit(1)

    devices = [d for d in [args.mic_device, args.system_device] if d is not None]
    if not devices:
        send({"type": "error", "message": "No devices configured."}); sys.exit(1)

    recorder = Recorder(devices, model)
    recorder.open_streams()
    send({"type": "ready"})

    try:
        while True:
            line = sys.stdin.readline()
            if line:
                cmd = line.strip()
                if   cmd == 'quit':  break
                elif cmd == 'start': recorder.start()
                elif cmd == 'stop':  recorder.stop()
            else:
                time.sleep(0.25)
    except KeyboardInterrupt:
        pass
    finally:
        recorder.close()
        send({"type": "stopped"})

if __name__ == '__main__':
    main()
