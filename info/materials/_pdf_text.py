#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
info/materials/_pdf_text.py —— 从 PDF 抽文字（给 index-files.mjs 当子进程用）

为什么还是 Python：PDF 没有零依赖方案；本机若不装 PyMuPDF 就明确报不可用，
由调用方记 warning 并跳过 pdf（绝不静默产出空文本）。

约定：
  调用：python _pdf_text.py <某个 .pdf 的绝对路径>
  输出：stdout 一行 JSON —— 成功 {"ok": true, "pages": [{"page": 1, "text": "..."}]}
                         失败 {"ok": false, "error": "人话原因"}
  退出码恒为 0（失败也写 JSON，便于调用方统一处理）；
  只有解释器本身起不来才是非 0（由调用方识别为“PyMuPDF 不可用”）。
"""

import json
import sys


def emit(payload):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) < 2:
        emit({"ok": False, "error": "用法：python _pdf_text.py <文件路径>"})
        return

    path = sys.argv[1]

    try:
        import fitz  # PyMuPDF
    except Exception as exc:  # noqa: BLE001 —— 缺包就是缺包，原样报
        emit({"ok": False, "error": f"PyMuPDF 不可用（{type(exc).__name__}）", "code": "fitz_missing"})
        return

    try:
        doc = fitz.open(path)
    except Exception as exc:  # noqa: BLE001
        message = str(exc).strip() or type(exc).__name__
        emit({"ok": False, "error": f"打不开 PDF：{message}", "code": "open_failed"})
        return

    try:
        if getattr(doc, "needs_pass", False):
            emit({"ok": False, "error": "PDF 有密码保护（加密），无法抽取", "code": "encrypted"})
            return

        pages = []
        for index in range(len(doc)):
            page = doc.load_page(index)
            text = page.get_text() or ""
            text = text.strip()
            if text:
                pages.append({"page": index + 1, "text": text})

        if not pages:
            emit({"ok": False, "error": "PDF 里没有可抽取的文字（可能是扫描图片版）", "code": "empty"})
            return

        emit({"ok": True, "pages": pages})
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "error": f"抽取过程出错：{exc}", "code": "extract_failed"})
    finally:
        try:
            doc.close()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    main()
