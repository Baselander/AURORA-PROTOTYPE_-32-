#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
piper_say.py —— 用 **piper（本地神经网络 TTS，离线）** 生成语音，输出 **16 位 PCM wav**。

=============================================================================
 它是什么 / 为什么要有它
=============================================================================

`edge_say.py` 用的是微软的**在线**神经语音：音质不错，但每次都要等十几秒
（联网 + 服务端排队），断网就直接哑巴。这个文件是同一件事的**本地版**：

    · 模型跑在 CPU 上（onnxruntime），**装完之后完全离线**，不联网。
    · 实测同一句话：edge ≈ 12 秒，piper ≈ 0.2 秒（差两个数量级）。
    · 中文音色：`zh_CN-huayan-medium`（女声）；英文音色：`en_US-amy-medium`（女声）。

对调用方的契约**和 edge_say.py 完全一致**：
  · 永远产出一个 **16 位 PCM 单声道 wav**（`--out`）。
    → `speak.ps1` / 浮窗 / 口型同步（`Get-WavEnvelope`）一行都不用改。
  · stdout **只有一行 JSON**（调用方按 JSON 解析，不去猜中文）。

=============================================================================
 中英混排怎么处理
=============================================================================

和 edge_say.py 用**同一套切分规则**（按句末标点切句 → 句内再按"连续拉丁字母段"切）：

    中文片段 → `--model-zh`（默认 zh_CN-huayan-medium）
    英文片段 → `--model-en`（默认 en_US-amy-medium）

切完之后逐段合成，段间插入 `--gap-ms` 毫秒静音，拼成**一条** wav。

⚠️ 为什么要按片段切而不是整段丢给中文模型：
   实测「Everything is ready for tomorrow.」丢给 huayan 也能出声（espeak 有拉丁回退），
   但音素是 `f ɔ ː` 这种被中文化改过的、而且明显漏字 —— 英文交给英文模型才对。

=============================================================================
 实测过的坑（换机器 / 换模型时会再遇到）
=============================================================================

1. **piper 的安装**：`python -m pip install piper-tts` 就行（2026-12 装的 1.8.0，
   有现成的 `win_amd64` wheel，34 MB，**自带 espeak-ng 数据** `espeak-ng-data/` 和
   `espeakbridge.pyd`）—— 不需要另外装 `piper-phonemize` / `espeakng-loader`。
   核心依赖只有 `onnxruntime` + `numpy`（本机原本就有）。

2. **huggingface.co 在本机连不上**（`WinError 10061`），但 `hf-mirror.com` 通。
   所以模型是手动从镜像下载的，**不要让 piper 自己去下载**。

3. **`zh_CN-huayan-medium` 和 `zh_CN-xiao_ya-medium` 的差别很大**：
   · huayan   → `phoneme_type = espeak`（espeak 的 cmn 音色），**开箱即用**，0.22 秒出音。
   · xiao_ya  → `phoneme_type = pinyin`（要走 g2pW：159 MB 的 `g2pw.onnx` +
     `transformers` 的 BertTokenizer），**第一句要 18.75 秒**（比 edge 还慢），
     而且 tokenizer 要联网下。→ 因此**默认选 huayan**，xiao_ya 留作可选。

4. **`download_dir` 必须指对**：piper 的拼音模型会去 `download_dir/g2pW/` 找 g2pW 数据。
   本文件默认取**模型文件所在目录**，所以 `models\\piper\\g2pW\\` 会被自动找到。

=============================================================================
 用法
=============================================================================

    python piper_say.py --text "主人，今天要交生物实验报告。" --out out\\x.wav
    python piper_say.py --text-file in.txt --out x.wav --models-dir ..\\..\\models\\piper
    python piper_say.py --text "..." --out x.wav --length-scale 1.2      # 更慢
    python piper_say.py --text "..." --out x.wav --style asmr            # 更慢更轻
    python piper_say.py --text "..." --out x.wav --cache-dir ..\\..\\out\\tts-cache\\piper
    python piper_say.py --models-dir ..\\..\\models\\piper --list        # 看有哪些本地模型
    python piper_say.py --text "..." --plan-only                         # 只看切分计划（不加载模型）

