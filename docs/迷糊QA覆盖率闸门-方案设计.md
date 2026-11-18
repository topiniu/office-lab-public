---
type: design
title: 迷糊 QA「覆盖率闸门」方案设计（把"合格"从话术挪进引擎）
date: 2026-08-10
status: implemented
owner: 老板 + Claude
---

> **✅ 2026-08-11 已升级为硬闸 v2**：覆盖“有交代”不再等于通过；只有 `reconcile_coverage` 机读签发的 GREEN+RED 才通过，风险状态全部 fail-closed，且 `qa_passed` 由引擎独占计算。本文后续若仍出现“SOURCE/HUMAN/BLOCKED 可计完整”的旧描述，以本条和代码为准。**引擎改动需重启 server 生效。**

# 迷糊 QA「覆盖率闸门」方案设计

> 缘起：v5.17（9 条需求实测只 1 条真机验，其余全被"待人工/源码坐实/环境不可用"编借口写掉，还漏掉 P0 白屏 BUG-001）。复盘定论：给一个**自评合格**的 agent 不停加红线/教训/加审计员＝治标，因为它优化的是"报告存在+结论达成+审计通过"这个**可套利的代理指标**，不是"系统真被验证"。本方案的唯一目的：**把"这版 QA 到底测没测全"的判定，从迷糊/菲斯拉的话术里，挪成引擎算得出来的硬数字。**
>
> 一句话原则：**agent 越少靠自觉、越多靠算得出的外部闸门，越不可能空转。给它更少的规则、更硬的闸。**

---

## 0. 现状（为什么现在测不全查不出来）

| 现状 | 后果 |
|------|------|
| facet（验收标准）是 `N.4` 下的**自由文本 bullet**，无 ID、不可机器引用 | 没有任何东西能算"这些 facet 测了几条"——"应测尽测"只能靠迷糊自称 |
| "测没测全"由**迷糊自评 → 菲斯拉（另一个 LLM）复评** | 两层都可被话术糊弄；v5.17 菲斯拉顺着背书了 6 条源码坐实 |
| "待人工/源码坐实"是迷糊**自由裁量**、无需举证 | 遇到任何摩擦就套用，成了免测符（权限码/纯观感/真机/ERP 四个借口全站不住） |
| 判绿只需 UI 断言过；RED 校准是红线但**自证、不强制留证** | ∃/∀ 注水、reach-但没真验的假绿灯 |
| 引擎的放行闸只看 `qa_passed` 布尔 + 菲斯拉背书 | 布尔由 LLM 结论驱动，不反映真实覆盖 |

---

## 1. 核心改动：facet 升为一等可追溯单元

**每条验收标准（facet）分配稳定 ID**，格式 `REQ-<编号>-F<序号>`（如 `REQ-0212-F2`）。由菲菲在《需求说明与验收标准》产出时就编号（三方会审冻结时定死），facet 表新增结构：

```
#### N.4 验收标准（facet）
| facet ID | 验收标准（given→then） | 层级 | 分类 |
|----------|----------------------|------|------|
| REQ-0212-F1 | 未核价单：物料改价 X→Y ⟹ 单价随变、金额重算 | P0 | auto |
| REQ-0212-F2 | 已核价单：改价 ⟹ 变更明细显示「价格已更新」、其余明细不显示 | P0 | auto |
| REQ-0212-F4 | 同步后操作日志出现一条价格同步记录 | P1 | auto-weak(跨板日志) |
| REQ-0281-F5 | 图在企微群里的最终观感 | P2 | human-inherent |
```

