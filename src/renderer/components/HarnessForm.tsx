import { Check, LoaderCircle, ShieldCheck } from 'lucide-react';
import type { HarnessInput } from '../../shared/types';
const lines = (value: string) =>
  value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
export default function HarnessForm({
  value,
  builtin,
  onChange,
  onCancel,
  onSave,
  saving,
  error,
}: {
  value: HarnessInput;
  builtin: boolean;
  onChange: (value: HarnessInput) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  error: string;
}) {
  const invalid =
    !value.name.trim() ||
    (!value.userSkillsPath.trim() &&
      !value.workspaceSkillsRelativePath.trim() &&
      !value.readsUserAgents &&
      !value.readsWorkspaceAgents &&
      value.kind !== 'universal');
  return (
    <>
      {builtin && (
        <div className="form-help-box">
          <ShieldCheck size={16} />
          <span>内置目录及兼容规范由官方文档定义。可以补充本机可执行文件、桌面应用或编辑器扩展的位置。</span>
        </div>
      )}
      <fieldset className="modal-fields" disabled={builtin || saving}>
        <label className="field-label">
          名称
          <input
            autoFocus={!builtin}
            className="form-input"
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
          />
        </label>
        <label className="field-label">
          图标字符
          <input
            className="form-input short-input"
            maxLength={3}
            value={value.icon || ''}
            onChange={(e) => onChange({ ...value, icon: e.target.value })}
          />
        </label>
        <div className="field-label">
          工具类型
          <div className="scope-switch">
            {(['cli', 'desktop'] as const).map((kind) => (
              <button key={kind} type="button" className={value.kind === kind ? 'active' : ''} onClick={() => onChange({ ...value, kind })}>
                {kind === 'cli' ? '命令行 CLI' : '桌面应用'}
              </button>
            ))}
          </div>
        </div>
        <label className="field-label">
          用户级技能目录
          <input
            className="form-input"
            value={value.userSkillsPath}
            onChange={(e) => onChange({ ...value, userSkillsPath: e.target.value })}
            placeholder="~/.my-agent/skills"
          />
        </label>
        <label className="field-label">
          工作区级相对目录
          <input
            className="form-input"
            value={value.workspaceSkillsRelativePath}
            onChange={(e) => onChange({ ...value, workspaceSkillsRelativePath: e.target.value })}
            placeholder=".my-agent/skills"
          />
        </label>
        <div className="harness-compatibility-fields">
          <label>
            <input
              type="checkbox"
              checked={!!value.readsUserAgents}
              onChange={(e) => onChange({ ...value, readsUserAgents: e.target.checked })}
            />
            识别用户级 ~/.agents/skills
          </label>
          <label>
            <input
              type="checkbox"
              checked={!!value.readsWorkspaceAgents}
              onChange={(e) => onChange({ ...value, readsWorkspaceAgents: e.target.checked })}
            />
            识别工作区 .agents/skills
          </label>
        </div>
        <label className="field-label">
          额外识别的用户级技能目录
          <textarea
            className="form-input"
            value={(value.extraUserSkillsPaths ?? []).join('\n')}
            onChange={(e) => onChange({ ...value, extraUserSkillsPaths: lines(e.target.value) })}
            placeholder="每行一个完整目录，可留空"
          />
        </label>
        <label className="field-label">
          额外识别的工作区相对目录
          <textarea
            className="form-input"
            value={(value.extraWorkspaceSkillsRelativePaths ?? []).join('\n')}
            onChange={(e) => onChange({ ...value, extraWorkspaceSkillsRelativePaths: lines(e.target.value) })}
            placeholder="每行一个相对目录，可留空"
          />
        </label>
        <label className="field-label">
          检测命令
          <input
            className="form-input"
            value={value.command ?? ''}
            onChange={(e) => onChange({ ...value, command: e.target.value })}
            placeholder="例如 claude（只填可执行文件名，不填整条命令）"
          />
        </label>
        <label className="field-label">
          版本参数
          <input
            className="form-input"
            value={(value.versionArgs ?? ['--version']).join(' ')}
            onChange={(e) => onChange({ ...value, versionArgs: e.target.value.split(/\s+/).filter(Boolean) })}
            placeholder="--version"
          />
        </label>
      </fieldset>
      {value.kind !== 'universal' && (
        <>
          {!!value.extensionIds?.length && (
            <label className="field-label">
              编辑器扩展安装目录
              <textarea
                className="form-input"
                value={(value.extensionRoots ?? []).join('\n')}
                onChange={(e) => onChange({ ...value, extensionRoots: lines(e.target.value) })}
                placeholder="每行一个目录，例如 ~/.vscode/extensions"
              />
            </label>
          )}
          <label className="field-label">
            可执行文件路径
            <textarea
              className="form-input"
              value={(value.executablePaths ?? []).join('\n')}
              onChange={(e) => onChange({ ...value, executablePaths: lines(e.target.value) })}
              placeholder="每行一个绝对路径，例如 ~/.local/bin/my-agent"
            />
          </label>
          {value.kind === 'desktop' && (
            <label className="field-label">
              桌面应用路径
              <textarea
                className="form-input"
                value={(value.appPaths ?? []).join('\n')}
                onChange={(e) => onChange({ ...value, appPaths: lines(e.target.value) })}
                placeholder="/Applications/My Agent.app"
              />
            </label>
          )}
          <p className="field-help">
            保存后可检测安装：查找 PATH、指定路径和常见安装位置，再运行版本命令。Windows 同时支持原生 EXE 和 CLI 启动脚本。
          </p>
        </>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="dialog-footer spread">
        <button className="button subtle" onClick={onCancel}>
          取消
        </button>
        <button className="button primary" disabled={(!builtin && invalid) || saving} onClick={onSave}>
          {saving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}保存 Harness
        </button>
      </div>
    </>
  );
}
