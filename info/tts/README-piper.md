# 本地语音合成（piper）—— 安装、模型、以及怎么改

> 相关文件（都在这个 `info\tts\` 里）
> - `piper_say.py` —— 本地引擎的 helper（和 `edge_say.py` 接口契约一模一样）
> - `edge_say.py` —— 原来的在线引擎（保留，随时可切回去）
> - `..\speak.ps1` —— 上层入口，`engine = piper | edge | system`

---

## 1. 一句话结论

`engine = piper` 时用的是 **piper-tts 1.8.0 + onnxruntime，纯 CPU、完全离线**。
中文音色 `zh_CN-huayan-medium`（女声），英文音色 `en_US-amy-medium`（女声）。
中英混排时**自动按句子/按片段切开**：中文给中文模型、英文给英文模型，拼成一条 wav。

---

## 2. 装什么（只在换电脑 / 重装 Python 时需要）

```powershell
python -m pip install piper-tts
```

就够了。`piper-tts 1.8.0` 是**现成的 `win_amd64` wheel**（约 34 MB），
**自带 espeak-ng 数据**（`piper\espeak-ng-data\` + `espeakbridge.pyd`），
所以**不需要**另外装 `piper-phonemize` / `espeakng-loader` / `piper-tts-phonemize`。

装完之后**不需要联网也能用**（模型是本地文件）。

> 可选，只有想用 `zh_CN-xiao_ya-medium` 时才需要（见第 5 节）：
> ```powershell
> python -m pip install unicode_rbnf sentence_stream transformers
> ```

---

## 3. 模型放哪

放到 **`<项目根>\models\piper\`**，每个音色**两个文件**：

```
models\piper\
  zh_CN-huayan-medium.onnx        约 60.3 MB
  zh_CN-huayan-medium.onnx.json   约 4.8 KB   ← 少了这个就用不了
  en_US-amy-medium.onnx           约 60.3 MB
  en_US-amy-medium.onnx.json      约 4.9 KB
```

### 为什么要手动下

`huggingface.co` 在**这台机器上连不上**（实测 `WinError 10061` 连接被拒），
但镜像 **`hf-mirror.com` 通**。所以模型是手动从镜像下的，**别指望 piper 自己下**。

```powershell
$dest = '<项目根>\models\piper'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$base = 'https://hf-mirror.com/rhasspy/piper-voices/resolve/main'

# 中文（女声，**默认用它**）
Invoke-WebRequest "$base/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx"      -OutFile "$dest\zh_CN-huayan-medium.onnx"
Invoke-WebRequest "$base/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx.json" -OutFile "$dest\zh_CN-huayan-medium.onnx.json"

# 英文（女声，**默认用它**）
Invoke-WebRequest "$base/en/en_US/amy/medium/en_US-amy-medium.onnx"            -OutFile "$dest\en_US-amy-medium.onnx"
Invoke-WebRequest "$base/en/en_US/amy/medium/en_US-amy-medium.onnx.json"       -OutFile "$dest\en_US-amy-medium.onnx.json"
```

想看看这个仓库到底有哪些音色（联网）：

```powershell
python -m piper.download_voices
```

---

## 4. 怎么验证装好了

```powershell
# 列出本地真实存在的模型（不会联网）
python info\tts\piper_say.py --list

# 看它现在到底会用哪个模型、哪个语速
powershell -NoProfile -File info\speak.ps1 -ShowLimits