⚠️ 中文**必须**走 `--text-file`（命令行传中文在某些编码下会被搞坏）。
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
import wave

# ── 坑：先强制 UTF-8，再做别的（否则中文 JSON 被 PowerShell 按 UTF-8 读会乱码）──
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # 老 Python 没这个属性也不该让脚本挂掉
    pass


# ── 语种切分（与 edge_say.py 保持**逐字一致**，两边的听感才对得上）─────────────

CJK = r"\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"
CJK_RE = re.compile(f"[{CJK}]")
# 「含 3 个以上连续拉丁字母」才当英文（否则 P12 / 3.5 / AP 之类的编号会被念得很怪）
LATIN_WORD_RE = re.compile(r"[A-Za-z]{3,}")
# 句子分隔（保留标点，让它跟着前一句走）
SENTENCE_SPLIT_RE = re.compile(r"(?<=[。！？!?；;…\n])")

DEFAULT_MODEL_ZH = "zh_CN-huayan-medium"
DEFAULT_MODEL_EN = "en_US-amy-medium"

# 音量校准的目标 RMS 与峰值上限。
# 0.08 是**实测 edge 一句话的 rms**（0.0765），对齐它 → 换引擎时主人不会觉得"突然好大声"，
# 浮窗的口型同步峰值也不会顶满（见 main() 里那段注释）。
TARGET_RMS = 0.08
PEAK_CEILING = 0.95

# 后处理一改就把它 +1，让旧缓存自动失效（见 main() 里缓存键那段注释）。
CACHE_FORMAT_VERSION = 2


def _sentence_pieces(text: str) -> list[str]:
    """先按句末标点切成句子（顺序不变，拼回去等于原文）。"""
    pieces = [piece for piece in SENTENCE_SPLIT_RE.split(text) if piece.strip()]
    return pieces or ([text] if text.strip() else [])


def _split_by_script(sentence: str) -> list[tuple[str, str]]:
    """把一句话再按"中文 / 英文"切开。@returns [(lang, text)]，lang 是 'zh' 或 'en'"""
    if not sentence:
        return []
    if not CJK_RE.search(sentence):
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

    # 「en」块里其实没有英文单词（例如 "P12"、"3.5"）→ 并回中文，别让英文模型念编号
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
    """把整段文字切成"每块用一种模型"的计划。@returns [{'lang': 'zh'|'en', 'text': str}]"""
    segments: list[dict] = []
    for sentence in _sentence_pieces(text):
        for lang, chunk in _split_by_script(sentence):
            if not chunk.strip():
                continue
            # 同语种的相邻块合并（更连贯、少一次模型调用）
            if segments and segments[-1]["lang"] == lang:
                segments[-1]["text"] += chunk
            else:
                segments.append({"lang": lang, "text": chunk})
    for segment in segments:
        segment["text"] = segment["text"].strip()
    return [segment for segment in segments if segment["text"]]


# ── 输出 / 参数小工具 ─────────────────────────────────────────────────────────

def emit(payload: dict) -> None:
    """输出唯一的一行 JSON（调用方靠它拿结果）。"""
    print(json.dumps(payload, ensure_ascii=False))


def fail(msg: str, code: int = 1, **extra) -> None:
    """输出一行 JSON 错误并退出。"""
    payload = {"ok": False, "error": msg, "engine": "piper"}
    payload.update(extra)
    emit(payload)
    sys.exit(code)


def parse_percent(text: str, fallback: float = 0.0) -> float:
    """'+20%' / '-25' / '0' → 数字。"""
    match = re.search(r"([+-]?\d+(?:\.\d+)?)", str(text or ""))
    if not match:
        return fallback
    return float(match.group(1))


