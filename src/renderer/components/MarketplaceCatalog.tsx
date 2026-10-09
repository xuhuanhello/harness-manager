import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Flame, Github, LoaderCircle, RefreshCw, Search, ShieldCheck, Star, TrendingUp, X } from 'lucide-react';
import type {
  Marketplace,
  MarketplaceCatalog as MarketplaceCatalogResult,
  MarketplaceCatalogRequest,
  MarketplaceSkill as MarketplaceCatalogSkill,
} from '../../shared/types';
import ListActions from './ListActions';
import '../marketplace-pagination.css';

export type CatalogMarketplaceId = 'skills-sh' | 'skillsmp';
export type CatalogBoard = 'all-time' | 'trending' | 'hot';

type Props = {
  marketplace: Marketplace;
  input: string;
  onInput: (value: string) => void;
  actionError: string;
  onOpen: () => void;
  /** Opens a skill's page on the marketplace website; rows without a page show no button. */
  onOpenSkill: (url: string) => void;
  opening: boolean;
  loadCatalog: (request: MarketplaceCatalogRequest) => Promise<MarketplaceCatalogResult>;
  onImportSkill: (source: string, skillId: string) => void;
  onImportSource: (source: string) => void;
};

const boardItems: { id: CatalogBoard; label: string; icon: typeof TrendingUp }[] = [
  { id: 'all-time', label: '全部', icon: Star },
  { id: 'trending', label: '趋势', icon: TrendingUp },
  { id: 'hot', label: '热门', icon: Flame },
];
const MAX_CATALOG_PAGES = 100;

function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/[\u3400-\u9fff]/.test(message)) return message;
  if (/429|rate.?limit|too many|频繁|限流/i.test(message)) return '请求过于频繁，请稍后再试。';
  if (/network|fetch|timeout|offline|econn|socket|connect|网络|连接/i.test(message)) return '无法连接技能目录，请检查网络后重试。';
  return '技能目录加载失败，请重试。';
}

function compactNumber(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function repositoryName(value: string) {
  const source = value.trim();
  if (!source) return '未知仓库';
  try {
    if (/^https?:\/\//i.test(source)) {
      const url = new URL(source);
      if (url.hostname.toLocaleLowerCase() === 'github.com') {
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length >= 2) return `${parts[0]}/${parts[1].replace(/\.git$/i, '')}`;
      }
    }
  } catch {
    /* Keep the original source label when a response has an unusual URL. */
  }
  const parts = source
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : source;
}

