---
title: 示例项目 · 模块 UX 契约
version: v1
date: 2026-09-08
author: 迷糊老师（office-lab QA）
status: 生效中
tags: [示例项目, ux-contract, 静态检查]
---

# 示例项目 · 模块 UX 契约

> **这份文件存在的理由**（老板 2026-09-08 原话）：「示例项目里面 upload 是支持粘贴的，ggbond 新开发的页面一定不会注意到这个特性，还有 modal 快捷键提交功能，ggbond 也不会注意到，这些都属于示例项目模块沉淀下来的 ux 准则」。
>
> 他说对了根因：**这些约定此前只存在于老代码里，仓库中没有任何一处写着它们**。GG Bond 注意不到不是不细心——他没有可读的地方去读。这份文件 + `ux_contract_check` 工具就是那个「可读的地方」。

## 为什么必须是静态检查（两条路都试过）

| 路径 | 结论 |
|------|------|
| 视觉验收三层（模块 token 基线 / 量化指标 / 审美 rubric） | **采不到**。`onPaste`、`useCommandEnterSubmit` 是 React handler，不在 computed style、不在 DOM 属性、不在截图里 |
| 猪猪行为用例 | **跑不了**。当前 19 个 step type 里没有 `press` / `keyboard` / `paste` / `hover`——组合键按不下去、剪贴板塞不进去（已开需求单） |
| **源码静态扫描** | ✅ 全覆盖（16 个 Upload 一个不漏，E2E 不可能每个都跑）、便宜、且能**左移到 GG Bond 交接前**——他改完当场知道漏了什么，不必等到 QA |

## 判据口径

- **数出来的多数，不是谁拍的规矩**：每条契约都报「模块里 N/M 这么做了」。
- **采纳率只按 `pages/sampling*` 算**。全站 `components/` 单列——那些组件别的模块也在用，示例项目的约定管不到。（首次真扫就踩到：Modal 快捷键混算 53%「候选」，只看模块内是 79%「约定」——**混算会把真约定误判成候选，等于放过**。）
- **等级决定语气**：约定级（≥60%）→ ⚠ 该补；候选级（30~60%）→ · 提醒；零星 → 不判。
- **申诉只记录、不豁免**：确有正当例外，在源码里写 `// ux-contract-ack: <契约key> <理由>`，检查器会如实列成「已申诉」，但**采纳率照旧算它没守**（同 lintAck 的精神）。
- **边界**：检测是**源码正则不是 AST**，可能误报（注释里的用法）、可能漏报（换了别名的导入）。每条命中都带证据行，请一眼核。

## 怎么用

- **GG Bond 交接前**：`ux_contract_check({ files: [本次改动的前端文件] })` —— 只判你改的文件，存量欠账不连坐。
- **迷糊验收时**：同一个工具复核一遍；漏的是约定级就该打回。
- **盘点全模块**：`ux_contract_check({})` 不传 files，即本文件下面这份。

---

### 示例项目 · 模块 UX 契约盘点

扫描 153 个源文件（其中 82 个属示例项目页面）。**采纳率是数出来的**：约定级（≥60%）才用来判新代码；候选级先统一存量再当契约。

> 采纳率**只按 `pages/sampling*` 算**：全站 `components/` 里的同类元素单列，它们被别的模块也在用，**示例项目的约定管不到**。（把两者混算会把真约定误判成候选——首次真扫时就踩到：Modal 快捷键混算 53%「候选」，只看模块内则是 79%「约定」。）

| 契约 | 模块内适用 | 已守 | 采纳率 | 等级 | 共享实现 |
|------|-----------|------|--------|------|----------|
| Upload 支持粘贴上传 | 16 | 12 | **75%** | 约定 | `hooks/useClipboardImages.ts · components/PasteImages/` |
| Modal 支持 ⌘/Ctrl+Enter 提交 | 39 | 31 | **79%** | 约定 | `pages/samplingWorkflow/components/modalShortcut.tsx → useCommandEnterSubmit` |
| 绑了快捷键就要在确认按钮上显示提示 | 32 | 30 | **94%** | 约定 | `modalShortcut.tsx → renderModalOkText / renderModalShortcutText` |
| 页面入口使用统一面包屑头 | 18 | 17 | **94%** | 约定 | `components/BreadcrumbHeader` |

