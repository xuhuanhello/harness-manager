import { candidateGroup } from '../../shared/candidate-groups';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronDown,
  CircleHelp,
  FileCode2,
  Folder,
  FolderOpen,
  Github,
  LoaderCircle,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import ListActions from './ListActions';
import type { BatchResult, Candidate, Group, ScanResult } from '../../shared/types';
import type { SourceInstallOptions } from '../view-types';
import { normalizeGroupName } from '../format';

/** Adding a source: scan, choose candidates, import and show results. */
export function SourceWizard({
  mode,
  setMode,
  input,
  setInput,
  refValue,
  setRefValue,
  subpath,
  setSubpath,
  scan,
  setScan,
  selected,
  setSelected,
  candidateSearch,
  setCandidateSearch,
  groups,
  scanning,
  installing,
  error,
  clearError,
  onCancel,
  onBrowse,
  onScan,
  onInstall,
}: {
  mode: 'github' | 'local';
  setMode: (mode: 'github' | 'local') => void;
  input: string;
  setInput: (value: string) => void;
  refValue: string;
  setRefValue: (value: string) => void;
  subpath: string;
  setSubpath: (value: string) => void;
  scan: ScanResult | null;
  setScan: (scan: ScanResult | null) => void;
  selected: Set<string>;
  setSelected: (ids: Set<string>) => void;
  candidateSearch: string;
  setCandidateSearch: (value: string) => void;
  groups: Group[];
  scanning: boolean;
  installing: boolean;
  error: string;
  clearError: () => void;
  onCancel: () => void;
  onBrowse: () => void;
  onScan: () => void;
  onInstall: (options: SourceInstallOptions) => void;
}) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [searchCollapsedGroups, setSearchCollapsedGroups] = useState<Set<string>>(new Set());
  const [confirmGroups, setConfirmGroups] = useState(false);
  const [editingCustomGroup, setEditingCustomGroup] = useState(false);
  const [customGroupName, setCustomGroupName] = useState('');
  const [customMergeConfirmation, setCustomMergeConfirmation] = useState(false);
  const [detectedMergeConfirmation, setDetectedMergeConfirmation] = useState(false);
  const customGroupInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setExpandedGroups(new Set());
    setConfirmGroups(false);
    setEditingCustomGroup(false);
    setCustomGroupName('');
    setCustomMergeConfirmation(false);
    setDetectedMergeConfirmation(false);
  }, [scan?.id]);
  const candidates = scan?.candidates ?? [];
  const matching = candidates.filter(
    (candidate) =>
      !candidateSearch.trim() ||
      `${candidate.name} ${candidate.description} ${candidate.path}`
        .toLocaleLowerCase()
        .includes(candidateSearch.trim().toLocaleLowerCase()),
  );
  const available = matching.filter((candidate) => !candidate.installed && !candidate.issues.length);
  const matchingGroupNames = [...new Set(matching.map((candidate) => candidateGroup(candidate.path) ?? ''))];
  const collapsibleCandidateGroups = matchingGroupNames.filter(Boolean);
  const candidateSearchKey = (group: string) => `${candidateSearch.trim().toLocaleLowerCase()}\u0000${group}`;
  const isCandidateGroupExpanded = (group: string) =>
    !group ? true : candidateSearch.trim() ? !searchCollapsedGroups.has(candidateSearchKey(group)) : expandedGroups.has(group);
  const candidateGroupsExpanded = collapsibleCandidateGroups.length > 0 && collapsibleCandidateGroups.every(isCandidateGroupExpanded);
  const toggleAllCandidateGroups = () => {
    const shouldExpand = !candidateGroupsExpanded;
    if (candidateSearch.trim())
      setSearchCollapsedGroups((current) => {
        const next = new Set(current);
        collapsibleCandidateGroups.forEach((group) => {
          if (shouldExpand) next.delete(candidateSearchKey(group));
          else next.add(candidateSearchKey(group));
        });
        return next;
      });
    else
      setExpandedGroups((current) => {
        const next = new Set(current);
        collapsibleCandidateGroups.forEach((group) => {
          if (shouldExpand) next.add(group);
          else next.delete(group);
        });
        return next;
      });
  };
  const selectedDetectedNames = [
    ...new Map(
      candidates
        .filter((candidate) => selected.has(candidate.id))
        .map((candidate) => candidateGroup(candidate.path))
        .filter((name): name is string => !!name)
        .map((name) => [normalizeGroupName(name), name] as const),
    ).values(),
  ];
  const detectedGroupConflicts = [
    ...new Map(
      selectedDetectedNames
        .map((name) => groups.find((group) => normalizeGroupName(group.name) === normalizeGroupName(name)))
        .filter((group): group is Group => !!group)
        .map((group) => [group.id, group]),
    ).values(),
  ];
  const customGroupConflict = customGroupName.trim()
    ? groups.find((group) => normalizeGroupName(group.name) === normalizeGroupName(customGroupName.trim()))
    : undefined;
  const updateSelected = (ids: Set<string>) => {
    setSelected(ids);
    setCustomMergeConfirmation(false);
    setDetectedMergeConfirmation(false);
  };
  const submitCustomGroup = () => {
    if (!selected.size || !customGroupName.trim() || installing || scanning || customMergeConfirmation) return;
    if (customGroupConflict) {
      setCustomMergeConfirmation(true);
      return;
    }
    onInstall({ customGroupName: customGroupName.trim() });
  };
  const requestDetectedGroups = () => {
    if (!selected.size || installing || scanning) return;
    if (detectedGroupConflicts.length) {
      setDetectedMergeConfirmation(true);
      return;
    }
    onInstall({ createDetectedGroups: true });
  };
  return (
    <div className="source-wizard">
      <div className="source-type-tabs" role="tablist" aria-label="来源类型">
        <button
          role="tab"
          aria-selected={mode === 'github'}
          className={mode === 'github' ? 'active' : ''}
          onClick={() => {
            setMode('github');
            setScan(null);
          }}
        >
          <Github size={15} />
          GitHub 仓库
        </button>
        <button
          role="tab"
          aria-selected={mode === 'local'}
          className={mode === 'local' ? 'active' : ''}
          onClick={() => {
            setMode('local');
            setScan(null);
          }}
        >
          <Folder size={15} />
          本地目录
        </button>
      </div>
      {!scan ? (
        <>
          {mode === 'github' ? (
            <>
              <label className="field-label">
                仓库地址
                <input
                  autoFocus
                  data-testid="source-uri-input"
                  aria-label="仓库地址"
                  className="form-input"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="owner/repository 或 https://github.com/owner/repository"
                  onKeyDown={(event) => event.key === 'Enter' && input.trim() && onScan()}
                />
              </label>
              <div className="two-fields">
                <label className="field-label">
                  分支或标签 <span className="optional">可选</span>
                  <input
                    className="form-input"
                    value={refValue}
                    onChange={(event) => setRefValue(event.target.value)}
                    placeholder="默认分支"
                  />
                </label>
                <label className="field-label">
                  仓库子目录 <span className="optional">可选</span>
                  <input
                    className="form-input"
                    value={subpath}
                    onChange={(event) => setSubpath(event.target.value)}
                    placeholder="例如 skills/"
                  />
                </label>
              </div>
              <div className="field-help info-help">
                <ShieldCheck size={14} />
                只读取仓库内容，不会执行其中的脚本。
              </div>
            </>
          ) : (
            <>
              <label className="field-label">
                本地技能目录
                <input
                  autoFocus
                  data-testid="source-uri-input"
                  aria-label="本地技能目录"
                  className="form-input"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="选择包含 SKILL.md 的目录"
                />
              </label>
              <button className="button subtle browse-button" onClick={onBrowse}>
                <FolderOpen size={15} />
                浏览本地目录
              </button>
              <div className="field-help info-help">
                <Folder size={14} />
                可选择单个 Skill 目录，或包含多个技能的目录。
              </div>
            </>
          )}
          {error && (
            <div className="form-error">
              <CircleHelp size={14} />
              {error}
              <button onClick={clearError}>关闭</button>
            </div>
          )}
          <div className="dialog-footer spread">
            <button className="button subtle" onClick={onCancel} disabled={scanning}>
              取消
            </button>
            <button data-testid="scan-source" className="button primary" disabled={!input.trim() || scanning} onClick={onScan}>
              {scanning ? <LoaderCircle size={15} className="spin" /> : <Search size={15} />}
              {scanning ? '正在扫描…' : '扫描技能'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="scan-summary">
            <div className="scan-summary-icon">
              <Check size={17} />
            </div>
            <div>
              <strong>扫描完成</strong>
              <span>
                {scan.source.label} · {scan.source.commit ? scan.source.commit.slice(0, 8) : mode === 'local' ? '本地目录' : '未记录版本'}
              </span>
            </div>
            <button
              className="text-button"
              onClick={() => {
                setScan(null);
                setSelected(new Set());
                setCandidateSearch('');
              }}
            >
              重新扫描
            </button>
          </div>
          <div className="candidate-toolbar">
            <div>
              <strong>发现 {candidates.length} 个技能</strong>
              <span>首次扫描默认不勾选；请选择要放入中央库的项目。</span>
            </div>
            <div className="candidate-actions">
              <ListActions
                allExpanded={candidateGroupsExpanded}
                onToggleExpanded={toggleAllCandidateGroups}
                expandableCount={collapsibleCandidateGroups.length}
                selectableCount={available.length}
                allSelected={available.length > 0 && available.every((candidate) => selected.has(candidate.id))}
                onToggleSelection={() => {
                  const allSelected = available.length > 0 && available.every((candidate) => selected.has(candidate.id));
                  const next = new Set(selected);
                  available.forEach((candidate) => {
                    if (allSelected) next.delete(candidate.id);
                    else next.add(candidate.id);
                  });
                  updateSelected(next);
                }}
              />
              <label className="candidate-search">
                <Search size={12} />
                <input
                  aria-label="搜索扫描结果"
                  placeholder="搜索候选技能"
                  value={candidateSearch}
                  onChange={(event) => setCandidateSearch(event.target.value)}
                />
                {candidateSearch && (
                  <button aria-label="清除候选搜索" onClick={() => setCandidateSearch('')}>
                    <X size={12} />
                  </button>
                )}
              </label>
            </div>
          </div>
          <div className="candidate-list">
            {matchingGroupNames.map((group) => {
              const members = matching.filter((candidate) => (candidateGroup(candidate.path) ?? '') === group);
              const selectable = members.filter((candidate) => !candidate.installed && !candidate.issues.length);
              const count = selectable.filter((candidate) => selected.has(candidate.id)).length;
              const expanded = isCandidateGroupExpanded(group);
              return (
                <section className="candidate-group" key={group}>
                  {group && (
                    <div className="candidate-group-heading">
                      <input
                        type="checkbox"
                        aria-label={`选择分组 ${group}`}
                        disabled={!selectable.length}
                        checked={selectable.length > 0 && count === selectable.length}
                        ref={(node) => {
                          if (node) node.indeterminate = count > 0 && count < selectable.length;
                        }}
                        onChange={() => {
                          const next = new Set(selected);
                          selectable.forEach((candidate) => {
                            if (count === selectable.length) next.delete(candidate.id);
                            else next.add(candidate.id);
                          });
                          updateSelected(next);
                        }}
                      />
                      <button
                        aria-expanded={expanded}
                        onClick={() => {
                          if (candidateSearch.trim())
                            setSearchCollapsedGroups((current) => {
                              const next = new Set(current);
                              const key = candidateSearchKey(group);
                              next.has(key) ? next.delete(key) : next.add(key);
                              return next;
                            });
                          else
                            setExpandedGroups((current) => {
                              const next = new Set(current);
                              next.has(group) ? next.delete(group) : next.add(group);
                              return next;
                            });
                        }}
                      >
                        <ChevronDown size={14} className={expanded ? '' : 'collapsed-chevron'} />
                        <Folder size={14} />
                        <strong>{group}</strong>
                        <span>
                          {members.length} 个技能 · 已选 {members.filter((candidate) => selected.has(candidate.id)).length}
                        </span>
                      </button>
                    </div>
                  )}
                  {expanded &&
                    members.map((candidate) => (
                      <CandidateRow
                        key={candidate.id}
                        candidate={candidate}
                        checked={selected.has(candidate.id)}
                        disabled={candidate.installed || !!candidate.issues.length}
                        onToggle={() => {
                          const next = new Set(selected);
                          if (next.has(candidate.id)) next.delete(candidate.id);
                          else next.add(candidate.id);
                          updateSelected(next);
                        }}
                      />
                    ))}
                </section>
              );
            })}
            {!matching.length && (
              <div className="candidate-empty">
                <Search size={20} />
                <strong>{candidates.length ? '没有匹配的技能' : '没有发现技能'}</strong>
                <span>检查目录或尝试其他关键词。</span>
              </div>
            )}
          </div>
          {confirmGroups && (
            <div className="detected-group-prompt" role="region" aria-label="创建识别分组">
              <strong>{editingCustomGroup ? '为本次技能创建自定义分组' : '是否自动创建识别到的分组？'}</strong>
              {!editingCustomGroup && <p>{selectedDetectedNames.join('、')}</p>}
              <span>
                {editingCustomGroup
                  ? '只将本次成功安装的技能加入自定义分组；同名分组需要明确确认后才会合并。'
                  : '根据仓库目录推断；只加入本次成功安装的技能。同名分组需要明确确认后才会合并。'}
              </span>
              {!editingCustomGroup && detectedGroupConflicts.length > 0 && (
                <div className="form-warning">已存在同名分组：{detectedGroupConflicts.map((group) => `“${group.name}”`).join('、')}。</div>
              )}
              {detectedMergeConfirmation && detectedGroupConflicts.length > 0 ? (
                <>
                  <div className="form-warning" role="alert">
                    确认后会将本次成功安装的技能合并到上述分组；没有同名分组的识别名称会新建分组。
                  </div>
                  <div>
                    <button className="button subtle" disabled={installing || scanning} onClick={() => setDetectedMergeConfirmation(false)}>
                      返回
                    </button>
                    <button className="button subtle" disabled={!selected.size || installing || scanning} onClick={() => onInstall({})}>
                      仅安装技能
                    </button>
                    <button
                      className="button subtle"
                      disabled={installing || scanning}
                      onClick={() => {
                        setDetectedMergeConfirmation(false);
                        setEditingCustomGroup(true);
                        setCustomGroupName('');
                      }}
                    >
                      换个名称创建新分组
                    </button>
                    <button
                      className="button primary"
                      disabled={!selected.size || installing || scanning}
                      onClick={() => onInstall({ createDetectedGroups: true, mergeExistingGroups: true })}
                    >
                      合并到已有分组
                    </button>
                  </div>
                </>
              ) : editingCustomGroup ? (
                <>
                  <label className="field-label">
                    自定义分组名称
                    <input
                      ref={customGroupInputRef}
                      autoFocus
                      aria-label="自定义分组名称"
                      className="form-input"
                      maxLength={80}
                      value={customGroupName}
                      onChange={(event) => {
                        setCustomGroupName(event.target.value);
                        setCustomMergeConfirmation(false);
                      }}
                      placeholder="输入分组名称"
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          submitCustomGroup();
                        }
                      }}
                    />
                  </label>
                  {customGroupConflict && <div className="form-warning">已存在同名分组“{customGroupConflict.name}”。</div>}
                  {customMergeConfirmation && customGroupConflict && (
                    <div className="form-warning" role="alert">
                      是否将本次成功安装的技能合并到“{customGroupConflict.name}”？
                    </div>
                  )}
                  <div>
                    <button
                      className="button subtle"
                      disabled={installing || scanning}
                      onClick={() => {
                        setEditingCustomGroup(false);
                        setCustomMergeConfirmation(false);
                      }}
                    >
                      返回
                    </button>
                    <button
                      className="button primary"
                      disabled={!selected.size || !customGroupName.trim() || installing || scanning}
                      onClick={submitCustomGroup}
                    >
                      安装并加入自定义分组
                    </button>
                  </div>
                  {customMergeConfirmation && customGroupConflict && (
                    <div>
                      <button
                        className="button primary"
                        disabled={!selected.size || installing || scanning}
                        onClick={() => onInstall({ customGroupName: customGroupName.trim(), mergeExistingGroups: true })}
                      >
                        合并到已有分组
                      </button>
                      <button
                        className="button subtle"
                        disabled={installing || scanning}
                        onClick={() => {
                          setCustomMergeConfirmation(false);
                          customGroupInputRef.current?.focus();
                          customGroupInputRef.current?.select();
                        }}
                      >
                        换个名称创建新分组
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div>
                  <button className="button subtle" disabled={!selected.size || installing || scanning} onClick={() => onInstall({})}>
                    仅安装技能
                  </button>
                  <button className="button primary" disabled={!selected.size || installing || scanning} onClick={requestDetectedGroups}>
                    安装并创建分组
                  </button>
                  <button
                    className="button subtle"
                    disabled={!selected.size || installing || scanning}
                    onClick={() => {
                      setEditingCustomGroup(true);
                      setCustomMergeConfirmation(false);
                    }}
                  >
                    自定义分组
                  </button>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="form-error">
              <CircleHelp size={14} />
              {error}
              <button onClick={clearError}>关闭</button>
            </div>
          )}
          <div className="dialog-footer spread">
            <button className="button subtle" onClick={onCancel} disabled={installing}>
              取消
            </button>
            <span className="muted-caption">已选择 {selected.size} 项</span>
            <button
              data-testid="install-selected-candidates"
              className="button primary"
              disabled={!selected.size || installing || scanning}
              onClick={() => {
                if (candidates.some((candidate) => selected.has(candidate.id) && candidateGroup(candidate.path))) {
                  setDetectedMergeConfirmation(false);
                  setCustomMergeConfirmation(false);
                  setEditingCustomGroup(false);
                  setConfirmGroups(true);
                } else onInstall({});
              }}
            >
              {installing ? <LoaderCircle size={15} className="spin" /> : <ArrowDownToLine size={15} />}
              {installing ? '正在安装…' : `安装所选技能 (${selected.size})`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function CandidateRow({
  candidate,
  checked,
  disabled,
  onToggle,
}: {
  candidate: Candidate;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <label className={`candidate-row ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />
      <span className="candidate-check">
        <Check size={12} />
      </span>
      <span className="candidate-copy">
        <strong>{candidate.name}</strong>
        <span>{candidate.description || '暂无描述。'}</span>
        <small>
          <FileCode2 size={11} />
          {candidate.path}
        </small>
      </span>
      {candidate.installed ? (
        <span className="candidate-status installed">已安装</span>
      ) : candidate.issues.length ? (
        <span className="candidate-status issue" title={candidate.issues.join('\n')}>
          需检查
        </span>
      ) : (
        <span className="candidate-status ready">可安装</span>
      )}
    </label>
  );
}

export function InstallResults({ result, onDone }: { result: BatchResult; onDone: () => void }) {
  const succeeded = result.items.filter((item) => item.status === 'success').length;
  return (
    <>
      <div className="result-summary">
        <span className="result-icon">
          <Check size={17} />
        </span>
        <div>
          <strong>安装处理完成</strong>
          <span>
            {succeeded} 项成功 · {result.items.length - succeeded} 项需留意
          </span>
        </div>
      </div>
      <div className="result-list">
        {result.items.map((item) => (
          <div className="result-row" key={item.id}>
            <span className={`result-state ${item.status}`}>
              {item.status === 'success' ? <Check size={13} /> : item.status === 'skipped' ? <ArrowRight size={13} /> : <X size={13} />}
            </span>
            <div>
              <strong>{item.label}</strong>
              <span>
                {item.message || (item.status === 'success' ? '已加入中央技能库' : item.status === 'skipped' ? '已跳过' : '安装失败')}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="dialog-footer">
        <button className="button primary" onClick={onDone}>
          继续 <ArrowRight size={15} />
        </button>
      </div>
    </>
  );
}
