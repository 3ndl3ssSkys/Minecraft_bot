#!/usr/bin/env python3
"""
Local speech for the bot: Whisper (faster-whisper) to hear you, Kokoro to talk. Nothing leaves your PC.

OpenAI-compatible, so the bot (or anything else) can use it:
  POST /v1/audio/transcriptions   multipart: file, model, language     -> {"text": "..."}
  POST /v1/audio/speech           json: input, voice, speed             -> audio/wav
  GET  /v1/audio/voices                                                  -> {"voices": [...]}
  GET  /health

Setup (once), in a Command Prompt:
  pip install faster-whisper kokoro-onnx soundfile
Run:
  python scripts\\voice-server.py
Then in config.local.json:
  "voice": { "stt": "server", "sttUrl": "http://localhost:8880/v1/audio/transcriptions",
             "tts": "server", "ttsUrl": "http://localhost:8880/v1/audio/speech", "ttsVoice": "af_bella" }

Options: --port 8880  --stt-model base.en (tiny.en, base.en, small.en, distil-small.en...)  --device cpu|cuda
         --no-stt / --no-tts  --models-dir <folder>
Both run on the CPU by default, so the graphics card stays free for Ollama. The first start downloads the Kokoro
voice (about 350 MB, from the kokoro-onnx GitHub releases) and the Whisper model (from Hugging Face).
"""

import argparse
import io
import json
import os
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KOKORO_FILES = {
    'kokoro-v1.0.onnx': 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx',
    'voices-v1.0.bin': 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin',
}
LANGS = {'a': 'en-us', 'b': 'en-gb', 'e': 'es', 'f': 'fr-fr', 'h': 'hi', 'i': 'it', 'p': 'pt-br', 'j': 'ja', 'z': 'cmn'}


def parse_multipart(body, content_type):
    """Split a multipart/form-data body into {name: (filename, bytes)} (no cgi module needed)."""
    marker = 'boundary='
    if marker not in content_type:
        return {}
    boundary = content_type.split(marker, 1)[1].split(';')[0].strip().strip('"').encode()
    out = {}
    for part in body.split(b'--' + boundary):
        part = part.strip(b'\r\n')
        if not part or part == b'--':
            continue
        head, _, data = part.partition(b'\r\n\r\n')
        disp = next((h for h in head.split(b'\r\n') if h.lower().startswith(b'content-disposition')), b'').decode('utf-8', 'replace')
        name = filename = None
        for item in disp.split(';'):
            item = item.strip()
            if item.startswith('name='):
                name = item[5:].strip('"')
            elif item.startswith('filename='):
                filename = item[9:].strip('"')
        if name:
            out[name] = (filename, data[:-2] if data.endswith(b'\r\n') else data)
    return out


def download(url, path):
    print(f'  downloading {os.path.basename(path)} ...', flush=True)
    tmp = path + '.part'
    with urllib.request.urlopen(url) as r, open(tmp, 'wb') as f:
        total = int(r.headers.get('Content-Length') or 0)
        done = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if total:
                print(f'\r  {done * 100 // total}%', end='', flush=True)
    print('', flush=True)
    os.replace(tmp, path)