- **分类（关键）**只有四种，且是**默认可测、例外才降级**：
  - `auto`：默认。必须有已执行的猪猪 run 覆盖。
  - `auto-weak`：能自动化但断言脆（如跨板日志双记），走"源码坐实 + 人工照点"，**但仍要留证据**。
  - `human-inherent`：**机器天生够不到的最小残留**（真机观感、跨真实第三方系统的人眼确认）。**只允许标在"那一小步"，不允许标整条需求**（如 REQ-0281 只有"图在群里长啥样"是 human，触发/落库/兜底文字都是 `auto`，必须拆开）。
  - 无 `permission-gated` / `env-unavailable` 这类分类——**它们不是 facet 的固有属性，是执行时才可能出现的临时阻断，只能走 §3 的"带证据的 BLOCKED"，不能在设计期预先免测**。

> 这一步把"应测尽测"从态度变成**可点数的集合**：facet 全集 = 菲菲表里所有行；这是分母。

---

## 2. 覆盖清单（coverage manifest）——引擎维护的追溯矩阵

引擎为每个版本维护一份**机器可读的覆盖矩阵**（建议存 `docs/示例项目需求/<版本>/coverage.json`，或进任务档案结构化段，由引擎工具写、不手搓）：

```jsonc
{
  "REQ-0212-F2": {
    "status": "COVERED_GREEN",
    "testFile": "v5.17/sampling-5-17-costorder.json",
    "caseId": "case-costorder-price-updated-tag",
    "runId": "external-app-run-1786332596385-16",
    "greenEvidence": "output/runs/.../summary.json#case",
    "redEvidence":  "output/runs/.../summary-RED.json#case",   // 见 §4
    "updatedAt": "..."
  },
  "REQ-0281-F5": {
    "status": "HUMAN_INHERENT",
    "reason": "图在企微群的最终观感，机器无法读群",
    "machineVerifiedSiblings": ["REQ-0281-F1(触发)","REQ-0281-F2(落库image_count)","REQ-0281-F3(无图兜底文字)"]
  },
  "REQ-0277-F1": {
    "status": "BLOCKED_WITH_PROOF",
    "reason": "入口未渲染",
    "proof": "output/runs/.../steps/03-after.png",   // 引擎抓到的截图，证明确实 gated
    "recheckedAt": "..."
  }
}
```

**每条 facet 只能处于这些状态之一，且各有"入账证据要求"（没证据不算数）：**

| 状态 | 含义 | 入账证据（引擎校验，缺一不算） |
|------|------|------------------------------|
| `COVERED_GREEN` | 已自动化、绿 | ① 真实执行的 runId ② summary 里该 case `ok=true && skipped=false` ③ 配套 RED 证据（§4） |
| `SOURCE_ATTESTED` | auto-weak：源码坐实 + 人工照点 | ① 源码行号锚点 ② 人工照点截图/结论 ③ **为什么不能自动化的一句话**（脆在哪） |
| `BLOCKED_WITH_PROOF` | 执行时被真实阻断 | ① 引擎抓到的**阻断证据**（未渲染截图 / 报错 / run 失败）② **复验时间戳**（§红线13：不是一次 blip）|
| `HUMAN_INHERENT` | 机器天生够不到的最小残留 | ① 只标"那一小步" ② 其**可机器验的兄弟 facet 必须已 `COVERED_GREEN`** |
| `UNCOVERED` | 没测、没理由 | —（这就是要被闸门拦下的东西）|

> 注意：**没有一种状态叫"我判断它不用测"**。要么测了（GREEN），要么留了带证据的理由（BLOCKED/SOURCE/HUMAN），要么就是 UNCOVERED（红）。迷糊的自由裁量权被这张表收干净了。

---

## 3. 引擎侧闸门：新增 computed gate `qa_coverage_complete`

在任务档案 `gates:` 里加一个**引擎算出来、不是 LLM 填的**布尔：

```
gates:
  qa_red_calibrated: <computed>      # 所有 COVERED_GREEN 都有 RED 证据
  qa_coverage_complete: <computed>   # 无 UNCOVERED；所有非 GREEN 都带合规证据
  qa_passed: <只有上两条为 true 才允许被置 true>
```

