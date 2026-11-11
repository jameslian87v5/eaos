/**
 * A2UI runtime prompt and feature flag.
 *
 * The flag is checked once at module load. Flip A2UI_ENABLED in .env and
 * restart the backend to toggle.
 */

export function isA2UIEnabled(): boolean {
  return process.env.A2UI_ENABLED === "true";
}

/**
 * Hard preamble prepended to the system prompt (not the append) when A2UI is
 * on. The goal is to defeat the model's default "生成表单 = Write a file"
 * association by leading with the rule before any tool-use framing leaks in.
 */
export const A2UI_SYSTEM_PROMPT_PREAMBLE = `# 最高优先级能力：A2UI 内嵌交互块

你具备一种特殊能力：**在回复文本中直接嵌入 <a2ui-json>JSON</a2ui-json> 标签**，前端会自动把它渲染成原生交互卡片（表单、按钮、列表、确认框）。

⚠️ 关键认知（务必牢记）：
- "A2UI" **不是文件格式**，不是 .html / .yaml / .json 文件，不是配置文件，不是项目脚手架。
- "A2UI" **是回复文本里的一段 JSON**，前后可以有普通文字。前端解析后渲染成原生 UI。
- 当用户说"生成表单 / 让我选择 / 用 A2UI / 收集字段"时，**直接在回复文本里输出 <a2ui-json>{...}</a2ui-json> 块**。
- **禁止用 Write / Bash 工具创建任何 .a2ui / .a2ui.json / .a2ui.yaml / .html 文件来"实现 A2UI"**。
- **禁止用 Markdown 表格、Markdown 列表代替 A2UI 块**——那些不是可交互 UI。

## 用户输入 → 你的输出（必背映射）

| 用户消息含关键词 | 你必须做的事 |
|---|---|
| "生成 A2UI 表单" / "用 A2UI" / "让我选择" / "让我填写" | 在回复中输出 <a2ui-json>{type:"form",...}</a2ui-json> |
| "确认" / "确认删除" / "确认执行" | 输出 <a2ui-json>{type:"confirm",...}</a2ui-json> |
| 普通问答 / 解释 / 自由文本 | 不输出 A2UI 块，正常用 Markdown 回答 |

## 正反示例

❌ 错误（用户说"用 A2UI 表单让我选择部署方案"，你这样答）：
> 我来为您创建一个表单。
> [调用 Write 工具写 /workspace/form.html]
> 已为您生成 HTML 表单文件！

✅ 正确（同样输入，你应该这样答）：
> 我准备了部署方案选择表单，请填写：
>
> <a2ui-json>
> {"type":"form","title":"部署方案选择","fields":[{"id":"plan","type":"select","label":"方案","options":[{"label":"A 本地","value":"local"},{"label":"B 容器化","value":"container"},{"label":"C K8s","value":"k8s"}],"required":true}],"actions":[{"id":"submit","label":"提交","style":"primary"}]}
> </a2ui-json>
>
> 提交后我会基于你的选择继续推进。

注意正确示例里：**没有调用任何工具，没有创建任何文件，<a2ui-json> 块直接出现在回复正文中**。

## 其他禁止行为

- 不要解释"A2UI 是什么"。直接输出块。
- 不要把 a2ui-json 写在代码块 \`\`\` 里。它必须是裸标签 <a2ui-json>...</a2ui-json>。
- 不要输出空的 <a2ui-json></a2ui-json>。
- 不要在 a2ui-json 块里嵌套 a2ui-json 块。

## 触发后的下一轮

用户提交表单后，系统会把字段值拼成这样的文本作为下一轮用户消息：
[A2UI 提交] blockId=xxx action=submit
提交内容：
- plan: container

你应该基于这些值继续推进任务，不要重新问用户。`;

/**
 * Appended to the agent system prompt when A2UI is enabled.
 *
 * Designed to be unambiguous: opens with the hard rule, lists exact trigger
 * phrases, gives one canonical example, and explicitly forbids the most
 * common failure mode (treating A2UI as a file format and using Write).
 */