function repositoryGroups(skills: MarketplaceCatalogSkill[]) {
  const groups = new Map<string, { source: string; skills: MarketplaceCatalogSkill[] }>();
  for (const skill of skills) {
    const source = repositoryName(skill.source);
    const key = source.toLocaleLowerCase('en-US');
    const group = groups.get(key) ?? { source, skills: [] };
    group.skills.push(skill);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function skillKey(skill: MarketplaceCatalogSkill) {
  return `${skill.source.trim().toLocaleLowerCase('en-US')}\u0000${skill.skillId.trim().toLocaleLowerCase('en-US')}`;
}

function catalogDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

export default function MarketplaceCatalog({
  marketplace,
  input,
  onInput,
  actionError,
  onOpen,
  onOpenSkill,
  opening,
  loadCatalog,
  onImportSkill,
  onImportSource,
}: Props) {
  const marketplaceId = marketplace.id as CatalogMarketplaceId;
  const isSkillsMp = marketplaceId === 'skillsmp';
  const [board, setBoard] = useState<CatalogBoard>('all-time');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [catalog, setCatalog] = useState<MarketplaceCatalogResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [pageError, setPageError] = useState('');
  const [pagingStopped, setPagingStopped] = useState('');
  const [requestRevision, setRequestRevision] = useState(0);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [expandedSearchGroups, setExpandedSearchGroups] = useState<Record<string, boolean>>({});
  const requestId = useRef(0);
  const nextPage = useRef(0);
  const loadedPages = useRef(0);
  const inFlightPage = useRef<number | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const autoLoadArmed = useRef(true);

  const fetchCatalog = useCallback(
    async (query: string, selectedBoard: CatalogBoard, refresh = false) => {
      const currentRequest = ++requestId.current;
      nextPage.current = 0;
      loadedPages.current = 0;
      inFlightPage.current = null;
      autoLoadArmed.current = true;
      setLoading(true);
      setLoadingMore(false);
      setError('');
      setPageError('');
      setPagingStopped('');
      setCatalog(null);
      try {
        const result = await loadCatalog({
          marketplaceId,
          ...(query.trim() ? { query: query.trim() } : {}),
          ...(!isSkillsMp ? { board: selectedBoard } : {}),
          page: 0,
          ...(refresh ? { refresh: true } : {}),
        });
        if (currentRequest !== requestId.current) return;
        setCatalog(result);
        nextPage.current = result.page + 1;
        loadedPages.current = 1;
        if (result.hasMore && result.page >= MAX_CATALOG_PAGES - 1) {
          setPagingStopped(`最多加载 ${MAX_CATALOG_PAGES} 页，已停止自动请求。`);
        }
      } catch (cause) {
        if (currentRequest !== requestId.current) return;
        setError(errorText(cause));
      } finally {
        if (currentRequest === requestId.current) setLoading(false);
      }
    },
    [isSkillsMp, loadCatalog, marketplaceId],
  );

  const clearCatalog = () => {
    requestId.current += 1;
    nextPage.current = 0;
    loadedPages.current = 0;
    inFlightPage.current = null;
    autoLoadArmed.current = true;
    setCatalog(null);
    setError('');
    setPageError('');
    setPagingStopped('');
    setLoading(false);
    setLoadingMore(false);
  };

  const loadNextPage = useCallback(
    async (refresh = false) => {
      const currentCatalog = catalog;
      const page = nextPage.current;
      const currentRequest = requestId.current;
      if (!currentCatalog?.hasMore || loading || loadingMore || error || pagingStopped || inFlightPage.current !== null) return;
      if (page >= MAX_CATALOG_PAGES) {
        setPagingStopped(`最多加载 ${MAX_CATALOG_PAGES} 页，已停止自动请求。`);
        return;
      }
      inFlightPage.current = page;
      setLoadingMore(true);
      setPageError('');
      try {
        const result = await loadCatalog({
          marketplaceId,
          ...(submittedQuery.trim() ? { query: submittedQuery.trim() } : {}),
          ...(!isSkillsMp ? { board } : {}),
          page,
          ...(refresh ? { refresh: true } : {}),
        });
        if (currentRequest !== requestId.current) return;
        if (result.page !== page) throw new Error('技能目录返回了与请求页码不一致的结果，请重试。');
        const existing = new Set(currentCatalog.skills.map(skillKey));
        const additions: MarketplaceCatalogSkill[] = [];
        for (const skill of result.skills) {
          const key = skillKey(skill);
          if (existing.has(key)) continue;
          existing.add(key);
          additions.push(skill);
        }
        nextPage.current = result.page + 1;
        loadedPages.current += 1;
        if (!additions.length && result.hasMore) {
          setPagingStopped('下一页没有提供新技能，已停止自动加载。');
          return;
        }
        setCatalog((current) =>
          current
            ? {
                ...result,
                skills: [...current.skills, ...additions],
              }
            : current,
        );
        if (result.hasMore && (result.page >= MAX_CATALOG_PAGES - 1 || loadedPages.current >= MAX_CATALOG_PAGES)) {
          setPagingStopped(`最多加载 ${MAX_CATALOG_PAGES} 页，已停止自动请求。`);
        }
      } catch (cause) {
        if (currentRequest === requestId.current) setPageError(errorText(cause));
      } finally {
        if (currentRequest === requestId.current) {
          if (inFlightPage.current === page) inFlightPage.current = null;
          setLoadingMore(false);
        }
      }
    },
    [board, catalog, error, isSkillsMp, loadCatalog, loading, loadingMore, marketplaceId, pagingStopped, submittedQuery],
  );

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (
      !sentinel ||
      !catalog?.hasMore ||
      loading ||
      loadingMore ||
      error ||
      pageError ||
      pagingStopped ||
      typeof IntersectionObserver === 'undefined'
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            autoLoadArmed.current = true;
          } else if (autoLoadArmed.current) {
            autoLoadArmed.current = false;
            void loadNextPage();
          }
        }
      },
      { rootMargin: '280px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [catalog?.hasMore, error, loadNextPage, loading, loadingMore, pageError, pagingStopped]);

  useEffect(() => {
    if (isSkillsMp && !submittedQuery.trim()) {
      requestId.current += 1;
      nextPage.current = 0;
      loadedPages.current = 0;
      inFlightPage.current = null;
      autoLoadArmed.current = true;
      setCatalog(null);
      setError('');
      setPageError('');
      setPagingStopped('');
      setLoading(false);
      setLoadingMore(false);
      return;
    }
    void fetchCatalog(submittedQuery, board);
    return () => {
      requestId.current += 1;
    };
  }, [board, fetchCatalog, isSkillsMp, requestRevision, submittedQuery]);

  const groups = useMemo(() => repositoryGroups(catalog?.skills ?? []), [catalog?.skills]);

  const searchGroupKey = (source: string) => `${submittedQuery.trim().toLocaleLowerCase()}\u0000${source}`;
  const isGroupExpanded = (source: string) =>
    submittedQuery.trim() ? (expandedSearchGroups[searchGroupKey(source)] ?? true) : (expandedGroups[source] ?? false);
  const toggleGroup = (source: string) => {
    const expanded = isGroupExpanded(source);
    if (submittedQuery.trim()) setExpandedSearchGroups((current) => ({ ...current, [searchGroupKey(source)]: !expanded }));
    else setExpandedGroups((current) => ({ ...current, [source]: !expanded }));
  };
  const allGroupsExpanded = groups.length > 0 && groups.every((group) => isGroupExpanded(group.source));
  const toggleAllGroups = () => {
    const expand = !allGroupsExpanded;
    if (submittedQuery.trim())
      setExpandedSearchGroups((current) => {
        const next = { ...current };
        for (const group of groups) next[searchGroupKey(group.source)] = expand;
        return next;
      });
    else
      setExpandedGroups((current) => {
        const next = { ...current };
        for (const group of groups) next[group.source] = expand;
        return next;
      });
  };

  const runSearch = (rawQuery: string) => {
    const query = rawQuery.trim();
    if (isSkillsMp && !query) return;
    clearCatalog();
    onInput(query);
    if (query === submittedQuery) setRequestRevision((revision) => revision + 1);
    else setSubmittedQuery(query);
  };

  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    runSearch(input);
  };

  const retry = () => {
    if (isSkillsMp && !submittedQuery.trim()) return;
    void fetchCatalog(submittedQuery, board, true);
  };

  return (
    <div className="marketplace-page marketplace-catalog-page" data-testid="marketplace-catalog">
      <section className="marketplace-card marketplace-catalog-card">
        <div className="marketplace-card-heading catalog-card-heading">
          <div className="marketplace-mark">
            <Search size={19} />
          </div>
          <div>
            <p className="eyebrow">{isSkillsMp ? 'SKILLSMP CATALOG' : 'SKILLS.SH CATALOG'}</p>
            <h2>{marketplace.name} 技能目录</h2>
            <span>{isSkillsMp ? '按关键词搜索技能，并按仓库选择导入' : '浏览榜单并按 GitHub 仓库选择导入'}</span>
          </div>
          <button className="button subtle catalog-open-site" disabled={opening} onClick={onOpen}>
            {opening ? <LoaderCircle size={14} className="spin" /> : <ExternalLink size={14} />}打开网站
          </button>
        </div>
        {actionError && (
          <div className="form-error catalog-action-error">
            <span>{actionError}</span>
          </div>
        )}

        <div className="catalog-toolbar">
          {!isSkillsMp && (
            <div className="catalog-board-tabs" role="tablist" aria-label="技能榜单">
              {boardItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    type="button"
                    key={item.id}
                    role="tab"
                    aria-selected={board === item.id}
                    className={board === item.id ? 'active' : ''}
                    data-testid={`marketplace-catalog-tab-${item.id}`}
                    onClick={() => {
                      const clearingSearch = !!submittedQuery || !!input;
                      if (item.id === board && !clearingSearch) return;
                      clearCatalog();
                      if (clearingSearch) {
                        setSubmittedQuery('');
                        onInput('');
                      }
                      if (item.id === board) setRequestRevision((revision) => revision + 1);
                      setBoard(item.id);
                    }}
                  >
                    <Icon size={14} />
                    {item.label}
                  </button>
                );
              })}
            </div>
          )}
          <form className={`catalog-search ${isSkillsMp ? 'catalog-search-only' : ''}`} onSubmit={submitSearch}>
            <Search size={15} />
            <input
              aria-label="搜索市场技能"
              value={input}
              onChange={(event) => onInput(event.target.value)}
              placeholder={isSkillsMp ? '输入技能名称或关键词…' : '搜索技能或 GitHub 仓库…'}
            />
            {!!input && (
              <button type="button" className="catalog-clear-search" aria-label="清除搜索" onClick={() => onInput('')}>
                <X size={13} />
              </button>
            )}
            <button
              className="button primary compact"
              type="submit"
              disabled={loading || (isSkillsMp && !input.trim())}
              data-testid="marketplace-catalog-search"
            >
              {loading ? <LoaderCircle size={13} className="spin" /> : <Search size={13} />}搜索
            </button>
          </form>
        </div>

        <div className="catalog-context-note">
          <ShieldCheck size={14} />
          <span>
            {isSkillsMp
              ? '搜索来自 SkillsMP；输入时不会自动请求。每组统计当前搜索结果，可能不是仓库中的全部技能。'
              : submittedQuery
                ? 'skills.sh 搜索接口最多返回 200 条且不支持翻页；结果按来源仓库分组。'
                : '技能按来源仓库分组。每组显示当前获取到的技能数；这些结果不代表仓库中的全部技能。'}
          </span>
        </div>

        <div className="catalog-result-toolbar">
          <div className="catalog-result-status" aria-live="polite">
            {loading ? (
              <>
                <LoaderCircle size={13} className="spin" />
                {isSkillsMp ? '正在搜索 SkillsMP…' : '正在加载技能榜单…'}
              </>
            ) : catalog ? (
              <>
                <span>
                  {catalog.cached ? '缓存结果' : '已更新'}
                  {catalogDate(catalog.fetchedAt) ? ` · ${catalogDate(catalog.fetchedAt)}` : ''}
                </span>
                {catalog.hasMore && !pagingStopped && <span className="catalog-more-note">向下滚动加载后续页</span>}
                {!catalog.hasMore && !!catalog.skills.length && (
                  <span className="catalog-more-note">
                    {submittedQuery && !isSkillsMp
                      ? '搜索接口最多返回 200 条，缩小关键词可查看更多匹配项'
                      : isSkillsMp
                        ? '已到当前搜索结果末尾'
                        : '已到当前榜单末尾'}
                  </span>
                )}
              </>
            ) : isSkillsMp && !submittedQuery ? (
              <span>输入关键词开始搜索</span>
            ) : null}
          </div>
          <div className="catalog-result-actions">
            {catalog && (
              <span
                className="catalog-counts"
                data-testid="marketplace-counts"
                data-loaded-skills={catalog.skills.length}
                data-loaded-repositories={groups.length}
              >
                {groups.length} 个仓库 · {catalog.skills.length} 个技能已加载
                {catalog.total !== undefined && catalog.total > catalog.skills.length
                  ? ` · 共 ${catalog.total.toLocaleString()} 个技能`
                  : ''}
              </span>
            )}
            <ListActions allExpanded={allGroupsExpanded} onToggleExpanded={toggleAllGroups} expandableCount={groups.length} />
            {(!isSkillsMp || !!submittedQuery) && (
              <button
                className="text-button catalog-refresh"
                type="button"
                onClick={retry}
                disabled={loading}
                data-testid="marketplace-catalog-refresh"
              >
                <RefreshCw size={13} />
                刷新
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="catalog-error" role="alert">
            <div>
              <strong>暂时无法加载技能目录</strong>
              <span>{error}</span>
            </div>
            <button className="button subtle compact" onClick={retry} disabled={loading} data-testid="marketplace-catalog-retry">
              <RefreshCw size={13} />
              重试
            </button>
          </div>
        )}

        {pageError && (
          <div className="catalog-error catalog-page-error" role="alert">
            <div>
              <strong>后续页加载失败</strong>
              <span>{pageError}</span>
            </div>
            <button
              className="button subtle compact"
              onClick={() => void loadNextPage(true)}
              disabled={loadingMore}
              data-testid="marketplace-catalog-page-retry"
            >
              <RefreshCw size={13} />
              重试此页
            </button>
          </div>
        )}

        {loading && (
          <div className="catalog-state">
            <LoaderCircle size={21} className="spin" />
            <strong>{isSkillsMp ? '正在搜索 SkillsMP…' : '正在加载技能榜单…'}</strong>
            <span>正在获取最新目录结果。</span>
          </div>
        )}

        {!loading && !error && isSkillsMp && !submittedQuery && (
          <div className="catalog-state catalog-start-search">
            <div className="catalog-state-icon">
              <Search size={19} />
            </div>
            <strong>搜索 SkillsMP 技能</strong>
            <span>输入关键词后点击“搜索”或按 Enter。也可以试试这些关键词：</span>
            <div className="catalog-query-examples">
              {['react', 'testing', 'design'].map((query) => (
                <button type="button" key={query} onClick={() => runSearch(query)}>
                  {query}
                </button>
              ))}
            </div>
          </div>
        )}

        {!loading && !error && !!catalog && groups.length === 0 && (
          <div className="catalog-state catalog-empty-results">
            <div className="catalog-state-icon">
              <Search size={19} />
            </div>
            <strong>{submittedQuery ? '没有找到匹配的技能' : '暂时没有可显示的技能'}</strong>
            <span>{submittedQuery ? '试试其他关键词，或刷新目录。' : '刷新后重新获取技能目录。'}</span>
          </div>
        )}

        {!loading && !error && groups.length > 0 && (
          <div className="catalog-groups">
            {groups.map((group) => (
              <details
                className="catalog-source-group"
                data-testid="marketplace-source-group"
                data-source={group.source}
                key={`${submittedQuery}:${group.source}`}
                open={isGroupExpanded(group.source)}
              >
                <summary
                  className="catalog-source-heading"
                  onClick={(event) => {
                    event.preventDefault();
                    toggleGroup(group.source);
                  }}
                >
                  <span className="catalog-repo-icon">
                    <Github size={15} />
                  </span>
                  <span className="catalog-repo-copy">
                    <strong>{group.source}</strong>
                    <small>当前结果已获取 {group.skills.length} 个技能</small>
                  </span>
                  <button
                    className="button subtle compact catalog-import-repo"
                    type="button"
                    aria-label={`扫描仓库并选择安装 ${group.source}`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onImportSource(group.source);
                    }}
                  >
                    <Search size={13} />
                    扫描仓库并选择安装
                  </button>
                </summary>
                <div className="catalog-skill-list">
                  {group.skills.map((skill) => (
                    <article className="catalog-skill-row" data-testid="marketplace-skill-row" data-skill-id={skill.skillId} key={skill.id}>
                      <div className="catalog-skill-copy">
                        <strong>{skill.name}</strong>
                        {skill.description && <p>{skill.description}</p>}
                        <div className="catalog-skill-meta">
                          <code>{skill.skillId}</code>
                          {isSkillsMp ? (
                            <span>
                              <Star size={12} />
                              {compactNumber(skill.stars)} 仓库 Star
                            </span>
                          ) : (
                            <span>
                              <TrendingUp size={12} />
                              {compactNumber(skill.installs)} 次安装
                            </span>
                          )}
                        </div>
                      </div>
                      {skill.url && (
                        <button
                          className="button subtle compact catalog-open-skill"
                          type="button"
                          aria-label={`在网页中打开 ${skill.name}`}
                          onClick={() => onOpenSkill(skill.url!)}
                        >
                          <ExternalLink size={13} />
                          在网页中打开
                        </button>
                      )}
                      <button
                        className="button subtle compact catalog-import-skill"
                        type="button"
                        aria-label={`选择安装 ${skill.name}`}
                        onClick={() => onImportSkill(group.source, skill.skillId)}
                      >
                        <Search size={13} />
                        选择安装
                      </button>
                    </article>
                  ))}
                </div>
              </details>
            ))}
          </div>
        )}

        {!loading && !error && catalog && groups.length > 0 && catalog.hasMore && !pagingStopped && (
          <div className="catalog-pagination" data-testid="marketplace-pagination">
            <div ref={sentinelRef} className="catalog-scroll-sentinel" data-testid="marketplace-scroll-sentinel" aria-hidden="true" />
            {loadingMore ? (
              <span className="catalog-pagination-status">
                <LoaderCircle size={14} className="spin" />
                正在加载下一页…
              </span>
            ) : (
              <button
                className="button subtle compact"
                type="button"
                onClick={() => void loadNextPage()}
                data-testid="marketplace-load-more"
              >
                <RefreshCw size={13} />
                加载更多
              </button>
            )}
          </div>
        )}
        {pagingStopped && catalog && (
          <div className="catalog-pagination-stop" role="status">
            {pagingStopped}
          </div>
        )}
      </section>

      <div className="marketplace-safety-note">
        <ShieldCheck size={15} />
        <span>选择技能后会先扫描仓库并展示候选列表，只有你在确认后才会导入中央库。</span>
      </div>
    </div>
  );
}