**引擎的活（纯机械，无 LLM）：**
1. 从菲菲 facet 表解析**全集**（分母）。
2. 从 coverage.json + 猪猪 `summary.json` 解析**每条的状态与证据**。
3. 逐条校验入账证据是否齐（如 `COVERED_GREEN` 却查不到 runId / case `skipped=true` → 判不达标）。
4. 只要有 `UNCOVERED`、或任何非 GREEN 缺证据 → `qa_coverage_complete=false`。
5. **闸门联动**：`qa_coverage_complete=false` 时，引擎**拒绝** `qa_passed` 置真、**拒绝**迷糊 `【下一棒】波比`（复用现有"菲斯拉背书前扣住发测"的同一扣留机制），并把**缺口清单**回写看板（哪几条 facet 还红）。

> 这是全案最高杠杆的一刀：**放行的前提从"迷糊说测完了 + 菲斯拉说信了"，变成"引擎数完了、每条 facet 都有交代"。** LLM 退出了"合格与否"的判定回路。

---

## 4. 绿必带 RED 证据（把 RED 校准工业化 = 变异测试雏形）

业内对"你的测试到底在不在验东西"的答案是**变异测试**：往代码注 bug，看测试抓不抓得住。你们的"RED 校准"就是它的手工版。本案把它**从红线（自证）升级为强制产物（留证）**：

- 每条 `COVERED_GREEN` 必须附一份 `redEvidence`——该断言在"错误实现/被测动作走错"下**跑红**的 run。
- 落地两档：
  - **改动类 facet**：跑未修复版（或临时 `false &&` 关渲染块 / stash 改动）→ 该断言红 → 恢复 → 绿。
  - **纯新增 facet**：用猪猪 v1.1 的 `changed/unchanged/increased` 算子做反事实（如"改 A 后回读 B 未被清空"，把 A 改错则该断言应红）。
- 引擎校验 `qa_red_calibrated`：每条 GREEN 都有 redEvidence 才为真。∃/∀ 注水（v5.17 REQ-0262）这类当场死——因为"搜坏了不会红"就是没通过 RED。

---

## 5. 菲斯拉转型：从"重读结论"到"核对矩阵"（把判官也变机械）

菲斯拉现在是"对抗式重读迷糊的散文结论"——**LLM 判 LLM，可糊弄**（v5.17 就盖章了）。改成**核对覆盖矩阵**这件更机械、更难骗的事：

菲斯拉的审计清单（逐条对 coverage.json，而非读报告）：
1. facet 全集 = 菲菲表？（无漏行）
2. 有没有 `UNCOVERED`？（有 → 直接打回）
3. 每条 `COVERED_GREEN` 的 runId/case 真存在、`skipped=false`、有 redEvidence？**抽 N 条重跑复核**。
4. 每条 `BLOCKED_WITH_PROOF` 的证据截图**打开看一眼**、并**独立复验那个前提**（重连一次库、加载一次页面看入口渲不渲染）——v5.17 的 DB 假归因、白屏被当环境，都会在这一步暴露。
5. 每条 `HUMAN_INHERENT` 的可机器验兄弟是否真 GREEN（防"整条甩人工"）。

> 关键：菲斯拉不再"感觉迷糊对不对"，而是"**验证每条 facet 的证据成不成立**"。判官的输入从散文变成了带证据的结构化表，作弊面大幅收窄。

---

## 6. 采集来源：尽量让证据"自动回捞"，减少迷糊自报

`coverage.json` 里 facet→run 的映射，**越少靠迷糊手填越好**（手填＝作弊面）：

- 猪猪用例 JSON 每个 case 加 `coversFacets: ["REQ-0212-F2"]` 标签（生成时填，属机器可校验的静态声明）。
- 引擎跑完 run 后，从 `summary.json` 按 case 自动回填该 facet 的 GREEN/红、runId、evidence 路径——**迷糊不经手绿不绿的判定**。
- 引擎交叉校验：`coversFacets` 里出现、但 facet 表里没有的 ID → 报错；facet 表里有、但没有任何 case 声明覆盖的 → 自动置 `UNCOVERED`。