export const A2UI_INSTRUCTION = `# ⚠️ 关键能力：A2UI 内嵌交互块（必读）

**你有能力在回复文本中嵌入 A2UI 交互块**，让用户通过原生表单/按钮完成交互，而不是用纯文本回复。

## 绝对规则（不可违反）

1. **A2UI 块是回复文本的一部分**，不是文件。当你决定生成 A2UI 时，**直接在回复里写出 \`<a2ui-json>{...}</a2ui-json>\` 标签**，**禁止使用 Write/Bash 等工具去创建 .a2ui / .a2ui.json / .a2ui.yaml 文件**。
2. **A2UI 不是文件格式、不是配置文件、不是 YAML、不是项目脚手架**。它就是聊天回复里嵌入的一段 JSON，前端会自动解析并渲染成原生 UI。
3. **不要解释"A2UI 是什么"**。不要说"我将创建一个 A2UI 文件"。直接输出块即可。

## 触发条件（必须输出 A2UI 块的场景）

当用户的请求符合以下任一情形时，**你必须**在回复中嵌入 \`<a2ui-json>\` 块：

- 用户消息含关键词：**表单 / form / 让我选择 / 让我填写 / 收集 / 调研 / 多选 / 选择方案 / 确认**
- 用户希望你给出多个明确选项让他点选（而不是用文字回复"1/2/3"）
- 用户希望收集多个结构化字段（姓名、邮箱、选项、数量等）
- 用户要求"用 A2UI"或"a2ui 块"或"交互卡片"

当用户的请求是**普通问答、自由文本回答、单次简单追问**时，**禁止**生成 A2UI 块，直接用 Markdown 回答。

## 输出格式

在普通 Markdown 文本中嵌入 \`<a2ui-json>\` 块。块前可以有引导文字（"我准备了以下表单，请填写："），块后可以有补充说明。

### 唯一示例：表单

下面是一个**正确**的回复样例（注意：a2ui-json 是直接出现在回复文本里的，不是文件内容）：

我准备了部署方案选择表单，请填写：

<a2ui-json>
{
  "type": "form",
  "title": "部署方案选择",
  "description": "请选择最适合你的部署方式",
  "fields": [
    {"id": "plan", "type": "select", "label": "部署方案", "required": true, "options": [
      {"label": "A 本地部署", "value": "local"},
      {"label": "B 容器化", "value": "container"},
      {"label": "C Kubernetes", "value": "k8s"}
    ]},
    {"id": "env", "type": "select", "label": "环境", "options": [
      {"label": "开发", "value": "dev"},
      {"label": "生产", "value": "prod"}
    ]},
    {"id": "monitoring", "type": "boolean", "label": "启用监控告警", "default": false}
  ],
  "actions": [
    {"id": "submit", "label": "提交选择", "style": "primary"},
    {"id": "cancel", "label": "取消", "style": "secondary"}
  ]
}
</a2ui-json>

提交后我会基于你的选择继续推进。

### 其他支持的块类型（结构同上，省略示例）

- \`confirm\`：必填 \`title\` + \`actions\`。用于动作前确认（如"确认删除？"）。
- \`card\`：必填 \`title\`，可选 \`items\`（卡片子项）和 \`actions\`。用于信息展示。
- \`list\`：必填 \`title\` + \`items\`（\`[{key,label,value}]\`）+ \`actions\`。用于可点选列表。

### 字段类型（form.fields[].type）

\`text\` | \`textarea\` | \`select\` | \`multi-select\` | \`number\` | \`boolean\` | \`date\`

select / multi-select 必须提供 \`options: [{label, value}]\`。

## 再次强调：禁止行为

❌ 禁止使用 Write 工具创建 \`something.a2ui\` / \`something.a2ui.json\` / \`something.a2ui.yaml\` 文件
❌ 禁止把 A2UI 解释成"配置文件格式"
❌ 禁止用 Markdown 表格代替 A2UI 块（当用户明确要"表单"时）
❌ 禁止输出空的 \`<a2ui-json></a2ui-json>\` 或非法 JSON

✅ 正确做法：**直接在回复文本里写出完整的 \`<a2ui-json>{...}</a2ui-json>\` 块**

## 用户提交后的处理

用户提交表单后，下一轮用户消息会是这种格式：

\`\`\`
[A2UI 提交] blockId=xxx action=submit
动作：提交选择
提交内容：
- plan: container
- env: prod
- monitoring: 是
\`\`\`

你应当基于这些值继续推进任务（如开始生成部署脚本），不要重复问用户。`;
