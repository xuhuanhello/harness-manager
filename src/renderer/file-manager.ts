import { t } from './i18n';
/** Shared Chinese copy for all reveal actions; the OS still selects the item in its parent folder. */
export function fileManagerLabels(platform?: NodeJS.Platform) {
  const manager = platform === 'darwin' ? t('dialogs.finder') : t('dialogs.fileManager');
  const open = t('dialogs.showIn', { manager: manager });
  return {
    open,
    inspect: t('dialogs.inspectIn', { manager: manager }),
    skillLabel: (name: string) => `${open} ${name}`,
    skillError: (reason: string) => t('dialogs.couldNotShowSkillInFileManager', { open: open, reason: reason }),
  };
}
