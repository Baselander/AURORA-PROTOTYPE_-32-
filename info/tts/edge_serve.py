#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
edge_serve.py —— 常驻的 Edge 在线语音服务（2026-10-24，主人：「把语音换成 edge 的，更自然一些」）

为什么换：piper 是本地小模型（483MB 的两个 onnx），中英都念得准、但音色偏"朗读器"；
Edge 的神经网络音色（zh-CN-XiaoxiaoNeural 等）明显更像人在说话。代价是**要联网**，
所以这条链路做成"能换回来"的：主进程按 info\\tts\\voice.json 里的 engine 选，
edge 连续失败会自动退回 piper（见 apps\\desktop\\main.mjs 的 speak()）。

协议跟 piper_serve.py **完全一样**（所以主进程那一套管道代码不用改）：
  stdin  一行一个 JSON：{"text": "要念的句子", "out": "D:\\...\\x.mp3", "voice": "可选"}
  stdout 一行一个 JSON：{"ok": true, "out": "...", "ms": 123, "seconds": 1.7, "engine": "edge"}
                        失败时 {"ok": false, "error": "..."}
  启动完成先吐一行 {"ok": true, "ready": true, "engine": "edge", ...}
  退出：stdin 收到 {"quit": true} 或 EOF。

⚠️ 本文件只管"把句子变成 mp3"，不负责播放 —— 播放和口型在页面那边（new Audio(url)）。
⚠️ 输出是 **mp3**（Edge 只给 mp3），宿主的 MIME 表里有 .mp3，页面能直接播。
"""

import asyncio
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))

DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"
# Edge 的音色名（想看全部：python -m edge_tts --list-voices）
VOICES = {
    "xiaoxiao": "zh-CN-XiaoxiaoNeural",   # 女声，温柔自然（默认）
    "xiaoyi": "zh-CN-XiaoyiNeural",       # 女声，更年轻一点
    "xiaochen": "zh-CN-XiaochenNeural",   # 女声，偏成熟
    "yunxi": "zh-CN-YunxiNeural",         # 男声，少年感
    "yunjian": "zh-CN-YunjianNeural",     # 男声
}


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_cfg():
    """voice.json 里的小设置（没有就用默认；坏文件也不许把服务弄死）"""
    cfg = {"voice": DEFAULT_VOICE, "rate": "+0%", "pitch": "+0Hz", "volume": "+0%"}
    path = os.path.join(HERE, "voice.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if isinstance(raw, dict):
            if isinstance(raw.get("voice"), str) and raw["voice"].strip():
                v = raw["voice"].strip()
                cfg["voice"] = VOICES.get(v, v)
            for k in ("rate", "pitch", "volume"):
                if isinstance(raw.get(k), str) and raw[k].strip():
                    cfg[k] = raw[k].strip()
    except FileNotFoundError:
        pass
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"voice.json 读不动（用默认）：{exc}\n")
    return cfg


async def synth(text, out_path, voice, rate, pitch, volume):
    import edge_tts  # 延迟 import：没装的时候错误信息更清楚

    comm = edge_tts.Communicate(text, voice, rate=rate, volume=volume, pitch=pitch)
    audio = bytearray()
    async for chunk in comm.stream():
        if chunk.get("type") == "audio" and chunk.get("data"):
            audio.extend(chunk["data"])
    if not audio:
        raise RuntimeError("Edge 一个字都没合成出来（是不是只有标点？）")
    out_dir = os.path.dirname(out_path)
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)
    with open(out_path, "wb") as fh:
        fh.write(bytes(audio))
    # Edge 给的是 24kHz 单声道 48kbps mp3 → 用时长大致是 字节数*8/48000
    seconds = round(len(audio) * 8 / 48000.0, 2)
    return seconds


def main():
    cfg = load_cfg()
    try:
        import edge_tts  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "error": f"没有 edge-tts 这个包（pip install edge-tts）：{exc}"})
        return
    emit({
        "ok": True,
        "ready": True,
        "engine": "edge",
        "voice": cfg["voice"],
        "rate": cfg["rate"],
        "pitch": cfg["pitch"],
    })

    # 按字节读：.NET 那边写进来的可能不是 UTF-8（跟 piper_serve 同一个坑）
    stream = getattr(sys.stdin, "buffer", sys.stdin)
    while True:
        blob = stream.readline()
        if not blob:
            break
        if isinstance(blob, str):
            line = blob.strip()
        else:
            try:
                line = blob.decode("utf-8").strip()
            except UnicodeDecodeError:
                line = blob.decode("gbk", errors="replace").strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            emit({"ok": False, "error": "请求不是合法 JSON"})
            continue
        if req.get("quit"):
            break
        text = str(req.get("text", "")).strip()
        out_path = str(req.get("out", "")).strip()
        if not text or not out_path:
            emit({"ok": False, "error": "要给 text 和 out"})
            continue
        voice = str(req.get("voice") or cfg["voice"])
        voice = VOICES.get(voice, voice)
        t0 = time.time()
        try:
            # 2026-10-25 实测：Edge 偶尔回 NoAudioReceived（它那边抖动/限流）。
            # 同一句重试一次基本就成；两次都失败才报错。
            seconds = None
            last_err = None
            for attempt in range(2):
                try:
                    seconds = asyncio.run(synth(text, out_path, voice, cfg["rate"], cfg["pitch"], cfg["volume"]))
                    last_err = None
                    break
                except Exception as exc:  # noqa: BLE001
                    last_err = exc
                    if attempt == 0:
                        time.sleep(0.9)
            if seconds is None:
                raise last_err if last_err is not None else RuntimeError("未知失败")
            emit({
                "ok": True,
                "out": out_path,
                "ms": int((time.time() - t0) * 1000),
                "seconds": seconds,
                "engine": "edge",
                "voice": voice,
            })
        except Exception as exc:  # noqa: BLE001
            emit({"ok": False, "error": f"{type(exc).__name__}: {exc}", "engine": "edge", "text": text[:60]})


if __name__ == "__main__":
    main()
