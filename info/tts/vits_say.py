#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
vits_say.py —— 本地 TTS **服务**（vits-simple-api）的 helper。

=============================================================================
 为什么要有它
=============================================================================
主人 2026-10-18 问：「我之前有试过 vits-simple-api，你认为好不好、要不要替换」

结论（写在 `README-vits.md` 里，这里只说接口）：
  · **音质**确实可能比 edge / piper 好（Bert-VITS2 / GPT-SoVITS 这类模型的自然度高得多）；
  · 但这台机器**没有 N 卡**（AMD 780M 核显，torch 检测不到 CUDA）→ 只能 CPU 推理，
    一句话大概 3~15 秒，比 edge 还慢；而且要先跑一个常驻的 Python 服务。
  · 所以：**接口接好、默认不用**。哪天主人真起了服务，改一行 `engine = vits` 就能用。

=============================================================================
 契约（和 edge_say.py / piper_say.py 完全一样）
=============================================================================
  · 吃：`--text-file`（UTF-8）或 `--text`；`--out` 一个 wav 路径
  · 吐：**一个 16 位 PCM 单声道 wav** + **最后一行 JSON**
  · 失败：打 `{"ok": false, "error": "..."}`，exit 非 0
  · 不联网到外网：只连 `--endpoint` 指定的本机服务

 用法：
   python vits_say.py --text-file=in.txt --out=out.wav
   python vits_say.py --text="你好" --out=out.wav --endpoint=http://127.0.0.1:23456 --model=bert-vits2 --speaker=0
   python vits_say.py --probe            # 只看服务通不通（不通就把原因说清楚）

 vits-simple-api 的接口（按它的文档，两种都试）：
   POST {endpoint}/voice        form: text, model_id, speaker, lang, length
   GET  {endpoint}/voice?text=...&model_id=...&speaker=...&lang=...
