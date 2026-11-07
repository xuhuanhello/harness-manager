import { countUnit } from '../i18n';
import { t, useT } from '../i18n';
import { CircleHelp, X } from 'lucide-react';
import { useState } from 'react';
import type { Marketplace, Snapshot } from '../../shared/types';
import type { Page } from '../view-types';

export function pageTitle(page: Page, marketplace?: Marketplace): string {
  if (page === 'library') return t('library.skillLibrary');
  if (page === 'agent-harness') return 'Agent Harness';
  if (page === 'marketplace') return marketplace?.name ?? t('library.skillMarketplace');
  if (page === 'workspaces') return t('library.workspaces');
  return t('library.settings');
}

function pageDescription(page: Page, marketplace?: Marketplace): string {
  if (page === 'library') return t('library.organizeAgentSkillsFromGithubAndLocalDirectoriesThenApply');
  if (page === 'agent-harness') return t('library.browseManagedAndExternalSkillsByHarnessForYourUser');
  if (page === 'marketplace') {
    if (marketplace?.id === 'skills-sh') return t('library.browseRankingsOrSearchKeywordsThenChooseSkillsBySource');
    if (marketplace?.id === 'skillsmp') return t('library.searchSkillsmpAndChooseSkillsBySourceRepository');
    return t('library.openACustomMarketplaceWebsiteOrAddASourceIn');
  }
  if (page === 'workspaces') return t('library.viewManagedSkillsInAWorkingDirectoryOrOpenAnother');
  return t('library.manageHarnessDirectoriesLibraryLocationAndLocalInstallationHealth');
}

const eyebrows = (): Record<Page, string> => ({
  library: t('library.collectionEyebrow'),
  'agent-harness': t('library.harnessEyebrow'),
  marketplace: t('library.discoverEyebrow'),
  workspaces: t('library.workspaceEyebrow'),
  settings: t('library.preferencesEyebrow'),
});

/** The shared error banner and the recovery issues reported by the main process. */
export function PageNotices({ snapshot, error, onDismissError }: { snapshot: Snapshot; error: string; onDismissError: () => void }) {
  const t = useT();
  const [issuesExpanded, setIssuesExpanded] = useState(false);
  return (
    <>
      {error && (
        <div className="inline-alert">
          <CircleHelp size={16} />
          <span>{error}</span>
          <button className="icon-button small" aria-label={t('library.dismissMessage')} onClick={onDismissError}>
            <X size={14} />
          </button>
        </div>
      )}
      {!!snapshot.issues?.length && (
        <div className="recovery-alert">
          <div>
            <CircleHelp size={15} />
            <span>{t('library.attentionCount', { count: snapshot.issues.length })}</span>
          </div>
          <button className="text-button" aria-expanded={issuesExpanded} onClick={() => setIssuesExpanded((value) => !value)}>
            {issuesExpanded ? t('library.hide') : t('library.view')}
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
  useT();
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{eyebrows()[page]}</p>
        <h1>{pageTitle(page, marketplace)}</h1>
        <p className="page-description">{pageDescription(page, marketplace)}</p>
      </div>
      {page === 'library' && (
        <div className="heading-stats">
          <div>
            <strong>{snapshot.skills.length}</strong>
            <span>{countUnit(snapshot.skills.length, 'importedSkill')}</span>
          </div>
          <i />
          <div>
            <strong>{snapshot.sources.length}</strong>
            <span>{countUnit(snapshot.sources.length, 'source')}</span>
          </div>
          <i />
          <div>
            <strong>{snapshot.groups.length}</strong>
            <span>{countUnit(snapshot.groups.length, 'group')}</span>
          </div>
        </div>
      )}
    </div>
  );
}
