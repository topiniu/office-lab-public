export const stages = ['产品', '开发', 'QA', '发布'] as const

type Stage = (typeof stages)[number]

type Sample = {
  id: string
  title: string
  status: string
  stage: Stage
  goal: string
  handoffs: { stage: Stage; artifact: string; detail: string }[]
  next: string
}

export const tasks: Sample[] = [
  {
    id: 'DEMO-01',
    title: '把每周议程导出为 Markdown',
    status: '待人工验收',
    stage: 'QA',
    goal: '成员可以把一周的会议纪要导出为单个 Markdown 文件，便于归档。',
    handoffs: [
      { stage: '产品', artifact: '需求说明', detail: '每条纪要保留标题、日期和负责人。空周给出提示。' },
      { stage: '开发', artifact: '实现记录', detail: '加入导出入口，长列表及中文文件名随交接包送测。' },
      { stage: 'QA', artifact: '验收记录', detail: '已核对空周、多条纪要、中文文件名和导出顺序。' },
    ],
    next: '负责人打开导出文件确认排版，通过后交发布。',
  },
  {
    id: 'DEMO-02',
    title: '允许从归档恢复会议记录',
    status: '开发中',
    stage: '开发',
    goal: '误归档的记录可以恢复，原有标签和参与人保持完整。',
    handoffs: [
      { stage: '产品', artifact: '验收标准', detail: '仅有编辑权限的成员可以恢复。重复点击后只恢复一次。' },
    ],
    next: '开发提交实现说明，并把权限与重复点击场景交给 QA。',
  },
  {
    id: 'DEMO-03',
    title: '按主题筛选会议列表',
    status: '已上线',
    stage: '发布',
    goal: '成员可以从会议列表筛选一个主题，清除筛选后回到全部记录。',
    handoffs: [
      { stage: '产品', artifact: '需求说明', detail: '沿用已有的主题字典，筛选结果为空时保留清除入口。' },
      { stage: '开发', artifact: '实现记录', detail: '将筛选条件写进页面地址，刷新后保留选择。' },
      { stage: 'QA', artifact: '测试报告', detail: '通过主题切换、无结果提示和刷新回显用例。' },
      { stage: '发布', artifact: '上线检查', detail: '上线后复查筛选和清除入口，发布记录归档。' },
    ],
    next: '已完成，交接记录可供后续追溯。',
  },
]
