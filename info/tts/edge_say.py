#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
edge_say.py —— 用 edge-tts（微软 Edge 的在线神经语音）生成语音，输出 **16 位 PCM wav**。

=============================================================================
 2026-10-18 v2（主人：「说英文 + 更流畅 + 尽量 ASMR」）
=============================================================================

v1 只会念中文、一种音色、一次生成完。v2 加了四件事：

  1. **中英双语自动选音色**：把文字按"这句话是中文还是英文"切开，中文用 `--voice-zh`、
     英文用 `--voice-en`，逐句合成后拼成一个 wav。
     （混排的句子会按"连续字母段"再切，例如「明天交 homework 的 P12」会切成
      「明天交 / homework 的 / P12」三块 —— 但只有**含 3 个以上连续字母**的块才当英文，
      否则「P12」这种编号会被英文音色念得很怪。）
  2. **句间停顿可调**（`--gap-ms`）：把每块之间插入真正的静音，而不是靠标点。
  3. **ASMR 风格**（`--style asmr`）：更慢（默认 -18%）、更轻（默认 -25%）、
     句间停顿更长（默认 450ms）。**诚实说明**：edge-tts 是"播报腔"，做不出真正的耳语质感；
     要耳语得换本地模型（Piper whisper / XTTS 之类）。这里做到的是"轻、慢、有停顿"。
  4. **缓存**（`--cache-dir`）：同一段文字 + 同一组参数第二次直接用上次的 wav。
     「今日提醒」这种固定内容第二次就秒出。

  ⚠️ 对调用方的契约没变：**永远产出一个 16 位 PCM 的 wav**（`--out`），
     所以 `speak.ps1` / 浮窗 / 口型同步（`Get-WavEnvelope`）一行都不用改。

=============================================================================
 口味 / 坑
=============================================================================
  · 必须显式把 stdout/stderr 设成 UTF-8：否则 Python 按控制台代码页(GBK)输出，
    被 PowerShell 当 UTF-8 读 → 中文全乱码（本项目踩过的坑）。
  · 输出**只有一行 JSON**（调用方按 JSON 解析，不去猜中文）。
  · 只联网到微软的语音服务（edge-tts 的固定端点）；除目标 wav / 缓存文件外不写任何东西。

 用法：
   python edge_say.py --text "主人，今天要交生物实验报告。" --out out\\x.wav
   python edge_say.py --text "submit the bio worksheet" --out x.wav --voice-en en-US-AriaNeural
   python edge_say.py --text "..." --out x.wav --style asmr
   python edge_say.py --text "..." --out x.wav --cache-dir ..\\..\\out\\tts-cache
