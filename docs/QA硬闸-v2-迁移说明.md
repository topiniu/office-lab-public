# QA 硬闸 v2 迁移说明

生效日期：2026-08-11。事故根因、权力模型与取舍详见[技术演进 §3.67](tech/QA门禁与角色演进.md)。

## 放行公式

```text
qa_passed =
  所有权威 facet 都是机器签发的 COVERED_GREEN
  AND 每条 GREEN 有机器签发的 RED 校准证据
  AND 用例 linter 无 error
  AND content case 的 Arrange→Act→Assert 指向同一实体
```

`qa_passed`、`qa_coverage_complete`、`qa_red_calibrated` 只由引擎计算。Agent 手写不会成为有效放行依据。

## 用例新增契约

content case 必须增加：

```json
{
  "coversFacets": ["REQ-0001-F1"],
  "qaTrace": {
    "arrange": { "provenance": "fixture:createQuickTask", "entityRef": "{{taskId}}" },
    "act": { "operationId": "ui.save", "entityRef": "{{taskId}}" },
    "assert": {
      "oracle": "savedValue.equals:expected",
      "entityRef": "{{taskId}}",
      "redCalibrationId": "fault:ignore-save"
    }
  }
}
```

`lintAck` 可以保留作申诉记录，但不会降低 finding 的严重级别。

## 运行与回捞

1. 正常实现跑 GREEN 目录，要求所有步骤实际执行、无 failed/skipped/stopped。
2. 故障注入或未修复实现跑 RED 目录；失败点必须是 assert/capture/expect，且 case 有 `redCalibrationId`。
3. 调用 `reconcile_coverage(runDir, testFile, redRunDir)`。
4. 调用 `coverage_status`，只有 `覆盖完整=true`、`RED完整=true`、`qa_passed=true` 才能交接。

机器证据绑定 `runId / case / testHash / summaryHash / Git commit / env / summary path`；复制旧 runId 或自由文本不再有效。

## 风险状态

- `SOURCE_ATTESTED`：实现审阅，不是 QA Pass。
- `BLOCKED_WITH_PROOF`：测试被阻断，不是 QA Pass。
- `HUMAN_INHERENT`：需要独立风险审批，不是 QA Pass。

当前没有 QA 自批例外。确需带风险发布时，应停在独立风险审批流程，不得改写 `qa_passed`。

## 菲斯拉职责

菲斯拉在机器门禁通过后异步做影子陪练，只用 `submit_audit_findings` 记录无新增发现、风险发现或系统性风险。她不能放行或打回流水线；机器门禁是唯一自动放行权威。
