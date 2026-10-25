#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
info/materials/_chroma_query.py —— chroma 检索（可选路径，本卡默认用 bm25）

只有 `query.mjs --engine chroma` 且探测到 chromadb 时才会走到这里。
没有建过 chroma 库时明确报“库里没有资料”，不偷偷换成 bm25。

调用：python _chroma_query.py <chroma目录> <问题> <k>
输出：stdout 一行 JSON —— {"ok": true, "hits": [{source, page, score, text}]}
                      或 {"ok": false, "error": "..."}
"""

import json
import sys


def emit(payload):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) < 4:
        emit({"ok": False, "error": "用法：python _chroma_query.py <chroma目录> <问题> <k>"})
        return

    chroma_dir, question, k_text = sys.argv[1], sys.argv[2], sys.argv[3]
    try:
        k = int(k_text)
    except ValueError:
        k = 5

    try:
        import chromadb
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "error": f"chromadb 不可用（{type(exc).__name__}）", "code": "chroma_missing"})
        return

    try:
        client = chromadb.PersistentClient(path=chroma_dir)
        collection = client.get_collection("materials")
    except Exception as exc:  # noqa: BLE001
        emit(
            {
                "ok": False,
                "error": f"chroma 库里还没有资料（本卡只建了 bm25 索引）：{exc}",
                "code": "chroma_empty",
            }
        )
        return

    try:
        result = collection.query(query_texts=[question], n_results=max(1, min(k, 50)))
        docs = (result.get("documents") or [[]])[0]
        metas = (result.get("metadatas") or [[]])[0]
        distances = (result.get("distances") or [[]])[0]
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "error": f"chroma 查询失败：{exc}", "code": "chroma_query_failed"})
        return

    hits = []
    for index, doc in enumerate(docs):
        meta = metas[index] if index < len(metas) and metas[index] else {}
        distance = distances[index] if index < len(distances) else 1.0
        hits.append(
            {
                "source": meta.get("source", ""),
                "page": meta.get("page", meta.get("slide")),
                "score": round(1.0 / (1.0 + float(distance)), 4),
                "text": doc,
            }
        )
    emit({"ok": True, "hits": hits})


if __name__ == "__main__":
    main()