def find_models(models_dir: str) -> dict:
    """在 models_dir 里找现成的 .onnx（按语言分组，第一个是最优候选）。"""
    found = {"zh": [], "en": [], "other": []}
    if not models_dir or not os.path.isdir(models_dir):
        return found
    for name in sorted(os.listdir(models_dir)):
        if not name.lower().endswith(".onnx"):
            continue
        path = os.path.join(models_dir, name)
        if not os.path.isfile(os.path.join(path + ".json")):
            continue  # 没有配套的 .onnx.json 配置 → 用不了
        lowered = name.lower()
        if lowered.startswith(("zh_", "zh-")):
            found["zh"].append(path)
        elif lowered.startswith(("en_", "en-")):
            found["en"].append(path)
        else:
            found["other"].append(path)
    # huayan 优先（实测开箱即用、最快）；xiao_ya 要 g2pW + transformers，放后面
    found["zh"].sort(key=lambda p: (0 if "huayan" in os.path.basename(p).lower() else 1, p))
    found["en"].sort(key=lambda p: (0 if "amy" in os.path.basename(p).lower() else 1, p))
    return found


def pick_model(explicit: str, candidates: list[str], models_dir: str, kind: str) -> tuple[str, str]:
    """决定用哪个模型文件。@returns (path, note)；path 为空 = 没有可用的。"""
    explicit = (explicit or "").strip()
    if explicit:
        if os.path.isfile(explicit):
            return os.path.abspath(explicit), ""
        # 允许只写文件名（相对 models_dir）
        joined = os.path.join(models_dir, explicit)
        if os.path.isfile(joined):
            return os.path.abspath(joined), ""
        return "", f"--model-{kind} 写的路径不存在：{explicit}"
    if candidates:
        return candidates[0], ""
    return "", f"{models_dir} 里没有找到{'中文' if kind == 'zh' else '英文'}模型"


def model_phoneme_type(model_path: str) -> str:
    """读模型旁边的 .onnx.json，看它用哪种音素化（espeak / pinyin / …）。"""
    try:
        with open(model_path + ".json", "r", encoding="utf-8") as handle:
            return str(json.load(handle).get("phoneme_type", "")).lower()
    except (OSError, ValueError):
        return ""


def prepare_offline_for_pinyin(model_paths) -> list[str]:
    """
    `phoneme_type = pinyin` 的模型（zh_CN-xiao_ya 之类）要走 g2pW，而 g2pW 用
    `transformers.BertTokenizer.from_pretrained("bert-base-chinese")`。

    ⚠️ 实测的坑：transformers 每次都会去 huggingface.co 查一下 etags，而**本机连不上 HF**
       （WinError 10060，重试 5 次 ≈ 30 秒然后彻底失败）。tokenizer 其实早就在
       `~/.cache/huggingface/hub/models--bert-base-chinese` 里了 —— 网络那一步纯属浪费。
       所以：**缓存存在就强制离线模式**（不存在就不碰，让它有机会去下）。
    """
    notes = []
    if os.environ.get("HF_HUB_OFFLINE"):
        return notes
    needs = [p for p in model_paths if p and model_phoneme_type(p) == "pinyin"]
    if not needs:
        return notes
    cache = os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")
    if os.path.isdir(os.path.join(cache, "models--bert-base-chinese")):
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        notes.append("这个中文模型是 pinyin 类型（要用 g2pW），已切到 huggingface 离线模式（本地已有缓存）")
    else:
        notes.append(
            "这个中文模型是 pinyin 类型（要用 g2pW）但如果本机还没缓存 bert-base-chinese，"
            "第一次会去 huggingface 下载 —— 本机连不上 HF，建议换 zh_CN-huayan-medium"
        )
    return notes


def resample(data, sr_from: int, sr_to: int):
    """极简线性重采样（只在两种模型的采样率不一致时兜底用）。"""
    import numpy as np

    if sr_from == sr_to or data.size == 0:
        return data
    ratio = sr_to / float(sr_from)
    count = int(round(data.size * ratio))
    if count <= 0:
        return data
    src_index = np.linspace(0, data.size - 1, count)
    return np.interp(src_index, np.arange(data.size), data).astype(data.dtype)


def write_wav(path: str, samples, sample_rate: int) -> None:
    """写 16 位 PCM 单声道 wav（手写头，不依赖 soundfile）。"""
    import numpy as np

    out_dir = os.path.dirname(path)
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)          # 16 位
        handle.setframerate(int(sample_rate))
        handle.writeframes(pcm.tobytes())