# 出一句话到 wav（不出声）
powershell -NoProfile -File info\speak.ps1 -Engine piper -NoPlay -Save "out\tts-test\x.wav" -Text "主人，我是AURORA。"
```

---

## 5. 换音色 / 已知的坑

### 换音色

把新的 `.onnx` + `.onnx.json` 放进 `models\piper\`，然后改限制文件
（`她的限制-说话.txt`）里的：

```
piper_zh_model = zh_CN-xxx-medium.onnx
piper_en_model = en_US-xxx-medium.onnx
```

留空 = 自动挑（中文优先 `huayan`，英文优先 `amy`）。
`-ShowLimits` 的 `piper_zh_model` 那行会打印**真正选中的文件**，所以"改了没生效"能立刻看出来。

### 坑 1：`zh_CN-xiao_ya-medium` 很慢

它也在这台机器上（`models\piper\zh_CN-xiao_ya-medium.onnx`），是 `phoneme_type = pinyin`
的模型（要跑 g2pW，一个 159 MB 的 BERT ONNX）。实测**同一句话**：

| | 合成耗时 | 音频时长 |
|---|---|---|
| `zh_CN-huayan-medium`（默认） | **0.22 秒** | 3.97 秒 |
| `zh_CN-xiao_ya-medium` | **4.59 秒**（慢 21 倍） | 5.47 秒 |

所以**默认不用它**。想听差别：`out\tts-samples\16-local-zh-xiaoya.wav`。

用它的额外要求：`pip install transformers`，并且需要 `bert-base-chinese` 的 tokenizer。
`piper_say.py` 已经会在**本地已有缓存**时自动切 `HF_HUB_OFFLINE=1`
（否则 transformers 每次都会去连不上的 huggingface.co，卡 5 次重试约 30 秒然后失败）。

### 坑 2：`g2pW` 数据目录

pinyin 类模型会去 `<download_dir>\g2pW\` 找 g2pW 数据（`g2pw.onnx` 等）。
`piper_say.py` 默认把 `download_dir` 设成**模型文件所在目录**，
所以 `models\piper\g2pW\` 会被自动找到。里面需要：

```
g2pw.onnx                                159 MB（从 hf-mirror 的 datasets/rhasspy/piper-checkpoints 下 zh_CN/_resources/g2pw.tar.gz 解出来）
config.py / version / MONOPHONIC_CHARS.txt / POLYPHONIC_CHARS.txt
bert-base-chinese_s2t_dict.txt
bopomofo_to_pinyin_wo_tune_dict.json
char_bopomofo_dict.json                  ← 后三个来自 pip 包 g2pw，pip download g2pw --no-deps 解出
```

**用默认的 huayan 时完全不需要这些。**

### 坑 3：响度

piper 自己会把每句归一化到峰值 1.0，拼起来比 edge **响 2.7 倍**
（edge rms 0.077 / peak 0.45，piper rms 0.204 / peak 1.000）。
更糟的是浮窗口型同步 `Get-WavEnvelope` 用 `60ms 窗 rms × 4` 再截到 1.0，
原样输出会有 **21.9% 的点顶满 → 嘴一直张到最大**。

所以 `piper_say.py` 按 **RMS 校准到 0.08**（就是 edge 的实测水平，`volume` 在这上面乘），
再留 0.95 的峰值天花板。校准后实测 piper rms 0.0800、顶满比例 0%，和 edge 一致
（拿真实的 58 秒「今日提醒.md」也验过：max 0.88、顶满 0.0%）。

### 坑 4：只有标点的片段会"念不出来"

拿真实的 `今日提醒.md` 跑才发现的：markdown 转纯文本会留下 `、…` 这种
**只有标点、没有字**的片段，piper 对它音素化是空结果、不产音频。
一开始代码在这里直接 `fail()` → **整篇退回系统音**（听起来就是机器音，但不报错，
很容易以为"换引擎成功了"）。

现在改成**跳过这一段接着念后面的**，并在输出里说一句
`⚠️ 跳过 N 段只有标点、念不出来的内容`。

### 坑 5：piper 不是确定性的（时长有抖动）

同一个模型、同样参数、同一句话，连跑 5 次音频时长在 **3.24 ~ 3.51 秒**之间跳（±8%）——
因为 VITS 的 `noise_scale` 是随机的。所以：

- **别用一句话比语速**，会被噪声骗（我一开始就差点得出"piper_speed 没用"的错误结论）。
- 要比就用长文本：实测 `length_scale` 0.8 / 1.0 / 1.3 → 11.1~11.6 / 12.8~13.0 / 14.1~14.4 秒，
  差异远大于抖动，**说明 `piper_speed` 是真的生效的**。

---

## 6. 实测数字（这台机器，2026-12）

| 场景 | piper（本地） | edge（在线） |
|---|---|---|
| 短句进程总耗时 | 1.65 ~ 1.74 秒 | 2.71 ~ 3.21 秒 |
| 长句（约 60 字）进程总耗时 | 3.20 ~ 3.43 秒 | 5.99 ~ 7.07 秒 |
| 缓存命中（同一句话第二次） | 1.15 秒 | 4.26 秒 |
| **纯合成耗时** | **0.10 ~ 0.74 秒** | 联网，不可控 |
| 需要联网 | 否 | 是 |

进程总耗时里有一大半是**固定开销**（Python 启动 + onnxruntime import + 模型加载约 1.1 秒），
所以短句看不出差距；纯合成那 0.1~0.7 秒才是 piper 的真实速度（14~18 倍实时）。

### 顺带发现：edge 在长内容上会失败

拿真实的 `今日提醒.md`（411 字、5 块）跑 edge，**第 3 块就挂了**：

```
⚠️ edge 引擎失败（edge-tts 生成失败（第 3 块，音色 zh-CN-XiaoyiNeural）：
   NoAudioReceived: No audio was received. Please verify that your parameters are correct.）
   → 退回系统发音人。
```

同一份内容 piper **5 块全部成功**（13.67 秒跑完约 60 秒的音频）。
这也是换本地引擎的一个实际理由：不只是快，还**不会因为在线服务抽风就变成机器音**。

---

## 7. 怎么切回去

改 `她的限制-说话.txt`：

```
engine = piper     # 本地（默认推荐）
engine = edge      # 在线，音质可能更好但要联网、慢
engine = system    # 系统发音人，机器音
```

改完立刻生效（下一次运行就读到）。`fallback_to_system = on` 时，
piper 缺模型/出错会自动退回系统音，**不会哑巴**。
