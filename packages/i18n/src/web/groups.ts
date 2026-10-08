import type { TextCatalog } from '../text.ts'

/**
 * 智能体组（D70 增量添加）：`views/Groups.svelte`。
 *
 * ⚠️ zh 的值改之前先看一眼**有没有东西钉着它**：中文是默认语言，既有测试、布局
 *    探针与文档都引用它。有引用就一起改，没有就按读者改。
 *
 * ⚠️ 命令式的两处（保存失败、删除确认的标题）走 `tx()`：事件回调里取的是**调用
 *    那一刻**的语言；标记里一律用 `{$t(...)}`，它才会跟着语言切换重渲染。
 */
export const groupsText = {
  // ── 列表 ──
  'groups.listCount': { zh: '共 {count} 个组', en: '{count} groups' },
  'groups.emptyTitle': { zh: '还没有智能体组', en: 'No agent groups yet' },
  'groups.emptyHint': {
    zh: '点右上角「新建智能体组」，把一队人（执行 + 审核）连同默认的行动权限收在一起。新建任务时一下选走。',
    en: 'Click “New agent group” to bundle a pair (executor + reviewer) with its default action permissions. Pick it in one go when creating a task.',
  },
  'groups.search': { zh: '搜组名', en: 'Search group names' },
  'groups.emptyFiltered': { zh: '没有匹配的组', en: 'No matching groups' },
  'groups.emptyFilteredHint': { zh: '换一个关键词试试。', en: 'Try a different keyword.' },
  'groups.disabledBadge': { zh: '已停用', en: 'Disabled' },
  'groups.chainExecutor': { zh: '{name} 执行', en: '{name} executes' },
  'groups.memberMissing': { zh: '（成员已删除）', en: '(member deleted)' },
  'groups.actionCount': { zh: '· {count} 个动作', en: '· {count} actions' },
  'groups.reworkMeta': { zh: '· 返工 {n} 次', en: '· rework {n}×' },

  // ── 右栏占位 ──
  'groups.pickOneTitle': { zh: '选一个智能体组', en: 'Pick an agent group' },
  'groups.pickOneHint': {
    zh: '右侧是这条链的默认配置：执行者 → 审核者 → 允许的动作 → 返工次数。',
    en: 'The right pane shows this chain’s defaults: executor → reviewer → allowed actions → rework.',
  },
  'groups.pickOneHow': {
    zh: '新建任务时选了组，这些默认一步到位；每一步仍可按任务覆盖。',
    en: 'Picking a group when creating a task brings these defaults in one step; each can still be overridden per task.',
  },

  // ── 表单 ──
  'groups.newTitle': { zh: '新建智能体组', en: 'New agent group' },
  'groups.nameLabel': { zh: '组名', en: 'Group name' },
  'groups.namePlaceholder': { zh: '例如：UI 审查组', en: 'e.g. UI review pair' },
  'groups.executorLabel': { zh: '执行者', en: 'Executor' },
  'groups.executorHint': {
    zh: '这组里负责干活的（新建任务选了组，就是它执行）。',
    en: 'The one who does the work (the executor when this group is picked).',
  },
  'groups.reviewerLabel': { zh: '审核者', en: 'Reviewer' },
  'groups.reviewerHint': {
    zh: '这组里负责判的（它按自己那套标准审，动作权限默认用本组的）。',
    en: 'The one who reviews (judges by its own standard; action permissions default to this group’s).',
  },
  'groups.reworkLabel': { zh: '审核不通过时返工', en: 'Rework on rejection' },
  'groups.reworkZero': { zh: '0 次（不返工）', en: '0 — no rework' },
  'groups.reworkTimes': { zh: '{n} 次', en: '{n}×' },
  'groups.reworkUnlimited': { zh: '无限', en: 'Unlimited' },
  'groups.reworkUnlimitedMeta': { zh: '· 返工无限次', en: '· rework ∞' },
  'groups.reworkHint': {
    zh: '组的默认返工次数：0–100 次，或无限（不通过就一直重做，会持续烧 CLI 额度）；新建任务时仍可按这一次单独改。',
    en: 'The group’s default rework count: 0–100, or unlimited (keeps reworking until passed — keeps burning CLI budget); still overridable per task.',
  },
  'groups.actionsLabel': { zh: '组的行动权限', en: 'Group action permissions' },
  'groups.saveButton': { zh: '保存', en: 'Save' },
  'groups.createButton': { zh: '创建组', en: 'Create group' },
  'groups.deleteButton': { zh: '删除组', en: 'Delete group' },

  // ── 校验与确认 ──
  'groups.needName': { zh: '组需要一个名字。', en: 'A group needs a name.' },
  'groups.needMembers': { zh: '执行者与审核者都要选（这一版一个组 = 一个执行者 + 一个审核者）。', en: 'Pick both an executor and a reviewer (a group is one executor + one reviewer in this version).' },
  'groups.debugNotAllowed': {
    zh: '调试动作必须在行动权限里：{actions} 没勾为允许。先允许，再标调试。',
    en: 'Debug actions must be allowed first: {actions} are not. Allow them, then mark debug.',
  },
  'groups.confirmDeleteTitle': { zh: '删除智能体组', en: 'Delete agent group' },
  'groups.deleteConfirm': { zh: '删除组', en: 'Delete group' },
  'groups.confirmDeletePrivate': {
    zh: '组里的 {n} 个私有智能体会一起删除。',
    en: '{n} private agent(s) in this group will be deleted with it.',
  },

  // ── 第二轮：工作流模式 + 私有成员 ──
  'groups.modeLabel': { zh: '模式', en: 'Mode' },
  'groups.modeWorkflow': { zh: '工作流', en: 'Workflow' },
  // ★ 2026-10：模式的说明——放进模式选择按钮的第二行（与智能体「执行/审核」
  //   那两颗大按钮同款结构）。目前唯一模式就是工作流。
  'groups.modeWorkflowHint': {
    zh: '执行 → 审核 → 行动（判完可触发动作）',
    en: 'Execute → Review → Act (actions fire after a verdict)',
  },
  // ★ 2026-10：配置区三个阶段的「阶段头」——编号徽章 + 阶段名 + 一句说明，
  //   让「执行 → 审核 → 行动」这条链在配置里一眼可循。
  'groups.stageExec': { zh: '执行', en: 'Execute' },
  'groups.stageExecDesc': { zh: '谁来做这件事', en: 'Who does the work' },
  'groups.stageReview': { zh: '审核', en: 'Review' },
  'groups.stageReviewDesc': { zh: '谁把关，不过就返工', en: 'Who signs off; rework on rejection' },
  'groups.stageAct': { zh: '行动', en: 'Act' },
  'groups.stageActDesc': { zh: '判完可以触发哪些动作', en: 'Which actions may fire after a verdict' },
  'groups.slotGlobal': { zh: '选已有的', en: 'Pick existing' },
  'groups.slotPrivate': { zh: '新建私有', en: 'Create private' },
  'groups.slotPickPlaceholder': { zh: '（选一个）', en: '(pick one)' },
  'groups.pickSummary': {
    zh: '已选：{name} · {runtime} · {skills} 个技能',
    en: 'Picked: {name} · {runtime} · {skills} skills',
  },
  'groups.privateBadge': { zh: '私有', en: 'Private' },
  'groups.privateNameLabel': { zh: '名字', en: 'Name' },
  'groups.privateNamePlaceholder': { zh: '例如：私有审查员', en: 'e.g. private reviewer' },
  'groups.privateInstructionsLabel': { zh: '指令', en: 'Instructions' },
  'groups.privateStandardBodyLabel': { zh: '审核标准', en: 'Review standard' },
  'groups.privateRuntimeLabel': { zh: '用哪个 CLI', en: 'Which CLI' },
  'groups.privateSkillsLabel': { zh: '可选：挂技能', en: 'Optional: skills' },
  'groups.privateNoSkills': { zh: '（还没有技能）', en: '(No skills yet)' },
  'groups.privateReviewerNeedsStandard': {
    zh: '私有审核者要有审核标准——没有标准的审核者拿不到审核任务。',
    en: 'A private reviewer needs a review standard, or it can’t review.',
  },
  'groups.privateCannotSwitchBack': {
    zh: '这轮不能在组里移除私有成员（删除整个组会把它们一起删掉）。',
    en: 'Private members can’t be removed from a group in this version (deleting the group removes them).',
  },
  // ── 行动权限：默认收起，小按钮选择 ──
  'groups.actionsCollapsed': { zh: '不配动作', en: 'No actions' },
  'groups.actionsExpanded': { zh: '配动作', en: 'Configure' },
  'groups.actionsCollapsedHint': {
    zh: '组默认不配动作：新建任务选了组，动作栏默认空（只报告、不动手）。',
    en: 'No actions by default: tasks from this group start with an empty action list (report only).',
  },
  'groups.confirmDeleteBody': {
    zh: '删掉「{name}」不会动到组里的智能体，但它们用过的默认安排会一起消失；已经派下去的任务不受影响。',
    en: 'Deleting “{name}” does not remove its agents, but the group defaults disappear with it; tasks already sent are unaffected.',
  },
} as const satisfies TextCatalog