"""

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
import tempfile

# ── 坑 #3：先强制 UTF-8，再做别的 ──────────────────────────────────────────────
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # 老 Python 没这个属性也不该让脚本挂掉
    pass


# ── 语种切分 ──────────────────────────────────────────────────────────────────

CJK = r"\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"
CJK_RE = re.compile(f"[{CJK}]")
# 「含 3 个以上连续拉丁字母」才当英文（否则 P12 / 3.5 / AP 之类的编号会被念得很怪）
LATIN_WORD_RE = re.compile(r"[A-Za-z]{3,}")
LATIN_RUN_RE = re.compile(rf"[A-Za-z0-9'\-\.,%:/+ ]+")

# 句子分隔（保留标点，让它跟着前一句走）
SENTENCE_SPLIT_RE = re.compile(r"(?<=[。！？!?；;…\n])")

DEFAULT_VOICE_ZH = "zh-CN-XiaoyiNeural"
DEFAULT_VOICE_EN = "en-US-AriaNeural"


def _sentence_pieces(text: str) -> list[str]:
    """先按句末标点切成句子（顺序不变，拼回去等于原文）。"""
    pieces = [piece for piece in SENTENCE_SPLIT_RE.split(text) if piece.strip()]
    return pieces or ([text] if text.strip() else [])


def _split_by_script(sentence: str) -> list[tuple[str, str]]:
    """
    把一句话再按"中文 / 英文"切开。

    @returns [(lang, text)]，lang 是 'zh' 或 'en'
    """
    if not sentence:
        return []
    if not CJK_RE.search(sentence):
        # 整句没有汉字 → 看有没有像英文单词的东西
        return [("en", sentence)] if LATIN_WORD_RE.search(sentence) else [("zh", sentence)]

    out: list[tuple[str, str]] = []
    buffer = ""
    buffer_lang = "zh"
    for char in sentence:
        if CJK_RE.match(char) or char in "，。！？；：、…（）《》“”‘’　":
            lang = "zh"
        elif char.isascii() and (char.isalnum() or char in "'-.,%:/+ "):
            lang = "en"
        else:
            lang = "zh"
        if lang != buffer_lang and buffer:
            out.append((buffer_lang, buffer))
            buffer = ""
        buffer_lang = lang
        buffer += char
    if buffer:
        out.append((buffer_lang, buffer))

    # 「en」块里其实没有英文单词（例如 "P12"、"3.5"）→ 并回中文，别让英文音色念编号
    merged: list[tuple[str, str]] = []
    for lang, chunk in out:
        if lang == "en" and not LATIN_WORD_RE.search(chunk):
            lang = "zh"
        if merged and merged[-1][0] == lang:
            merged[-1] = (lang, merged[-1][1] + chunk)
        else:
            merged.append((lang, chunk))
    return [(lang, chunk) for lang, chunk in merged if chunk.strip()]


def plan_segments(text: str) -> list[dict]:
    """
    把整段文字切成"每块用一种音色"的计划。

    @returns [{'lang': 'zh'|'en', 'text': str}]
    """
    segments: list[dict] = []
    for sentence in _sentence_pieces(text):
        for lang, chunk in _split_by_script(sentence):
            if not chunk.strip():
                continue
            # 同语种的相邻块合并（少调几次接口、念得更连贯）
            if segments and segments[-1]["lang"] == lang:
                segments[-1]["text"] += chunk
            else:
                segments.append({"lang": lang, "text": chunk})
    # 去掉首尾空白
    for segment in segments:
        segment["text"] = segment["text"].strip()
    return [segment for segment in segments if segment["text"]]


# ── 参数 / 输出 ───────────────────────────────────────────────────────────────

def fail(msg: str, code: int = 1) -> None:
    """输出一行 JSON 错误并退出。"""
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    sys.exit(code)


def parse_percent(text: str, fallback: int = 0) -> int:
    match = re.search(r"([+-]?\d+)", text or "")
    if not match:
        return fallback
    return int(match.group(1))


def style_defaults(style: str) -> dict:
    """风格默认值（命令行没显式给的时候用）。"""
    if style == "asmr":
        # 「轻、慢、近」：语速放慢、音量降低、音高微调、句间停顿加长。
        # ⚠️ 诚实说：edge-tts 是播报腔，做不出真正的耳语质感；要耳语得换本地模型。
        return {"rate": -18, "volume": -25, "gap_ms": 450, "pitch": "-3Hz"}
    return {"rate": 0, "volume": 0, "gap_ms": 180, "pitch": "+0Hz"}


def cache_key(payload: dict) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser(description="edge-tts → wav（16 位 PCM 单声道，支持中英混排）")
    ap.add_argument("--text", default="", help="要念的文字")
    ap.add_argument(
        "--text-file",
        default="",
        help="从 UTF-8 文件读要念的文字（**更推荐**：中文走命令行参数在某些编码下会被搞坏）",
    )
    ap.add_argument("--out", required=True, help="输出的 wav 路径")
    ap.add_argument("--voice", default="", help="（兼容旧用法）中文音色；等同于 --voice-zh")
    ap.add_argument("--voice-zh", default="", help="中文音色（默认 zh-CN-XiaoyiNeural）")
    ap.add_argument("--voice-en", default="", help="英文音色（默认 en-US-AriaNeural）")
    ap.add_argument("--rate", default="", help="语速，如 +10%% / -18%%；空 = 按风格默认")
    ap.add_argument("--volume", default="", help="音量，如 +20%%；空 = 按风格默认")
    ap.add_argument("--pitch", default="", help="音高，如 -3Hz / +2Hz；空 = 按风格默认")
    ap.add_argument("--style", default="normal", choices=["normal", "asmr"], help="normal / asmr")
    ap.add_argument("--gap-ms", type=int, default=-1, help="句间停顿毫秒；-1 = 按风格默认")
    ap.add_argument("--cache-dir", default="", help="缓存目录（空 = 不用缓存）")
    ap.add_argument("--no-cache", action="store_true", help="强制重新生成")
    ap.add_argument("--keep-mp3", default="", help="顺便把中间的 mp3 留在哪（默认删掉）")
    ap.add_argument("--plan-only", action="store_true", help="只输出切分计划（不联网、不写文件）")
    args = ap.parse_args()

    voice_zh = args.voice_zh or args.voice or DEFAULT_VOICE_ZH
    voice_en = args.voice_en or DEFAULT_VOICE_EN
    defaults = style_defaults(args.style)
    rate = args.rate.strip() or f"{defaults['rate']:+d}%"
    volume = args.volume.strip() or f"{defaults['volume']:+d}%"
    pitch = args.pitch.strip() or str(defaults["pitch"])
    gap_ms = args.gap_ms if args.gap_ms >= 0 else defaults["gap_ms"]
    text = args.text
    if not text.strip() and args.text_file.strip():
        try:
            with open(args.text_file, "r", encoding="utf-8-sig") as handle:
                text = handle.read()
        except OSError as exc:
            fail(f"读不了 --text-file（{args.text_file}）：{exc}")
    if not text.strip():
        fail("没给文字：用 --text 或 --text-file 传一段要念的内容")

    segments = plan_segments(text)
    if not segments:
        fail("没有可念的文字")

    plan = [
        {"lang": segment["lang"], "voice": voice_zh if segment["lang"] == "zh" else voice_en, "text": segment["text"]}
        for segment in segments
    ]

    if args.plan_only:
        print(json.dumps({"ok": True, "plan": plan, "gap_ms": gap_ms}, ensure_ascii=False))
        return

    try:
        import edge_tts
    except ImportError:
        fail("没装 edge-tts。装它：python -m pip install edge-tts")
    try:
        import soundfile as sf
    except ImportError:
        fail("没装 soundfile（用来把 mp3 转 wav）：python -m pip install soundfile")
    import numpy as np

    # ── 缓存命中就直接用 ──────────────────────────────────────────────────────
    out_path = os.path.abspath(args.out)
    key = cache_key(
        {
            "text": text,
            "voice_zh": voice_zh,
            "voice_en": voice_en,
            # 这四项决定听感，必须进缓存键（否则"改了语速却还是旧音频"）
            "rate": rate,
            "volume": volume,
            "pitch": pitch,
            "gap_ms": gap_ms,
            "style": args.style,
        }
    )
    cache_path = os.path.join(args.cache_dir, f"{key}.wav") if args.cache_dir else ""
    if cache_path and not args.no_cache and os.path.exists(cache_path) and os.path.getsize(cache_path) > 44:
        out_dir = os.path.dirname(out_path)
        if out_dir and not os.path.isdir(out_dir):
            os.makedirs(out_dir, exist_ok=True)
        if os.path.abspath(cache_path) != out_path:
            with open(cache_path, "rb") as src, open(out_path, "wb") as dst:
                dst.write(src.read())
        seconds = _wav_seconds(out_path)
        print(
            json.dumps(
                {
                    "ok": True,
                    "wav": out_path,
                    "voice": voice_zh if len({p["voice"] for p in plan}) == 1 else f"{voice_zh}+{voice_en}",
                    "seconds": round(seconds, 2),
                    "sample_rate": _wav_rate(out_path),
                    "bytes": os.path.getsize(out_path),
                    "from_cache": True,
                    "segments": plan,
                    "gap_ms": gap_ms,
                    "style": args.style,
                },
                ensure_ascii=False,
            )
        )
        return

    # ── 逐块合成，拼成一条 ────────────────────────────────────────────────────
    tmp_dir = tempfile.mkdtemp(prefix="edge_say_")
    pieces: list[tuple[object, int]] = []  # (float 数组, 采样率)
    used_rate = 0
    try:
        for index, item in enumerate(plan):
            mp3_path = (
                args.keep_mp3
                if (args.keep_mp3 and len(plan) == 1)
                else os.path.join(tmp_dir, f"part{index}.mp3")
            )
            try:
                asyncio.run(_synth(item["text"], item["voice"], rate, volume, pitch, mp3_path))
            except Exception as exc:  # 网络不通 / 音色名写错 / 被限流
                fail(f"edge-tts 生成失败（第 {index + 1} 块，音色 {item['voice']}）：{type(exc).__name__}: {exc}")
            if not os.path.exists(mp3_path) or os.path.getsize(mp3_path) == 0:
                fail(f"edge-tts 没产出音频（第 {index + 1} 块，网络？）")
            try:
                data, sr = sf.read(mp3_path, dtype="float32", always_2d=False)
            except Exception as exc:
                fail(f"mp3→wav 失败（第 {index + 1} 块）：{type(exc).__name__}: {exc}")
            if getattr(data, "ndim", 1) > 1:
                data = data.mean(axis=1)
            if used_rate and sr != used_rate:
                # 采样率不一致（极端情况）→ 简单重采样，保证能拼
                data = _resample(data, sr, used_rate)
                sr = used_rate
            used_rate = used_rate or sr
            pieces.append((data, int(sr)))
            item["seconds"] = round(len(data) / float(sr), 2)
    finally:
        if not args.keep_mp3:
            for name in os.listdir(tmp_dir):
                try:
                    os.remove(os.path.join(tmp_dir, name))
                except OSError:
                    pass
        try:
            os.rmdir(tmp_dir)
        except OSError:
            pass

    if not pieces:
        fail("一块音频都没生成出来")

    sr = used_rate
    gap = np.zeros(max(0, int(sr * (gap_ms / 1000.0))), dtype=pieces[0][0].dtype)
    chunks: list[object] = []
    for index, (data, _rate) in enumerate(pieces):
        if index > 0 and gap.size > 0:
            chunks.append(gap)
        chunks.append(data)
    merged = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]

    try:
        out_dir = os.path.dirname(out_path)
        if out_dir and not os.path.isdir(out_dir):
            os.makedirs(out_dir, exist_ok=True)
        sf.write(out_path, merged, sr, subtype="PCM_16", format="WAV")
    except Exception as exc:
        fail(f"写 wav 失败：{type(exc).__name__}: {exc}")

    # 写缓存（先把结果写出去，再写缓存；缓存写失败不影响这次出声）
    cached = False
    if cache_path:
        try:
            os.makedirs(args.cache_dir, exist_ok=True)
            with open(out_path, "rb") as src, open(cache_path, "wb") as dst:
                dst.write(src.read())
            cached = True
        except OSError:
            cached = False

    seconds = len(merged) / float(sr)
    print(
        json.dumps(
            {
                "ok": True,
                "wav": out_path,
                "voice": voice_zh if len({p["voice"] for p in plan}) == 1 else f"{voice_zh}+{voice_en}",
                "seconds": round(seconds, 2),
                "sample_rate": sr,
                "bytes": os.path.getsize(out_path),
                "from_cache": False,
                "cache_written": cached,
                "segments": plan,
                "gap_ms": gap_ms,
                "style": args.style,
                "rate": rate,
                "volume": volume,
                "pitch": pitch,
            },
            ensure_ascii=False,
        )
    )


async def _synth(text: str, voice: str, rate: str, volume: str, pitch: str, out_mp3: str) -> None:
    import edge_tts

    communicate = edge_tts.Communicate(text, voice, rate=rate, volume=volume, pitch=pitch)
    await communicate.save(out_mp3)


def _resample(data, sr_from: int, sr_to: int):
    """极简线性重采样（只在各块采样率不一致时兜底用）。"""
    import numpy as np

    if sr_from == sr_to or data.size == 0:
        return data
    ratio = sr_to / float(sr_from)
    count = int(round(data.size * ratio))
    if count <= 0:
        return data
    src_index = np.linspace(0, data.size - 1, count)
    return np.interp(src_index, np.arange(data.size), data).astype(data.dtype)


def _wav_seconds(path: str) -> float:
    try:
        import soundfile as sf

        info = sf.info(path)
        return info.frames / float(info.samplerate)
    except Exception:
        return 0.0


def _wav_rate(path: str) -> int:
    try:
        import soundfile as sf

        return int(sf.info(path).samplerate)
    except Exception:
        return 0


if __name__ == "__main__":
    main()
