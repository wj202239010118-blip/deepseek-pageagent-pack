---
name: markitdown
description: "使用 MarkItDown 将各种文档格式转换为 Markdown。阅读前调用此 skill，输出比原始格式更清晰、更利于 LLM 理解。"
argument-hint: "[convert|info] <file-path>"
user-invocable: true
allowed-tools: Read, Glob, Grep, Write, Bash, Python
---

# MarkItDown Skill

将文档转换为 Markdown 格式后再阅读。支持的格式：PDF、DOCX、PPTX、XLSX、图片（OCR）、HTML、CSV、JSON、XML、EPUB 等。

## 使用方法

```python
from markitdown import MarkItDown
md = MarkItDown()
result = md.convert("path/to/file")
print(result.text_content)
```

## CLI

```bash
markitdown path/to/file.pdf > output.md
```

## 集成到文档阅读流程

在读取文档时按以下步骤：

1. **检测文件扩展名**：如果是 PDF/DOCX/PPTX/XLSX/图片等非纯文本格式
2. **先用 MarkItDown 转换**：`python -c "from markitdown import MarkItDown; print(MarkItDown().convert('path').text_content)"`
3. **读取输出的 Markdown**：比原始格式更干净、结构更完整
4. **如果文件很大**：转换后写为临时 .md 文件再分段读取

## 重要提示

- 已安装 `markitdown[all]` 所有可选依赖
- 输出 markdown 后可用 `read_file` 读取
- 对于大文件建议先转存为 `.md` 再分段读取
- 支持 OCR（图片中文字提取）、音频转录（需要额外配置）