class Speech:
    def __init__(self, args):
        self.args = args
        self.lock = threading.Lock()
        self.whisper = None
        self.kokoro = None
        if not args.no_stt:
            from faster_whisper import WhisperModel
            print(f'Loading Whisper "{args.stt_model}" on {args.device} (the first time it downloads) ...', flush=True)
            t = time.time()
            self.whisper = WhisperModel(args.stt_model, device=args.device, compute_type='int8' if args.device == 'cpu' else 'int8_float16')
            print(f'  ready in {time.time() - t:.1f}s', flush=True)
        if not args.no_tts:
            from kokoro_onnx import Kokoro
            os.makedirs(args.models_dir, exist_ok=True)
            for name, url in KOKORO_FILES.items():
                path = os.path.join(args.models_dir, name)
                if not os.path.exists(path):
                    download(url, path)
            print('Loading Kokoro ...', flush=True)
            self.kokoro = Kokoro(os.path.join(args.models_dir, 'kokoro-v1.0.onnx'), os.path.join(args.models_dir, 'voices-v1.0.bin'))
            self.kokoro.create('ready', voice='af_bella', lang='en-us')  # warm up
            print('  ready', flush=True)

    def transcribe(self, data, language=None):
        if not self.whisper:
            raise RuntimeError('speech-to-text is off (--no-stt)')
        lang = (language or '').split('-')[0].lower() or None
        with self.lock:
            segments, _ = self.whisper.transcribe(io.BytesIO(data), language=lang, beam_size=1, vad_filter=True)
            return ' '.join(s.text.strip() for s in segments).strip()

    def speak(self, text, voice='af_bella', speed=1.0):
        if not self.kokoro:
            raise RuntimeError('text-to-speech is off (--no-tts)')
        import soundfile as sf
        voices = self.kokoro.get_voices()
        if voice not in voices and '+' not in voice:
            voice = 'af_bella'
        lang = LANGS.get(voice[:1], 'en-us')
        with self.lock:
            samples, rate = self.kokoro.create(text, voice=voice, speed=float(speed or 1), lang=lang)
        buf = io.BytesIO()
        sf.write(buf, samples, rate, format='WAV', subtype='PCM_16')
        return buf.getvalue()


def make_handler(speech):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *a):
            pass

        def reply(self, code, body, ctype='application/json'):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode()
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def body(self):
            n = int(self.headers.get('Content-Length') or 0)
            return self.rfile.read(n) if n else b''

        def do_GET(self):
            if self.path.startswith('/health'):
                return self.reply(200, {'ok': True, 'stt': bool(speech.whisper), 'tts': bool(speech.kokoro)})
            if self.path.startswith('/v1/audio/voices'):
                return self.reply(200, {'voices': speech.kokoro.get_voices() if speech.kokoro else []})
            self.reply(404, {'error': 'not found'})

        def do_POST(self):
            try:
                if self.path.startswith('/v1/audio/transcriptions'):
                    parts = parse_multipart(self.body(), self.headers.get('Content-Type', ''))
                    if 'file' not in parts:
                        return self.reply(400, {'error': 'no file'})
                    lang = parts.get('language', (None, b''))[1].decode() or None
                    t = time.time()
                    text = speech.transcribe(parts['file'][1], lang)
                    print(f'heard ({time.time() - t:.2f}s): {text}', flush=True)
                    return self.reply(200, {'text': text})
                if self.path.startswith('/v1/audio/speech'):
                    req = json.loads(self.body() or b'{}')
                    t = time.time()
                    wav = speech.speak(str(req.get('input', ''))[:1000], str(req.get('voice') or 'af_bella'), req.get('speed') or 1)
                    print(f'spoke ({time.time() - t:.2f}s): {str(req.get("input", ""))[:60]}', flush=True)
                    return self.reply(200, wav, 'audio/wav')
                self.reply(404, {'error': 'not found'})
            except Exception as e:  # keep serving
                self.reply(500, {'error': str(e)})
    return Handler


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    p = argparse.ArgumentParser(description='Local speech (Whisper + Kokoro) for the Minecraft bot.')
    p.add_argument('--port', type=int, default=8880)
    p.add_argument('--host', default='127.0.0.1')
    p.add_argument('--stt-model', default='base.en')
    p.add_argument('--device', default='cpu')
    p.add_argument('--no-stt', action='store_true')
    p.add_argument('--no-tts', action='store_true')
    p.add_argument('--models-dir', default=os.path.join(here, 'voice-models'))
    args = p.parse_args()
    try:
        speech = Speech(args)
    except ImportError as e:
        print(f'Missing a package ({e.name}). Run:  pip install faster-whisper kokoro-onnx soundfile', file=sys.stderr)
        sys.exit(1)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(speech))
    print(f'Voice server on http://{args.host}:{args.port}  (hearing: {"on" if speech.whisper else "off"}, speaking: {"on" if speech.kokoro else "off"})', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
