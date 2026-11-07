import { formatList, quote } from '../i18n';
import { useT } from '../i18n';
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
  const t = useT();
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
      <div className="source-type-tabs" role="tablist" aria-label={t('library.sourceType')}>
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
          {t('library.githubRepository')}
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
          {t('library.localDirectory')}
        </button>
      </div>
      {!scan ? (
        <>
          {mode === 'github' ? (
            <>
              <label className="field-label">
                {t('library.repositoryUrl')}
                <input
                  autoFocus
                  data-testid="source-uri-input"
                  aria-label={t('library.repositoryUrl')}
                  className="form-input"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder={t('library.ownerRepositoryOrHttpsGithubComOwnerRepository')}
                  onKeyDown={(event) => event.key === 'Enter' && input.trim() && onScan()}
                />
              </label>
              <div className="two-fields">
                <label className="field-label">
                  {t('library.branchOrTag')}
                  <span className="optional">{t('library.optional')}</span>
                  <input
                    className="form-input"
                    value={refValue}
                    onChange={(event) => setRefValue(event.target.value)}
                    placeholder={t('library.defaultBranch')}
                  />
                </label>
                <label className="field-label">
                  {t('library.repositorySubdirectory')}
                  <span className="optional">{t('library.optional')}</span>
                  <input
                    className="form-input"
                    value={subpath}
                    onChange={(event) => setSubpath(event.target.value)}
                    placeholder={t('library.eGSkills')}
                  />
                </label>
              </div>
              <div className="field-help info-help">
                <ShieldCheck size={14} />
                {t('library.repositoryContentsAreReadWithoutRunningScripts')}
              </div>
            </>
          ) : (
            <>
              <label className="field-label">
                {t('library.localSkillDirectory')}
                <input
                  autoFocus
                  data-testid="source-uri-input"
                  aria-label={t('library.localSkillDirectory')}
                  className="form-input"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder={t('library.chooseADirectoryContainingSkillMd')}
                />
              </label>
              <button className="button subtle browse-button" onClick={onBrowse}>
                <FolderOpen size={15} />
                {t('library.browseLocalDirectories')}
              </button>
              <div className="field-help info-help">
                <Folder size={14} />
                {t('library.chooseASingleSkillDirectoryOrADirectoryContainingMultiple')}
              </div>
            </>
          )}
          {error && (
            <div className="form-error">
              <CircleHelp size={14} />
              {error}
              <button onClick={clearError}>{t('library.close')}</button>
            </div>
          )}
          <div className="dialog-footer spread">
            <button className="button subtle" onClick={onCancel} disabled={scanning}>
              {t('library.cancel')}
            </button>
            <button data-testid="scan-source" className="button primary" disabled={!input.trim() || scanning} onClick={onScan}>
              {scanning ? <LoaderCircle size={15} className="spin" /> : <Search size={15} />}
              {scanning ? t('library.scanning') : t('library.scanSkills')}
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
              <strong>{t('library.scanComplete')}</strong>
              <span>
                {scan.source.label} ·{' '}
                {scan.source.commit
                  ? scan.source.commit.slice(0, 8)
                  : mode === 'local'
                    ? t('library.localDirectory')
                    : t('library.noVersionRecorded')}
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
              {t('library.scanAgain')}
            </button>
          </div>
          <div className="candidate-toolbar">
            <div>
              <strong>{t('library.foundSkillCount', { count: candidates.length })}</strong>
              <span>{t('library.nothingIsSelectedInitiallyChooseTheSkillsToImportInto')}</span>
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
                  aria-label={t('library.searchScanResults')}
                  placeholder={t('library.searchCandidateSkills')}
                  value={candidateSearch}
                  onChange={(event) => setCandidateSearch(event.target.value)}
                />
                {candidateSearch && (
                  <button aria-label={t('library.clearCandidateSearch')} onClick={() => setCandidateSearch('')}>
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
                        aria-label={t('library.selectGroup', { group: group })}
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
                          {t('library.skillSelectionCount', {
                            count: members.length,
                            selected: members.filter((candidate) => selected.has(candidate.id)).length,
                          })}
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
                <strong>{candidates.length ? t('library.noMatchingSkills') : t('library.noSkillsFound')}</strong>
                <span>{t('library.checkTheDirectoryOrTryDifferentKeywords')}</span>
              </div>
            )}
          </div>
          {confirmGroups && (
            <div className="detected-group-prompt" role="region" aria-label={t('library.createDetectedGroups')}>
              <strong>
                {editingCustomGroup ? t('library.createACustomGroupForTheseSkills') : t('library.createTheDetectedGroupsAutomatically')}
              </strong>
              {!editingCustomGroup && <p>{formatList(selectedDetectedNames)}</p>}
              <span>
                {editingCustomGroup
                  ? t('library.onlySkillsSuccessfullyImportedThisTimeWillBeAddedTo')
                  : t('library.groupsAreInferredFromRepositoryDirectoriesAndContainOnlySkills')}
              </span>
              {!editingCustomGroup && detectedGroupConflicts.length > 0 && (
                <div className="form-warning">
                  {t('library.duplicateGroups', { names: formatList(detectedGroupConflicts.map((group) => quote(group.name))) })}
                </div>
              )}
              {detectedMergeConfirmation && detectedGroupConflicts.length > 0 ? (
                <>
                  <div className="form-warning" role="alert">
                    {t('library.skillsImportedThisTimeWillBeMergedIntoTheGroups')}
                  </div>
                  <div>
                    <button className="button subtle" disabled={installing || scanning} onClick={() => setDetectedMergeConfirmation(false)}>
                      {t('library.back')}
                    </button>
                    <button className="button subtle" disabled={!selected.size || installing || scanning} onClick={() => onInstall({})}>
                      {t('library.importSkillsOnly')}
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
                      {t('library.useADifferentGroupName')}
                    </button>
                    <button
                      className="button primary"
                      disabled={!selected.size || installing || scanning}
                      onClick={() => onInstall({ createDetectedGroups: true, mergeExistingGroups: true })}
                    >
                      {t('library.mergeIntoExistingGroup')}
                    </button>
                  </div>
                </>
              ) : editingCustomGroup ? (
                <>
                  <label className="field-label">
                    {t('library.customGroupName')}
                    <input
                      ref={customGroupInputRef}
                      autoFocus
                      aria-label={t('library.customGroupName')}
                      className="form-input"
                      maxLength={80}
                      value={customGroupName}
                      onChange={(event) => {
                        setCustomGroupName(event.target.value);
                        setCustomMergeConfirmation(false);
                      }}
                      placeholder={t('library.enterAGroupName')}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          submitCustomGroup();
                        }
                      }}
                    />
                  </label>
                  {customGroupConflict && (
                    <div className="form-warning">{t('library.duplicateGroup', { name: customGroupConflict.name })}</div>
                  )}
                  {customMergeConfirmation && customGroupConflict && (
                    <div className="form-warning" role="alert">
                      {t('library.mergeGroupQuestion', { name: customGroupConflict.name })}
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
                      {t('library.back')}
                    </button>
                    <button
                      className="button primary"
                      disabled={!selected.size || !customGroupName.trim() || installing || scanning}
                      onClick={submitCustomGroup}
                    >
                      {t('library.importAndAddToCustomGroup')}
                    </button>
                  </div>
                  {customMergeConfirmation && customGroupConflict && (
                    <div>
                      <button
                        className="button primary"
                        disabled={!selected.size || installing || scanning}
                        onClick={() => onInstall({ customGroupName: customGroupName.trim(), mergeExistingGroups: true })}
                      >
                        {t('library.mergeIntoExistingGroup')}
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
                        {t('library.useADifferentGroupName')}
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div>
                  <button className="button subtle" disabled={!selected.size || installing || scanning} onClick={() => onInstall({})}>
                    {t('library.importSkillsOnly')}
                  </button>
                  <button className="button primary" disabled={!selected.size || installing || scanning} onClick={requestDetectedGroups}>
                    {t('library.importAndCreateGroups')}
                  </button>
                  <button
                    className="button subtle"
                    disabled={!selected.size || installing || scanning}
                    onClick={() => {
                      setEditingCustomGroup(true);
                      setCustomMergeConfirmation(false);
                    }}
                  >
                    {t('library.customGroup')}
                  </button>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="form-error">
              <CircleHelp size={14} />
              {error}
              <button onClick={clearError}>{t('library.close')}</button>
            </div>
          )}
          <div className="dialog-footer spread">
            <button className="button subtle" onClick={onCancel} disabled={installing}>
              {t('library.cancel')}
            </button>
            <span className="muted-caption">{t('common.selectedCount', { count: selected.size })}</span>
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
              {installing ? t('library.importing') : t('library.importSelectedSkills', { size: selected.size })}
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
  const t = useT();
  return (
    <label className={`candidate-row ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />
      <span className="candidate-check">
        <Check size={12} />
      </span>
      <span className="candidate-copy">
        <strong>{candidate.name}</strong>
        <span>{candidate.description || t('library.noDescription')}</span>
        <small>
          <FileCode2 size={11} />
          {candidate.path}
        </small>
      </span>
      {candidate.installed ? (
        <span className="candidate-status installed">{t('library.installed')}</span>
      ) : candidate.issues.length ? (
        <span className="candidate-status issue" title={candidate.issues.join('\n')}>
          {t('library.needsReview')}
        </span>
      ) : (
        <span className="candidate-status ready">{t('library.readyToImport')}</span>
      )}
    </label>
  );
}

export function InstallResults({ result, onDone }: { result: BatchResult; onDone: () => void }) {
  const t = useT();
  const succeeded = result.items.filter((item) => item.status === 'success').length;
  return (
    <>
      <div className="result-summary">
        <span className="result-icon">
          <Check size={17} />
        </span>
        <div>
          <strong>{t('library.importFinished')}</strong>
          <span>{t('common.completedSummary', { succeeded, attention: result.items.length - succeeded })}</span>
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
                {item.message ||
                  (item.status === 'success'
                    ? t('library.addedToSkillLibrary')
                    : item.status === 'skipped'
                      ? t('library.skippedStatus')
                      : t('library.importFailed'))}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="dialog-footer">
        <button className="button primary" onClick={onDone}>
          {t('library.continue')}
          <ArrowRight size={15} />
        </button>
      </div>
    </>
  );
}
