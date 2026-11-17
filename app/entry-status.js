// ============================================================================
// 需求条目状态词汇表 —— **引擎侧唯一事实源**
//
// 缘起（2026-08-31）：这套枚举与它的几张派生表原先散在 server.js 三处（`ENTRY_STATUS_ENUM` /
// `ENTRY_RESULT_MAP` / `QA_ONWARD_STATUS` / `VER_CLOSED_STATUS`）。纯函数模块（requirement-pool、
// version-report）用不了它们——`import from './server.js'` 会成环——于是我在做 park 对账时**又抄了一份**。
// 抄第二份的当天就该停手：状态词汇一旦有两个副本，改一处忘另一处只是时间问题（§3.4 列契约、
// `文档格式规范.md` §3.4、`app/public/app.js` 的 ENTRY_STATUS 已经是「三处必须同步」的老债了）。
//
// 边界：本模块只放**引擎侧**词汇。前端 `app/public/app.js:482` 的 ENTRY_STATUS（状态→圆点色）与
// `文档格式规范.md` §3.4 的文档侧表仍是各自的事实源，改这里要同步那两处——这一条没变，别指望本模块替它们兜。
// ============================================================================

// 看板枚举权威值。`set_entry_status` 据此校验、拒绝自造状态（自造会在看板落灰）。
// 末三个是守航态状态（park / 隔离 / 晨检待验收）。
export const ENTRY_STATUS_ENUM = [
  '待梳理', '需求确认', '待开发', '开发中', '已定稿', '待审', '已开发', 'QA中', '待QA', '待测',
  '待人工', '待预检', '待复验', '人工Pass', '阻塞', '打回', 'QA通过', '已上线', '已归档',
  '已跳过', '已隔离', '待人工验收',
]

// 已进 QA 及以后（facet_doc 生命周期门禁、park 对账都用它判「机器已经在测它了」）
export const QA_ONWARD_STATUS = new Set(['待测', 'QA中', '待QA', '待复验', '待人工', '待预检', '人工Pass', 'QA通过', '已上线', '已归档'])

// 版本级「全闭环」判据：所有条目都在这个集合里才谈得上发布下一棒
export const VER_CLOSED_STATUS = new Set(['人工Pass', 'QA通过', '已上线', '已归档'])

// 真·已交付：决策已由「发出去了」这个事实兑现。**注意它比 VER_CLOSED_STATUS 窄**——
// 人工Pass/QA通过 只是过检、尚未发布，此时挂在这条需求上的口径问题仍然是活的（REQ-0271 实例）。
export const SHIPPED_STATUS = new Set(['已上线', '已归档'])

// ⚠ **`待人工` 与 `待人工验收` 是两个词，一字之差决定是不是守航终点**（2026-09-19 实账踩到）：
//   · `待人工`     = QA **尚未收束**，还有几条 facet 要人眼看 → 台账记 `in_progress`（在测）
//   · `待人工验收` = QA **已收束**，整条到了老板验收门 → 台账记 `rc_ready`（＝守航契约的 exit.final_state）
//   实账：guarded-01 的 REQ-0342 带着 4 条 BLOCKED_WITH_PROOF 用 `待人工验收` 到了终点；guarded-02 的
//   REQ-0353 形状相同（QA 已收束、12 条须人眼看）却写成 `待人工`，于是守航台账永远差最后一步，晨检包
//   把它读成「在测」而不是「待你验收」。更别扭的是 **`coverage.js` 自己在这种情形下派生的就是 `待人工`**
//   ——引擎一边建议这个词，一边在台账里判它没到终点。别把它当同义词用；判据是「QA 收没收束」，
//   不是「还要不要人看」（要人看的那几条，正是老板晨检要做的事）。软提示见 server.js `set_entry_status`。
// 看板状态 → 守航晨检包的条目结果。看板是条目的权威状态机，所以这张映射在记账侧**覆盖式生效**：
// QA 通过后又被打回/阻塞是真事实，不许被「结果只许前进」的护栏挡住。未列入的一律算「仍在途」，不猜。
export const ENTRY_RESULT_MAP = {
  'QA通过': 'rc_ready', '人工Pass': 'rc_ready', '待人工验收': 'rc_ready', '已上线': 'rc_ready', '已归档': 'rc_ready',
  '阻塞': 'quarantined', '已隔离': 'quarantined',
  '已跳过': 'parked',
}

const clean = s => String(s || '').replace(/\*\*/g, '').trim()

// 版本条目全表的分档（比 ENTRY_RESULT_MAP 细一档：验收单要区分「在测」与「在开发」）。
// 返回 { bucket, label }，bucket ∈ shipped|accepted|qa|dev|blocked|parked|intake
export function classifyEntryStatus(status) {
  const s = clean(status)
  if (SHIPPED_STATUS.has(s)) return { bucket: 'shipped', label: '已交付' }
  if (s === '阻塞' || s === '已隔离' || s === '打回') return { bucket: 'blocked', label: '卡住' }
  if (s === '已跳过') return { bucket: 'parked', label: '已跳过' }
  if (VER_CLOSED_STATUS.has(s) || s === '待人工验收') return { bucket: 'accepted', label: '待你验收' }
  if (QA_ONWARD_STATUS.has(s)) return { bucket: 'qa', label: '在测' }
  if (['待开发', '开发中', '已开发', '已定稿', '待审'].includes(s)) return { bucket: 'dev', label: '开发中' }
  if (!s) return { bucket: 'intake', label: '（登记表没写状态）' }
  return { bucket: 'intake', label: '梳理中' }
}
export const entryResultOf = status => ENTRY_RESULT_MAP[clean(status)] || 'in_progress'