#### 存量欠账 · Upload 支持粘贴上传（模块内 4 处）
> 示例项目里图片素材大多来自截图/聊天窗，粘贴是主路径；只能点选择文件的上传区，用起来会明显比隔壁难用
- `pages/samplingMaterialDemandBoard/index.tsx`
- `pages/samplingTechSheetCreate/index.tsx`
- `pages/samplingCostOrder/components/CostOrderModal.tsx`（L2006）
- `pages/samplingWorkflow/components/PaperFileModal.tsx`
> 另有 **2/2** 个全站共享组件也没这么做（不进上面的采纳率）：`components/PicturesGrid/index.tsx`、`components/UploadFiles/index.tsx` —— **要不要给共享组件立同样的约定，是跨模块的事，得更高层拍。**

#### 存量欠账 · Modal 支持 ⌘/Ctrl+Enter 提交（模块内 8 处）
> 模块里过半弹窗都能键盘提交；新弹窗不支持时，习惯了快捷键的人会以为「没反应」
- `pages/samplingCostOrder/ReconcileModal.tsx`
- `pages/samplingCjSpuBoard/components/CjSpuDetailModal.tsx`
- `pages/samplingCostOrder/components/CostOrderConfigModal.tsx`
- `pages/samplingPatternNotifySendRecord/components/PushConfigModal.tsx`
- `pages/samplingWorkflow/components/AppendMaterialModal.tsx`
- `pages/samplingWorkflow/components/LogModal.tsx`
- `pages/samplingWorkflow/components/PatternRejectDetailModal.tsx`
- `pages/samplingWorkflow/components/TaskDetailModal.tsx`
> 另有 **20/20** 个全站共享组件也没这么做（不进上面的采纳率）：`components/AppointedProcessor/index.tsx`、`components/BatchSearch/batchSearch.tsx`、`components/Editor/SelectProduct.tsx`、`components/ImageOptimize/index.tsx`、`components/ImageOptimize/OptimizeResultModal.tsx`、`components/ImageOptimize/Progress.tsx` … —— **要不要给共享组件立同样的约定，是跨模块的事，得更高层拍。**

#### 存量欠账 · 绑了快捷键就要在确认按钮上显示提示（模块内 2 处）
> 快捷键不可见等于不存在——绑了却不提示，只有知道的人用得上；这条与上一条是配套的
- `pages/samplingCostOrder/components/CostOrderModal.tsx`（L56）
- `pages/samplingWorkflow/components/MaterialSelectDrawer.tsx`（L25）

#### 存量欠账 · 页面入口使用统一面包屑头（模块内 1 处）
> 模块内页面头部结构一致，是「像不像一家人」最先被看到的一层
- `pages/samplingWorkflowQuickCreate/index.tsx`

> 检测是**源码正则不是 AST**：可能把注释里的用法算进去、也可能漏掉换了别名的导入。每条都给了证据行，请一眼核。确有正当例外就在源码里写 `// ux-contract-ack: <契约key> <理由>` —— **它只记录、不改采纳率**（申诉不等于豁免）。

### 候选契约（被多个模块文件共用，尚未立成契约）

共 153 个文件里，这些共享实现被反复使用——**用得多说明是沉淀，值得考虑立成契约**：

| 共享实现 | 被多少个文件用 | 已是契约 |
|----------|----------------|----------|
| `@/components/BreadcrumbHeader` | 16 | 是 |
| `@/components/QueryPlaceholder` | 15 | 否 |
| `@/components/CopySpan` | 11 | 否 |

> 之所以只列不判：这些的「该不该用」判据不可靠（没法只看源码就说清"这个文件本来就该用它"）。**宁可少一条契约，不要多一条会误伤的规矩**——要立哪条由老板拍，拍了我再补 applies 判据。
