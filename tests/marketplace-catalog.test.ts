import { describe, expect, it, vi } from 'vitest';
import {
  MarketplaceCatalogService,
  marketplaceSkillPageUrl,
  parseSkillsShBoardHtml,
  parseSkillsShBoardPageResponse,
  parseSkillsShSearchResponse,
  parseSkillsmpSearchResponse,
} from '../src/main/marketplace-catalog';

describe('marketplace catalog adapters', () => {
  it('normalizes skills.sh search and marks it as capped instead of pageable', () => {
    const parsed = parseSkillsShSearchResponse(
      JSON.stringify({
        count: 4,
        skills: [
          { source: 'vercel-labs/agent-skills', skillId: 'react-best', name: 'React Best', installs: 123 },
          { source: 'vercel-labs/agent-skills', skillId: 'react-best', name: 'Duplicate', installs: 9 },
          { source: 'https://evil.example/repo', skillId: 'bad', name: 'Bad', installs: 3 },
          { source: 'owner/repo', skillId: '../bad', name: 'Bad Path', installs: 2 },
        ],
      }),
    );
    expect(parsed.skills).toEqual([
      {
        id: 'skills-sh:vercel-labs/agent-skills/react-best',
        source: 'vercel-labs/agent-skills',
        skillId: 'react-best',
        name: 'React Best',
        installs: 123,
        url: 'https://skills.sh/vercel-labs/agent-skills/react-best',
      },
    ]);
    expect(parsed).toMatchObject({ page: 0, pageSize: 200, hasMore: false });
    expect(() => parseSkillsShSearchResponse('{"results":[]}')).toThrow('缺少 skills 列表');
  });

  it('parses legacy Next data and escaped multi-layer Next Flight data as JSON', () => {
    const legacy =
      '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"initialSkills":[{"source":"anthropics/skills","skillId":"frontend-design","name":"Frontend Design","installs":78}]}}}</script>';
    expect(parseSkillsShBoardHtml(legacy).skills[0]).toMatchObject({
      source: 'anthropics/skills',
      skillId: 'frontend-design',
      installs: 78,
    });

    const component = [
      '$',
      '$L55',
      null,
      {
        initialSkills: [
          { source: 'vercel-labs/agent-skills', skillId: 'react-best', name: 'React Best', installs: 42, weeklyInstalls: [1, 2] },
          { source: 'owner/repo', skillId: 'docs-check', name: 'Docs Check', installs: 8 },
        ],
      },
    ];
    const flightText = `4e:${JSON.stringify(component)}`;
    const html = `<script>self.__next_f.push([1,${JSON.stringify(flightText)}])</script>`;
    const parsed = parseSkillsShBoardHtml(html);
    expect(parsed.skills.map((skill) => skill.skillId)).toEqual(['react-best', 'docs-check']);
    expect(() => parseSkillsShBoardHtml('<html><script>self.__next_f.push([1,"bad"])</script></html>')).toThrow(
      '无法从 skills.sh 排行榜页面解析',
    );
  });

  it('parses skills.sh public board page metadata and validates page progress', () => {
    const parsed = parseSkillsShBoardPageResponse(
      JSON.stringify({
        page: 3,
        total: 9829,
        hasMore: true,
        skills: [{ source: 'vercel-labs/skills', skillId: 'find-skills', name: 'Find Skills', installs: 42 }],
      }),
      3,
    );
    expect(parsed).toMatchObject({ page: 3, pageSize: 200, total: 9829, hasMore: true });
    expect(() => parseSkillsShBoardPageResponse(JSON.stringify({ page: 2, total: 9829, hasMore: true, skills: [] }), 3)).toThrow('不一致');
    expect(() => parseSkillsShBoardPageResponse(JSON.stringify({ page: 3, total: 9829, hasMore: true, skills: [] }), 3)).toThrow(
      '没有新技能',
    );
  });

  it('uses max 200 skills.sh search results, caches by query, and rejects fake search pages', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let now = 1_800_000_000_000;
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          skills: [{ source: 'owner/repo', skillId: `skill-${calls.length}`, name: `Skill ${calls.length}`, installs: 10 }],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    };
    const service = new MarketplaceCatalogService({ fetcher, now: () => now, ttlMs: 300_000 });
    const first = await service.get({ query: 'react', marketplaceId: 'skills-sh' });
    const second = await service.get({ query: ' REACT ', marketplaceId: 'skills-sh' });
    expect(first).toMatchObject({ cached: false, page: 0, pageSize: 200, hasMore: false });
    expect(second.cached).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://skills.sh/api/search?q=react&limit=200');
    expect(calls[0].init?.redirect).toBe('manual');
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect((calls[0].init!.headers as Record<string, string>)['user-agent']).toBe('Harness-Manager/0.1');
    await expect(service.get({ query: 'react', page: 1 })).rejects.toThrow('不支持翻页');
    await expect(service.get({ query: 'r' })).rejects.toThrow('至少需要 2 个字符');

    now += 301_000;
    const expired = await service.get({ query: 'react', marketplaceId: 'skills-sh' });
    expect(expired.cached).toBe(false);
    const refreshed = await service.get({ query: 'react', marketplaceId: 'skills-sh', refresh: true });
    expect(refreshed.skills[0].skillId).toBe('skill-3');
    expect(calls).toHaveLength(3);
  });

  it('maps SkillsMP pages by record ID and GitHub skill directory, without converting stars to installs', () => {
    const response = {
      success: true,
      data: {
        skills: [
          {
            id: 'sample-one',
            name: 'Sample One',
            description: 'First result',
            githubUrl: 'https://github.com/acme/skills/tree/main/.agents/skills/sample-one',
            skillUrl: 'https://skillsmp.com/creators/acme/skills/sample-one',
            stars: 99,
          },
          {
            id: 'sample-two',
            name: 'Sample Two',
            githubUrl: 'https://github.com/acme/skills/blob/main/tools/sample-two/SKILL.md',
            skillUrl: 'https://attacker.example/sample-two',
            stars: 50,
          },
          { id: 'common-a', name: 'Common A', githubUrl: 'https://github.com/acme/skills/tree/main/tools/a/common', stars: 5 },
          { id: 'common-b', name: 'Common B', githubUrl: 'https://github.com/acme/skills/tree/main/tools/b/common', stars: 6 },
          { id: 'root-skill', name: 'Root Skill', githubUrl: 'https://github.com/acme/skills/blob/main/SKILL.md', stars: 1 },
          { id: 'unsafe', name: 'Unsafe', githubUrl: 'https://attacker.example/acme/skills/tree/main/bad', stars: 5 },
        ],
        pagination: { page: 2, limit: 50, total: 6, totalIsExact: true, hasNext: true },
      },
    };
    const parsed = parseSkillsmpSearchResponse(JSON.stringify(response), 2);
    expect(parsed).toEqual({
      page: 1,
      pageSize: 50,
      total: 6,
      hasMore: true,
      skills: [
        {
          id: 'skillsmp:sample-one',
          source: 'acme/skills',
          skillId: 'sample-one',
          name: 'Sample One',
          stars: 99,
          description: 'First result',
          url: 'https://skillsmp.com/creators/acme/skills/sample-one',
        },
        { id: 'skillsmp:sample-two', source: 'acme/skills', skillId: 'sample-two', name: 'Sample Two', stars: 50 },
        { id: 'skillsmp:common-a', source: 'acme/skills', skillId: 'common', name: 'Common A', stars: 5 },
        { id: 'skillsmp:common-b', source: 'acme/skills', skillId: 'common', name: 'Common B', stars: 6 },
        { id: 'skillsmp:root-skill', source: 'acme/skills', skillId: 'root-skill', name: 'Root Skill', stars: 1 },
      ],
    });
    expect(parsed.skills[0]).not.toHaveProperty('installs');
    expect(() => parseSkillsmpSearchResponse('{"success":true,"data":{"skills":[],"pagination":{}}}')).toThrow('格式无法识别');
    expect(() =>
      parseSkillsmpSearchResponse(
        JSON.stringify({ success: true, data: { skills: [], pagination: { page: 1, limit: 50, hasNext: true } } }),
      ),
    ).toThrow('没有可识别的新技能');
  });

  it('uses the SkillsMP next page, requires a query, and reports its rate limits', async () => {
    const calls: string[] = [];
    const service = new MarketplaceCatalogService({
      fetcher: async (input) => {
        const requestUrl = new URL(String(input));
        calls.push(requestUrl.href);
        const page = Number(requestUrl.searchParams.get('page'));
        const body = {
          success: true,
          data: {
            skills: [
              { id: `skill-${page}`, name: `Skill ${page}`, githubUrl: `https://github.com/acme/skills/tree/main/skill-${page}`, stars: 1 },
            ],
            pagination: { page, limit: 50, total: 105, hasNext: true },
          },
        };
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      },
    });
    await expect(service.get({ marketplaceId: 'skillsmp' })).rejects.toThrow('仅支持关键词搜索');
    await expect(service.get({ marketplaceId: 'skillsmp', query: 'react', board: 'hot' })).rejects.toThrow('不提供排行榜');
    const first = await service.get({ marketplaceId: 'skillsmp', query: 'react' });
    const second = await service.get({ marketplaceId: 'skillsmp', query: 'react', page: 1 });
    expect(calls).toEqual([
      'https://skillsmp.com/api/v1/skills/search?q=react&limit=50&page=1',
      'https://skillsmp.com/api/v1/skills/search?q=react&limit=50&page=2',
    ]);
    expect(first).toMatchObject({ page: 0, pageSize: 50, total: 105, hasMore: true });
    expect(second.page).toBe(1);
    expect(second.skills[0].id).not.toBe(first.skills[0].id);
    expect(first.skills[0]).not.toHaveProperty('installs');

    const limited = new MarketplaceCatalogService({ fetcher: vi.fn(async () => new Response('', { status: 429 })) });
    await expect(limited.get({ marketplaceId: 'skillsmp', query: 'react' })).rejects.toThrow('10 次/分钟、50 次/天');
    const dailyLimited = new MarketplaceCatalogService({
      fetcher: vi.fn(async () => new Response(JSON.stringify({ code: 'DAILY_QUOTA_EXCEEDED' }), { status: 429 })),
    });
    await expect(dailyLimited.get({ marketplaceId: 'skillsmp', query: 'react' })).rejects.toThrow('次日 UTC 时间恢复');
  });

  it('loads distinct skills.sh board pages and follows only the bounded official HTTPS redirect', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1)
        return new Response(null, { status: 308, headers: { location: 'https://www.skills.sh/api/skills/trending/0' } });
      const page = Number(new URL(String(input)).pathname.split('/').at(-1));
      return new Response(
        JSON.stringify({
          page,
          total: 401,
          hasMore: page < 2,
          skills: [{ source: 'owner/repo', skillId: `one-${page}`, name: `One ${page}`, installs: 1 }],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    };
    const service = new MarketplaceCatalogService({ fetcher });
    const first = await service.get({ board: 'trending' });
    const second = await service.get({ board: 'trending', page: 1 });
    expect(calls.map((call) => call.url)).toEqual([
      'https://skills.sh/api/skills/trending/0',
      'https://www.skills.sh/api/skills/trending/0',
      'https://skills.sh/api/skills/trending/1',
    ]);
    expect(calls.every((call) => (call.init!.headers as Record<string, string>).accept === 'application/json')).toBe(true);
    expect((calls[0].init!.headers as Record<string, string>)['user-agent']).toBe('Harness-Manager/0.1');
    expect(first).toMatchObject({ page: 0, pageSize: 200, total: 401, hasMore: true });
    expect(second.page).toBe(1);
    expect(second.skills[0].skillId).toBe('one-1');

    const unsafeRedirect = new MarketplaceCatalogService({
      fetcher: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/collect' } }),
    });
    await expect(unsafeRedirect.get({ board: 'hot' })).rejects.toThrow('不安全');
  });

  it("opens skill pages only on the marketplace's own HTTPS site", () => {
    expect(marketplaceSkillPageUrl('skills-sh', 'https://skills.sh/owner/repo/skill')).toBe('https://skills.sh/owner/repo/skill');
    expect(marketplaceSkillPageUrl('skillsmp', 'https://skillsmp.com/creators/a/b/c')).toBe('https://skillsmp.com/creators/a/b/c');
    for (const [market, url] of [
      ['skills-sh', 'https://skillsmp.com/creators/a/b/c'],
      ['skillsmp', 'https://skills.sh/owner/repo/skill'],
      ['skills-sh', 'http://skills.sh/owner/repo/skill'],
      ['skills-sh', 'https://user:pass@skills.sh/owner/repo/skill'],
      ['skills-sh', 'https://skills.sh/'],
      ['skills-sh', 'javascript:alert(1)'],
    ] as const) {
      expect(() => marketplaceSkillPageUrl(market, url)).toThrow('没有可打开的');
    }
  });
});