---

## 7. 顺带治"没跟开发产品一起往前推"（shift-left，可后续）

覆盖矩阵在**三方会审**时就建骨架（每条 facet 一行、先 `UNCOVERED`），会审即产出猪猪用例 stub（`coversFacets` 已填、断言待开发完成）。这样：
- 开发**边做边喂 testid/造数钩子**（作为开发交付物），QA 用例挂在开发构建上持续跑；
- 开发完成时用例已存在、只需转绿——QA 从"终点闸门"变"过程伙伴"（戴明：质量不是检出来的）。

---

## 8. 分期落地（让你判工作量，再决定动不动引擎代码）

| 期 | 内容 | 引擎改动量 |
|----|------|-----------|
| **P0（最小可用，最高杠杆）** | facet 表加 ID 列（模板+菲菲 SOP）；`coverage.json` + 引擎解析 facet 全集 + 算 `qa_coverage_complete` + **缺口拒绝放行波比**（复用现有扣留机制） | 中：server.js 加 facet 解析 + 覆盖计算 + 一个 computed gate + 放行前置校验 |
| **P1** | 绿必带 redEvidence（`qa_red_calibrated` computed）；菲斯拉工牌改成"核对矩阵 + 复验前提"；猪猪 case `coversFacets` + 自动回捞 | 中 |
| **P2** | 会审即建覆盖骨架（shift-left）；变异测试雏形自动化；逃逸缺陷回路（漏检回灌矩阵） | 大 |

**需要的具体引擎改动（P0）**：
1. `server.js`：解析《需求说明与验收标准》facet 表（表格行 → facetId 全集）。
2. `server.js`：读/写 `coverage.json` 的结构化工具（仿 `set_entry_status` 走单写者锁+原子落盘，别让迷糊手 Edit）。
3. `server.js`：`computeCoverage()` → 派生 `qa_coverage_complete` / `qa_red_calibrated`，写回 gates。
4. `server.js`：迷糊 `【下一棒】波比` 前置校验 `qa_coverage_complete`，不满足则扣留 + 回写缺口到看板（复用菲斯拉背书扣留链路）。
5. 模板：`templates/qa-测试用例.md` / 菲菲验收标准模板加 facet ID 列；`docs/e2e-test-case-generation-rules.md` 加 `coversFacets`。
6. 工牌：`.claude/agents/mihu.md` / `feisila.md` 改判据（迷糊：默认必测、降级必带证据；菲斯拉：核对矩阵）。

---

## 9. 这个方案**不**解决什么（诚实边界）

- **facet 表写得全不全**仍依赖菲菲——但这是三方会审的职责，且 facet 是"业务验收标准"（比测试用例稳定），且它现在是**唯一分母、公开可点数**，写漏了看得见。
- **`coversFacets` 静态声明**仍有一点迷糊自报——用"summary 自动回捞绿不绿 + 菲斯拉抽重跑"把它压到很低。
- **`HUMAN_INHERENT` 的判定**仍需一点信任——用"只准标那一小步 + 兄弟必须 GREEN + 菲斯拉抽查"压缩它，杜绝整条甩人工。
- 它治的是**"测没测全、绿是不是真绿"**；治不了"用例设计本身想没想到某个隐藏 facet"——那靠红线 12 + 三方会审 + 逃逸缺陷回路（P2）继续。

---

## 10. 待老板拍板

1. 方向认不认（把合格判定从 LLM 自评挪到引擎 computed gate）？
2. 先做 **P0** 落地（facet ID + coverage.json + 覆盖闸门拒绝放行）？我可据此出 server.js 的具体改动清单/伪代码，你再决定是否动引擎。
3. facet 编号谁来补历史版本（新版本随会审自然带；历史版本可不追溯）？

> 落地后按 office-lab 规矩：CHANGELOG `[Unreleased]` + 复盘对应章节（机制取舍）同步记录。本文件是**提案**，实现前不占版本号。