def wav_info(path: str) -> dict:
    """读回 wav 头，报告客观指标（调用方和我都不听音频，只能靠这些自证）。"""
    try:
        import numpy as np

        with wave.open(path, "rb") as handle:
            frames = handle.getnframes()
            rate = handle.getframerate()
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            raw = handle.readframes(frames)
        audio = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
        rms = float(np.sqrt(np.mean(audio ** 2))) if audio.size else 0.0
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        # 断裂检测：把音频切成 50 段，数"整段几乎无声"的段数。
        # 正常的语音不会有大段全零；如果出现很多全零段，说明拼接/生成出了问题。
        silent_spans = 0
        if audio.size:
            boundaries = np.linspace(0, audio.size, 51).astype(int)
            for index in range(50):
                piece = audio[boundaries[index]:boundaries[index + 1]]
                if piece.size and float(np.max(np.abs(piece))) < 0.002:
                    silent_spans += 1
        return {
            "seconds": round(frames / float(rate), 2) if rate else 0.0,
            "sample_rate": int(rate),
            "channels": int(channels),
            "sample_width": int(width),
            "rms": round(rms, 4),
            "peak": round(peak, 4),
            "silent_spans_50": silent_spans,
            "frames": int(frames),
        }
    except Exception as exc:  # 只影响"报告好不好看"，不影响出音
        return {"info_error": f"{type(exc).__name__}: {exc}"}


# ── 主流程 ────────────────────────────────────────────────────────────────────

