# AURORA-PROTOTYPE_-32-
# AURORA-32-FINAL

> A desktop companion that lives on top of your screen — transparent, always-on-top,
> and just a little bit opinionated about your homework.

**AURORA** is a Windows desktop prototype built with Electron + Live2D. She sits on your
desktop (nothing but her), talks to you in short WeChat-style message bursts, reads her
answers out loud, and quietly keeps track of what you have to hand in.

## Highlights

- 🪟 **Transparent, always-on-top pet** — click-through on empty pixels, reacts when poked
- 💬 **Chat that reads like a chat** — 1–4 short bubbles per turn, streamed token by token
- 🔊 **Speech with real lip-sync** — Edge online voices (or local Piper offline); the mouth
  is driven by an RMS envelope decoded from the actual audio, not a fake sine wave
- 📚 **Offline course-material RAG** — indexes your own PDF/PPTX/DOCX/HTML locally (BM25, zero
  dependencies) and pulls the relevant passages before answering; scanned PDFs can be
  back-filled with the built-in Windows OCR
- ⏰ **Deadline awareness** — desktop notifications + she says it out loud, with configurable
  lead time, quiet-hours, and a daily cap
- 🧠 **Layered memory** — persona / rules / memory / work-guide files, all read into the
  prompt every turn; she can write lessons she learns back into her own notebook
- 🎭 **Dress-up & idle motion** — hair, glasses, stickers, idle animation; click chains
  actually follow up on each other ("whale spouts water" → next click really spouts)
- 🧩 **Modular main process** — `windows / remind / tts / look / chat / archive`, plus a
  192-assertion self-test suite (`--selftest`, `--selftest-slow` for the heavy one)

## Requirements

Windows 10/11 · Node.js 20+ · PowerShell 5.1
Optional: Python 3.11 (for OCR), an OpenAI-compatible chat API (defaults to DeepSeek)

## Quick start

```powershell
powershell -ExecutionPolicy Bypass -File .\安装.ps1   # installs Electron
# put your API key (one line, sk-...) into  data\mystery\KEY.txt
# then double-click 启动.bat
