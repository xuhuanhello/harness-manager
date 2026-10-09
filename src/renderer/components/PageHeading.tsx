import { CircleHelp, X } from 'lucide-react';
import { useState } from 'react';
import type { Marketplace, Snapshot } from '../../shared/types';
import type { Page } from '../view-types';

export function pageTitle(page: Page, marketplace?: Marketplace): string {
  if (page === 'library') return '中央技能库';
  if (page === 'agent-harness') return 'Agent Harness';
  if (page === 'marketplace') return marketplace?.name ?? '技能市场';
  if (page === 'workspaces') return '工作区';
  return '设置';
}

function pageDescription(page: Page, marketplace?: Marketplace): string {
  if (page === 'library') return '整理来自 GitHub 和本地目录的 Agent Skills，再按需应用到目标。';
  if (page === 'agent-harness') return '按 Harness 查看用户级或已知工作区中的受管技能与外部技能。';
  if (page === 'marketplace') {
    if (marketplace?.id === 'skills-sh') return '浏览技能榜单或搜索关键词，按来源仓库选择安装。';
    if (marketplace?.id === 'skillsmp') return '搜索 SkillsMP 技能，按来源仓库选择安装。';
    return '打开自定义市场网站，或到中央技能库添加技能来源。';
  }
  if (page === 'workspaces') return '查看指定工作目录中的受管安装，或打开另一个本地工作区。';
  return '管理 Harness 目录、库位置和本地安装健康。';
}

const EYEBROWS: Record<Page, string> = {
  library: 'YOUR SKILL COLLECTION',
  'agent-harness': 'HARNESS SKILLS',
  marketplace: 'DISCOVER SKILLS',
  workspaces: 'LOCAL WORKSPACES',
  settings: 'PREFERENCES',
};

/** The shared error banner and the recovery issues reported by the main process. */
export function PageNotices({ snapshot, error, onDismissError }: { snapshot: Snapshot; error: string; onDismissError: () => void }) {
  const [issuesExpanded, setIssuesExpanded] = useState(false);
  return (
    <>
      {error && (
        <div className="inline-alert">
          <CircleHelp size={16} />
          <span>{error}</span>
          <button className="icon-button small" aria-label="关闭提示" onClick={onDismissError}>
            <X size={14} />
          </button>
        </div>
      )}
      {!!snapshot.issues?.length && (
        <div className="recovery-alert">
          <div>
            <CircleHelp size={15} />
            <span>{snapshot.issues.length} 项需要留意，包含恢复或文件操作记录。</span>
          </div>
          <button className="text-button" aria-expanded={issuesExpanded} onClick={() => setIssuesExpanded((value) => !value)}>
            {issuesExpanded ? '收起' : '查看'}
          </button>
          {issuesExpanded && (
            <ul>
              {snapshot.issues.map((issue) => (
                <li key={issue.id}>{issue.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

export function PageHeading({ page, snapshot, marketplace }: { page: Page; snapshot: Snapshot; marketplace?: Marketplace }) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{EYEBROWS[page]}</p>
        <h1>{pageTitle(page, marketplace)}</h1>
        <p className="page-description">{pageDescription(page, marketplace)}</p>
      </div>
      {page === 'library' && (
        <div className="heading-stats">
          <div>
            <strong>{snapshot.skills.length}</strong>
            <span>已收录技能</span>
          </div>
          <i />
          <div>
            <strong>{snapshot.sources.length}</strong>
            <span>个来源</span>
          </div>
          <i />
          <div>
            <strong>{snapshot.groups.length}</strong>
            <span>个分组</span>
          </div>
        </div>
      )}
    </div>
  );
}
