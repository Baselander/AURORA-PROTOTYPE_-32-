#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
piper_serve.py —— 常驻的本地 TTS 服务（2026-10-22）

为什么要有它：
  `piper_say.py` 每次调用都要**重新加载** 483MB 的 onnx 模型（冷启动 ~10 秒）。
  想"边生成边念"（浮窗流式回复逐句开说）就一条都念不出来——越念越落后。

  这个进程把模型**只加载一次**，然后：
    stdin  一行一个 JSON：{"text": "要念的句子", "out": "D:\\...\\x.wav"}
    stdout 一行一个 JSON：{"ok": true, "out": "...", "ms": 123, "seconds": 1.7}
                          失败时 {"ok": false, "error": "..."}
  退出：stdin 收到 {"quit": true} 或 EOF。

  ⚠️ 复用 `piper_say.py` 里的模型查找 / 中英切分 / 写 wav / 响度校准（同一套代码，不另写一份）。
  ⚠️ 本文件只管"把句子变成 wav"，不负责播放 —— 播放和口型同步在浮窗那边（SoundPlayer + Get-WavEnvelope）。
"""

import importlib.util
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(HERE))

# 复用 piper_say.py（它把 main() 放在 __main__ 保护里，import 不会跑主流程）
spec = importlib.util.spec_from_file_location("piper_say_impl", os.path.join(HERE, "piper_say.py"))
ps = importlib.util.module_from_spec(spec)
sys.modules["piper_say_impl"] = ps
spec.loader.exec_module(ps)

import numpy as np  # noqa: E402  （piper_say 里也用它，但显式 import 更清楚）
from piper import PiperVoice, SynthesisConfig  # noqa: E402


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    models_dir = os.path.join(PROJECT_ROOT, "models", "piper")
    found = ps.find_models(models_dir)
    model_zh, note_zh = ps.pick_model("", found["zh"], models_dir, "zh")
    model_en, note_en = ps.pick_model("", found["en"], models_dir, "en")
    notes = [n for n in (note_zh, note_en) if n]
    notes.extend(ps.prepare_offline_for_pinyin([model_zh, model_en]))

    started = time.time()
    voices = {}
    for path in [p for p in (model_zh, model_en) if p]:
        voices[path] = PiperVoice.load(path, download_dir=os.path.dirname(path))
    syn = SynthesisConfig(length_scale=1.0, volume=1.0, normalize_audio=True)
    emit({
        "ok": True,
        "ready": True,
        "models": [os.path.basename(p) for p in voices.keys()],
        "load_seconds": round(time.time() - started, 2),
        "notes": notes,
    })

    # ⚠️ 2026-10-22 踩的坑：.NET Framework 的 Process.StandardInput **没有** StandardInputEncoding，
    #   它按控制台代码页（中文机器上常是 GBK/936）写字节；而 python 默认按 UTF-8 读 → 直接解码炸。
    #   所以这里**按字节读**，先试 UTF-8、失败再试 GBK。
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
        t0 = time.time()
        try:
            plan = ps.plan_segments(text)
            pieces = []
            used_rate = 0
            skipped = 0
            for seg in plan:
                path = model_zh if seg["lang"] == "zh" else model_en
                voice = voices.get(path)
                if voice is None:
                    skipped += 1
                    continue
                parts = []
                for chunk in voice.synthesize(seg["text"], syn_config=syn):
                    parts.append(chunk.audio_float_array)
                    if not used_rate:
                        used_rate = chunk.sample_rate
                if not parts:
                    skipped += 1
                    continue
                audio = parts[0] if len(parts) == 1 else np.concatenate(parts)
                if used_rate and int(voice.config.sample_rate) != used_rate:
                    audio = ps.resample(audio.astype(np.float32), int(voice.config.sample_rate), used_rate)
                pieces.append(audio.astype(np.float32))
            if not pieces or not used_rate:
                emit({"ok": False, "error": "一段音频都没生成出来（是不是只有标点？）", "text": text})
                continue
            rates = {int(voices[(model_zh if seg["lang"] == "zh" else model_en)].config.sample_rate)
                     for seg in plan if (model_zh if seg["lang"] == "zh" else model_en) in voices}
            target_rate = used_rate if len(rates) <= 1 else 24000
            if target_rate != used_rate:
                pieces = [ps.resample(p, used_rate, target_rate) for p in pieces]
            merged = np.concatenate(pieces) if len(pieces) > 1 else pieces[0]
            # 响度按 RMS 校准（和 piper_say 同一套，听感一致）
            if merged.size:
                rms_now = float(np.sqrt(np.mean(merged ** 2)))
                peak_now = float(np.max(np.abs(merged)))
                if rms_now > 1e-6 and peak_now > 1e-6:
                    gain = ps.TARGET_RMS / rms_now
                    if peak_now * gain > ps.PEAK_CEILING:
                        gain = ps.PEAK_CEILING / peak_now
                    merged = merged * gain
            out_dir = os.path.dirname(out_path)
            if out_dir and not os.path.isdir(out_dir):
                os.makedirs(out_dir, exist_ok=True)
            ps.write_wav(out_path, merged, target_rate)
            seconds = round(len(merged) / float(target_rate), 2)
            emit({"ok": True, "out": out_path, "ms": int((time.time() - t0) * 1000),
                  "seconds": seconds, "skipped": skipped})
        except Exception as exc:  # noqa: BLE001
            emit({"ok": False, "error": f"{type(exc).__name__}: {exc}", "text": text[:60]})


if __name__ == "__main__":
    main()