def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(os.path.dirname(here))          # info\tts\..\.. = 项目根
    default_models = os.path.join(project_root, "models", "piper")

    ap = argparse.ArgumentParser(
        description="piper（本地离线神经 TTS）→ wav（16 位 PCM 单声道，支持中英混排）"
    )
    ap.add_argument("--text", default="", help="要念的文字")
    ap.add_argument("--text-file", default="", help="从 UTF-8 文件读（**中文推荐走这个**）")
    ap.add_argument("--out", default="", help="输出的 wav 路径")
    ap.add_argument("--models-dir", default=default_models, help=f"模型目录（默认 {default_models}）")
    ap.add_argument("--model-zh", default="", help=f"中文模型（默认 {DEFAULT_MODEL_ZH}）")
    ap.add_argument("--model-en", default="", help=f"英文模型（默认 {DEFAULT_MODEL_EN}）")
    ap.add_argument("--length-scale", type=float, default=0.0,
                    help="piper 的 length_scale：1.0 正常，>1 更慢（0 = 用模型自带值）")
    ap.add_argument("--rate", default="", help="语速百分数（如 +10%% / -18%%），叠加在 length-scale 上")
    ap.add_argument("--volume", default="", help="音量百分数（如 -25%%），空 = 0")
    ap.add_argument("--style", default="normal", choices=["normal", "asmr"], help="normal / asmr")
    ap.add_argument("--gap-ms", type=int, default=-1, help="句间停顿毫秒；-1 = 按风格默认")
    ap.add_argument("--cache-dir", default="", help="缓存目录（空 = 不用缓存）")
    ap.add_argument("--no-cache", action="store_true", help="强制重新生成")
    ap.add_argument("--download-dir", default="",
                    help="piper 找 g2pW 等资源的目录（默认 = 模型文件所在目录）")
    ap.add_argument("--plan-only", action="store_true", help="只输出切分计划（不加载模型、不写文件）")
    ap.add_argument("--list", action="store_true", help="列出模型目录里找到的模型，然后退出")
    args = ap.parse_args()

    models_dir = os.path.abspath(args.models_dir or default_models)
    found = find_models(models_dir)

    if args.list:
        emit({
            "ok": True, "engine": "piper", "models_dir": models_dir,
            "zh": [os.path.basename(p) for p in found["zh"]],
            "en": [os.path.basename(p) for p in found["en"]],
            "other": [os.path.basename(p) for p in found["other"]],
            "g2pW_ready": os.path.isfile(os.path.join(models_dir, "g2pW", "g2pw.onnx")),
        })
        return

    # ── 文字 ──────────────────────────────────────────────────────────────────
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

    # ── 参数（风格 → 默认值；命令行显式给的值**优先**，不会被风格再叠一次）──────
    #
    # ⚠️ 这里踩过一次坑，记下来（和 edge_say.py 里那条注释是同一个坑的两面）：
    #    `speak.ps1` 每次都会**显式**把 rate/volume/gap/length-scale 传过来（因为它要把
    #    主人写的限制文件和 asmr 偏移一起算好）。如果 helper 拿到显式值之后**又**乘一次
    #    asmr 的 1.18，结果就是"asmr 慢得离谱"（1.18 × 1.18 ≈ 1.4）。
    #    所以规矩是：**显式给了就用给的，没给才用风格的默认值**（不是"风格的默认值打底再乘显式值"）。
    if args.style == "asmr":
        style_length_scale, style_volume, style_gap = 1.18, -25.0, 450
    else:
        style_length_scale, style_volume, style_gap = 1.0, 0.0, 180

    base_length_scale = args.length_scale if args.length_scale > 0 else style_length_scale
    rate_percent = parse_percent(args.rate, 0.0)
    if str(args.volume).strip():
        volume_percent = parse_percent(args.volume, 0.0)
    else:
        volume_percent = style_volume
    gap_ms = args.gap_ms if args.gap_ms >= 0 else style_gap

    # length_scale：>1 更慢。rate 叠在 length_scale 上：
    # rate = +20% 想让语速快 20% → length_scale 除以 1.2。
    speed_factor = 1.0 + rate_percent / 100.0
    if speed_factor <= 0.1:
        speed_factor = 0.1
    length_scale = base_length_scale / speed_factor

    plan = [{"lang": seg["lang"], "text": seg["text"]} for seg in segments]

    if args.plan_only:
        emit({"ok": True, "engine": "piper", "plan": plan, "gap_ms": gap_ms,
              "length_scale": round(length_scale, 4), "volume_percent": volume_percent})
        return

    if not args.out.strip():
        fail("必须给 --out（输出的 wav 路径）")
    out_path = os.path.abspath(args.out)

    # ── 选模型 ────────────────────────────────────────────────────────────────
    model_zh, note_zh = pick_model(args.model_zh, found["zh"], models_dir, "zh")
    model_en, note_en = pick_model(args.model_en, found["en"], models_dir, "en")
    notes = [n for n in (note_zh, note_en) if n]

    needs_zh = any(seg["lang"] == "zh" for seg in segments)
    needs_en = any(seg["lang"] == "en" for seg in segments)

    if needs_zh and not model_zh:
        fail(
            f"缺中文模型：{note_zh}。把 {DEFAULT_MODEL_ZH}.onnx 和 "
            f"{DEFAULT_MODEL_ZH}.onnx.json 放进 {models_dir}（下载见 info\\tts\\README-piper.md）。",
            need="zh_model", models_dir=models_dir,
        )
    if needs_en and not model_en:
        # 英文没模型不算致命：回退到中文模型（espeak 有拉丁回退，能出声但口音怪）
        model_en = model_zh
        notes.append(
            f"缺英文模型（{note_en}），这段英文会用中文模型念 —— 口音会怪。"
            f"把 {DEFAULT_MODEL_EN}.onnx + .onnx.json 放进 {models_dir} 就能修好。"
        )

    used_models = []
    for seg in plan:
        seg["model"] = os.path.basename(model_zh if seg["lang"] == "zh" else model_en)
        if seg["model"] not in used_models:
            used_models.append(seg["model"])

    # pinyin 类模型要用 g2pW/transformers → 先决定"要不要强制 HF 离线"（详见函数注释）
    notes.extend(prepare_offline_for_pinyin([model_zh, model_en]))

    # ── 缓存（键里**必须**带 engine 名 + 模型文件名和大小，否则会读到 edge 的旧音频）──
    def model_sig(path: str) -> str:
        try:
            return f"{os.path.basename(path)}:{os.path.getsize(path)}"
        except OSError:
            return os.path.basename(path)

    key = hashlib.sha1(json.dumps({
        # ⚠️ engine 名进缓存键（要求里的硬约束）：edge 的缓存是"微软在线音色念的"，
        #    piper 的是"本地模型念的"，键里没有 engine 就会读到对方的声音。
        "engine": "piper",
        # ⚠️ 再带一个**缓存格式版本**：以后我改了后处理（比如这次把响度从峰值归一化
        #    改成 RMS 校准），只要把这个数字 +1，旧缓存就自动全部失效。
        #    不带它的话，主人会"改了代码却还是旧声音"，而且怎么查都查不出来。
        "fmt": CACHE_FORMAT_VERSION,
        "text": text,
        "models": [model_sig(model_zh or ""), model_sig(model_en or "")],
        "length_scale": round(length_scale, 4),
        "gap_ms": gap_ms,
        "volume_percent": volume_percent,
        "style": args.style,
    }, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    cache_path = os.path.join(args.cache_dir, f"{key}.wav") if args.cache_dir else ""
    if cache_path and not args.no_cache and os.path.exists(cache_path) and os.path.getsize(cache_path) > 44:
        out_dir = os.path.dirname(out_path)
        if out_dir and not os.path.isdir(out_dir):
            os.makedirs(out_dir, exist_ok=True)
        if os.path.abspath(cache_path) != out_path:
            with open(cache_path, "rb") as src, open(out_path, "wb") as dst:
                dst.write(src.read())
        info = wav_info(out_path)
        emit({"ok": True, "engine": "piper", "wav": out_path, "voice": "+".join(used_models),
              "from_cache": True, "segments": plan, "gap_ms": gap_ms,
              "length_scale": round(length_scale, 4), "notes": notes,
              "bytes": os.path.getsize(out_path), **info})
        return

    # ── 加载 piper ────────────────────────────────────────────────────────────
    try:
        from piper import PiperVoice, SynthesisConfig
    except ImportError:
        fail("没装 piper-tts。装它：python -m pip install piper-tts")
    try:
        import numpy as np
    except ImportError:
        fail("没装 numpy：python -m pip install numpy")

    voices: dict[str, object] = {}
    load_seconds = {}
    # ⚠️ 只加载**这一段真正用到**的模型：两个模型各要 1~1.5 秒，纯中文句子不该为英文模型付钱。
    needed = []
    for seg in plan:
        path = model_zh if seg["lang"] == "zh" else model_en
        if path and path not in needed:
            needed.append(path)
    try:
        for path in needed:
            started = time.time()
            voices[path] = PiperVoice.load(
                path, download_dir=args.download_dir.strip() or os.path.dirname(path)
            )
            load_seconds[os.path.basename(path)] = round(time.time() - started, 2)
    except Exception as exc:
        fail(f"加载 piper 模型失败：{type(exc).__name__}: {exc}",
             models_dir=models_dir, model_zh=model_zh, model_en=model_en)

    syn_config = SynthesisConfig(
        length_scale=length_scale,
        volume=1.0,          # 音量我自己统一乘（见下），这里保持 1.0
        normalize_audio=True,  # 每句归一化 → 各句响度一致，不会"这句特别小声"
    )

    # ── 逐段合成 ──────────────────────────────────────────────────────────────
    pieces: list[object] = []
    used_rate = 0
    synth_seconds = 0.0
    skipped = 0
    try:
        for index, seg in enumerate(plan):
            path = model_zh if seg["lang"] == "zh" else model_en
            voice = voices.get(path)
            if voice is None:
                fail(f"第 {index + 1} 段的模型没加载成功：{os.path.basename(path)}")
            started = time.time()
            parts = []
            for chunk in voice.synthesize(seg["text"], syn_config=syn_config):
                parts.append(chunk.audio_float_array)
                if not used_rate:
                    used_rate = chunk.sample_rate
            synth_seconds += time.time() - started
            if not parts:
                # ⚠️ 实测踩到的坑（拿真实的「今日提醒.md」跑出来的）：
                #    markdown 转纯文本之后会留下「、…」这种**只有标点**的片段，
                #    piper 对它 phomemize 出空结果 → 不产音频。
                #    一开始这里是直接 fail()，结果整篇退回系统音（主人一听就是机器音）。
                #    正确做法：**跳过这一段**接着念后面的，而不是整篇放弃。
                skipped += 1
                seg["skipped"] = True
                seg["seconds"] = 0.0
                continue
            audio = parts[0] if len(parts) == 1 else np.concatenate(parts)
            # 段内各句的采样率由同一个模型决定，这里只做一次防御性检查
            if used_rate and int(voice.config.sample_rate) != used_rate:
                audio = resample(audio.astype(np.float32), int(voice.config.sample_rate), used_rate)
            pieces.append(audio.astype(np.float32))
            seg["seconds"] = round(len(audio) / float(used_rate or voice.config.sample_rate), 2)
    except SystemExit:
        raise
    except Exception as exc:
        fail(f"piper 合成失败：{type(exc).__name__}: {exc}")

    if skipped:
        notes.append(f"跳过 {skipped} 段只有标点、念不出来的内容（不影响别的句子）")
    if not pieces or not used_rate:
        fail("一段音频都没生成出来（整段文字里没有能念的内容？）")

    # 采样率不一致（中英两个模型采样率不同）→ 统一重采样到 24000
    rates = {int(voices[(model_zh if seg["lang"] == "zh" else model_en)].config.sample_rate) for seg in plan}
    target_rate = used_rate
    if len(rates) > 1:
        target_rate = 24000
        pieces = [resample(p, used_rate, target_rate) for p in pieces]

    gap = np.zeros(max(0, int(target_rate * (gap_ms / 1000.0))), dtype=np.float32)
    chunks = []
    for index, piece in enumerate(pieces):
        if index > 0 and gap.size:
            chunks.append(gap)
        chunks.append(piece)
    merged = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]

    # ── 音量校准（v3 实测踩到的坑，别删）──────────────────────────────────────
    #
    # piper 自己会把**每句**都归一化到峰值 1.0（normalize_audio=True），拼起来就整体偏响：
    #   实测同一句话 edge rms 0.077 / peak 0.45，piper rms 0.204 / peak 1.000（**响 2.7 倍**）。
    # 更糟的是浮窗的口型同步 `Get-WavEnvelope` 把 `60ms 窗 rms × 4` 截到 1.0：
    #   edge 那版**一个点都没顶满**（max 0.68），piper 原样输出有 **21.9% 的点顶满**
    #   → 嘴会一直张到最大。所以这里必须把响度压回 edge 的水平，而不是"响就响吧"。
    #
    # 做法：按 **RMS** 校准到一个目标值（默认 0.08，就是 edge 的实测水平），
    # 再给峰值留 ceiling（0.95）防止个别爆音削波。
    target_rms = TARGET_RMS * (1.0 + volume_percent / 100.0)
    if target_rms < 0.005:
        target_rms = 0.005
    if merged.size:
        rms_now = float(np.sqrt(np.mean(merged ** 2)))
        peak_now = float(np.max(np.abs(merged)))
        if rms_now > 1e-6 and peak_now > 1e-6:
            gain = target_rms / rms_now
            if peak_now * gain > PEAK_CEILING:
                gain = PEAK_CEILING / peak_now
            merged = merged * gain

    try:
        write_wav(out_path, merged, target_rate)
    except Exception as exc:
        fail(f"写 wav 失败：{type(exc).__name__}: {exc}")

    cached = False
    if cache_path:
        try:
            os.makedirs(args.cache_dir, exist_ok=True)
            with open(out_path, "rb") as src, open(cache_path, "wb") as dst:
                dst.write(src.read())
            cached = True
        except OSError:
            cached = False

    info = wav_info(out_path)
    emit({
        "ok": True, "engine": "piper", "wav": out_path,
        "voice": "+".join(used_models),
        "from_cache": False, "cache_written": cached,
        "segments": plan, "gap_ms": gap_ms,
        "length_scale": round(length_scale, 4),
        "volume_percent": volume_percent,
        "style": args.style,
        "model_load_seconds": load_seconds,
        "synth_seconds": round(synth_seconds, 2),
        "notes": notes,
        "bytes": os.path.getsize(out_path),
        **info,
    })


if __name__ == "__main__":
    main()
