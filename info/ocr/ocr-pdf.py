#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
info\\ocr\\ocr-pdf.py —— 扫描版 PDF 的本地 OCR（2026-10-25 第 5 项"试水"）

为什么要有它：`info\\materials` 的索引用的是 PyMuPDF 的 get_text()，
扫描版 PDF（整页是图）一个字都提不出来 —— 实测有 8 个（都在 AP-CalculusBC，多是 Answer Key）。

做法（**只用系统自带能力，不装任何第三方二进制**）：
  PyMuPDF 把每页渲染成图 → Windows 自带的 OCR 引擎（Windows.Media.Ocr，中文包已随系统装）
  → 拼成文字 → 写一份 `<原名>.ocr.html`（HTML 在索引里是被支持的，所以能进课件库）。

用法：
  info\\ocr\\.venv\\Scripts\\python.exe info\\ocr\\ocr-pdf.py "<pdf 路径>" [--pages 3] [--lang en]
  加 --write 才会真的写 .ocr.html；不加只把文字打到屏幕上（试水默认不落盘）。
"""

import argparse
import asyncio
import os
import sys

import pymupdf


async def ocr_png(png_bytes, lang="en"):
    """一页 PNG（bytes）→ 文字。用 Windows 自带的 OCR。"""
    from winsdk.windows.graphics.imaging import BitmapDecoder
    from winsdk.windows.media.ocr import OcrEngine
    from winsdk.windows.storage.streams import DataWriter, InMemoryRandomAccessStream
    from winsdk.windows.globalization import Language

    stream = InMemoryRandomAccessStream()
    writer = DataWriter(stream.get_output_stream_at(0))
    writer.write_bytes(png_bytes)
    await writer.store_async()
    await writer.flush_async()
    stream.seek(0)

    decoder = await BitmapDecoder.create_async(stream)
    bitmap = await decoder.get_software_bitmap_async()

    engine = None
    try:
        engine = OcrEngine.try_create_from_language(Language(lang))
    except Exception:
        engine = None
    if engine is None:
        engine = OcrEngine.try_create_from_user_profile_languages()
    if engine is None:
        raise RuntimeError("这台机器上没有可用的 OCR 语言包")

    result = await engine.recognize_async(bitmap)
    return "\n".join(line.text for line in result.lines)


def render_pages(pdf_path, max_pages):
    doc = pymupdf.open(pdf_path)
    out = []
    for i in range(min(max_pages, doc.page_count)):
        page = doc[i]
        pix = page.get_pixmap(dpi=200)
        out.append((i + 1, pix.tobytes("png")))
    total = doc.page_count
    doc.close()
    return out, total


def escape_html(text):
    return (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    )


def main():
    # Windows 控制台默认 GBK：OCR 出的数学符号（¯ × ≥ 之类）一打印就 UnicodeEncodeError。
    # 这一步只影响"打印"，不影响写文件 —— 但会让脚本以非 0 退出，所以先兜住。
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--pages", type=int, default=3)
    ap.add_argument("--lang", default="en")
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    if not os.path.isfile(args.pdf):
        print("找不到文件：" + args.pdf, file=sys.stderr)
        return 2

    pages, total = render_pages(args.pdf, args.pages)
    chunks = []
    for num, png in pages:
        try:
            text = asyncio.run(ocr_png(png, args.lang))
        except Exception as exc:  # noqa: BLE001
            print(f"[第 {num} 页] OCR 失败：{type(exc).__name__}: {exc}", file=sys.stderr)
            text = ""
        chunks.append((num, text))
        print(f"--- 第 {num} 页（{len(text)} 字）---")
        print(text[:600])
        print()

    if args.write:
        out_path = args.pdf + ".ocr.html"
        body = []
        body.append('<!doctype html><meta charset="utf-8">')
        body.append("<h1>" + escape_html(os.path.basename(args.pdf)) + "（OCR）</h1>")
        body.append(
            "<p>由 info\\ocr\\ocr-pdf.py 于本地 OCR 生成；只 OCR 了前 %d 页（共 %d 页）。</p>"
            % (len(chunks), total)
        )
        for num, text in chunks:
            body.append(f"<h2>第 {num} 页</h2>")
            body.append("<pre>" + escape_html(text) + "</pre>")
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(body))
        print("已写：" + out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