"""

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

DEFAULT_ENDPOINT = "http://127.0.0.1:23456"


def fail(msg, code=1):
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False), flush=True)
    raise SystemExit(code)


def post_form(url, fields, timeout):
    data = urllib.parse.urlencode(fields).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read(), resp.status, resp.headers.get("Content-Type", "")


def get_bytes(url, timeout):
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read(), resp.status, resp.headers.get("Content-Type", "")


def probe(endpoint, timeout=4):
    """服务通不通：先试 /docs，再试根路径 —— 两者都不通就明确报出来。"""
    for path in ("/docs", "/"):
        try:
            body, status, _ = get_bytes(endpoint.rstrip("/") + path, timeout)
            return {"ok": True, "path": path, "status": status, "bytes": len(body)}
        except Exception as exc:
            last = f"{type(exc).__name__}: {exc}"
    return {"ok": False, "error": last}


def normalize_wav(raw, out_path):
    """把服务返回的音频（wav/mp3/flac）写成一个 16 位 PCM 单声道 wav。"""
    try:
        import io

        import soundfile as sf
    except ImportError:
        fail("没装 soundfile：python -m pip install soundfile")

    try:
        data, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=False)
    except Exception as exc:
        fail(f"服务返回的音频解不开（{type(exc).__name__}: {exc}）—— 它真的返回音频了吗？前 60 字节：{raw[:60]!r}")
    if getattr(data, "ndim", 1) > 1:
        data = data.mean(axis=1)
    out_dir = os.path.dirname(os.path.abspath(out_path))
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)
    sf.write(out_path, data, sr, subtype="PCM_16", format="WAV")
    seconds = len(data) / float(sr)
    return seconds, sr


def main():
    ap = argparse.ArgumentParser(description="vits-simple-api → wav（16 位 PCM 单声道）")
    ap.add_argument("--text", default="", help="要念的文字")
    ap.add_argument("--text-file", default="", help="从 UTF-8 文件读要念的文字（推荐）")
    ap.add_argument("--out", default="", help="输出的 wav 路径")
    ap.add_argument("--endpoint", default=DEFAULT_ENDPOINT, help="vits-simple-api 的地址")
    ap.add_argument("--model", default="", help="model_id（服务里那份模型的标识，例如 bert-vits2）")
    ap.add_argument("--speaker", default="", help="说话人 id/名字")
    ap.add_argument("--lang", default="zh", help="语言（zh / ja / en / auto）")
    ap.add_argument("--length", type=float, default=1.0, help="语速（越大越慢）；没有就忽略")
    ap.add_argument("--timeout", type=float, default=60.0, help="单次请求超时（秒）")
    ap.add_argument("--cache-dir", default="", help="缓存目录（空 = 不缓存）")
    ap.add_argument("--no-cache", action="store_true", help="强制重新生成")
    ap.add_argument("--probe", action="store_true", help="只探测服务通不通")
    args = ap.parse_args()

    if args.probe:
        result = probe(args.endpoint)
        print(json.dumps(result, ensure_ascii=False))
        raise SystemExit(0 if result.get("ok") else 2)

    text = args.text
    if not text.strip() and args.text_file.strip():
        try:
            with open(args.text_file, "r", encoding="utf-8-sig") as handle:
                text = handle.read()
        except OSError as exc:
            fail(f"读不了 --text-file：{exc}")
    if not text.strip():
        fail("没给文字：用 --text 或 --text-file")
    if not args.out.strip():
        fail("没给 --out")

    endpoint = args.endpoint.rstrip("/")
    out_path = os.path.abspath(args.out)

    # ── 缓存（键里带 endpoint/模型/说话人/语速，换了任何一个都不会串） ──────────
    cache_path = ""
    if args.cache_dir and not args.no_cache:
        key = hashlib.sha1(
            json.dumps(
                {
                    "text": text,
                    "endpoint": endpoint,
                    "model": args.model,
                    "speaker": args.speaker,
                    "lang": args.lang,
                    "length": args.length,
                },
                ensure_ascii=False,
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()
        cache_path = os.path.join(args.cache_dir, f"vits-{key}.wav")
        if os.path.exists(cache_path) and os.path.getsize(cache_path) > 44:
            with open(cache_path, "rb") as src, open(out_path, "wb") as dst:
                dst.write(src.read())
            print(
                json.dumps(
                    {
                        "ok": True,
                        "wav": out_path,
                        "voice": f"vits:{args.model or '(默认)'}"
                        + (f"/{args.speaker}" if args.speaker else ""),
                        "from_cache": True,
                        "bytes": os.path.getsize(out_path),
                    },
                    ensure_ascii=False,
                )
            )
            return

    fields = {"text": text, "lang": args.lang, "length": str(args.length)}
    if args.model:
        fields["model_id"] = args.model
    if args.speaker:
        fields["speaker"] = args.speaker

    started = time.time()
    raw = b""
    used = ""
    errors = []

    # 1) POST /voice
    try:
        raw, status, ctype = post_form(endpoint + "/voice", fields, args.timeout)
        used = f"POST /voice ({status}, {ctype or '?'})"
    except Exception as exc:
        errors.append(f"POST /voice → {type(exc).__name__}: {exc}")
        raw = b""

    # 2) GET /voice?...
    if not raw:
        try:
            url = endpoint + "/voice?" + urllib.parse.urlencode(fields)
            raw, status, ctype = get_bytes(url, args.timeout)
            used = f"GET /voice ({status}, {ctype or '?'})"
        except Exception as exc:
            errors.append(f"GET /voice → {type(exc).__name__}: {exc}")
            raw = b""

    if not raw:
        probe_result = probe(endpoint)
        hint = (
            "服务没起来"
            if not probe_result.get("ok")
            else "服务起来了，但 /voice 这个接口没给出音频（版本/参数不对？）"
        )
        fail(f"vits-simple-api 没生成出音频（{hint}）。细节：" + "；".join(errors))

    seconds, sr = normalize_wav(raw, out_path)
    elapsed = time.time() - started

    cached = False
    if cache_path:
        try:
            os.makedirs(args.cache_dir, exist_ok=True)
            with open(out_path, "rb") as src, open(cache_path, "wb") as dst:
                dst.write(src.read())
            cached = True
        except OSError:
            cached = False

    print(
        json.dumps(
            {
                "ok": True,
                "wav": out_path,
                "voice": f"vits:{args.model or '(默认)'}" + (f"/{args.speaker}" if args.speaker else ""),
                "seconds": round(seconds, 2),
                "sample_rate": sr,
                "bytes": os.path.getsize(out_path),
                "synth_seconds": round(elapsed, 2),
                "request": used,
                "from_cache": False,
                "cache_written": cached,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
