# 市场数据接入调查

核查日期：2026-09-23。

## skills-manager 的实现

核查版本：[`6ae02e39d9efea0faf75e643b8205f97833a593d`](https://github.com/xingkongliang/skills-manager/tree/6ae02e39d9efea0faf75e643b8205f97833a593d)。

- [`skillssh_api.rs`](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src-tauri/src/core/skillssh_api.rs)：搜索调用 `https://skills.sh/api/search?q=...&limit=...`；榜单读取 `/`、`/trending`、`/hot` 的 HTML，从 Next 数据或嵌入的技能对象提取来源、技能标识、名称和安装量。
- [`InstallSkills.tsx`](https://github.com/xingkongliang/skills-manager/blob/6ae02e39d9efea0faf75e643b8205f97833a593d/src/views/InstallSkills.tsx)：使用自己的 UI 渲染；以 `source` 构造来源筛选，安装调用传入来源仓库和技能标识。市场浏览并不依赖用户跳出应用。

参考实现说明了可行的数据路径；本项目单独实现 TypeScript 解析和界面，不执行远程页面脚本。skills.sh 搜索接口已实测返回 JSON；榜单 HTML 实测约 945 KB，含多层编码的 Next 数据。此网页数据格式不应被视为稳定的版本化 API。

## SkillsMP

[官方 API 文档](https://skillsmp.com/docs/api)提供 `GET /api/v1/skills/search`。匿名关键词搜索已实测 HTTP 200，结果包括名称、描述、`githubUrl`、仓库 Star 与分页信息。

当前文档声明匿名额度为每天 50 次、每分钟 10 次；需要具体关键词，不支持用通配符获得全量列表。它与 skills.sh 的榜单能力不同，也不能将仓库 Star 显示成技能安装量。

## 产品处理

两个内置市场的结果都按 GitHub `owner/repo` 折叠显示。市场返回的是当次榜单或搜索结果，并不保证包含该仓库的全部技能。来源操作进入仓库扫描与现有多选安装确认；单项操作先扫描并筛选。安装仍由中央库服务处理、保留来源信息。

自定义市场网址仍是网站入口。应用内搜索需要已实现的数据适配，不能仅凭一个网址通用抓取所有市场；后续按具体市场接口扩展。

## 分页核查与实现更新

已从 skills.sh 自身网页客户端的加载逻辑确认公开榜单接口为 `/api/skills/{all-time|trending|hot}/{page}`，页码从 0 开始，每页 200 项，返回 `skills`、`total`、`hasMore`、`page`；连续请求不同页得到不同结果。当前实现改用该 JSON 接口，不再只提取首页嵌入的数据。另一个文档中的 `/api/v1/skills` 接口实测匿名请求返回 401，本应用没有假设可用的令牌。

公开 `/api/search?q=...&limit=200` 搜索接口没有可验证的分页字段；不能通过简单添加 page 参数宣称支持翻页。应用标注最多 200 条、建议细化关键词。SkillsMP 使用官方 page 参数（从 1 开始），依据 `data.pagination.hasNext` 拉取后续页。

应用累计显示去重后的仓库和技能数，有可靠总数时另显总量。滚动触发请求并提供手动“加载更多”；失败保留已加载内容，只重试失败页。重复页、无新增结果和页码不一致会停止，避免无限请求。筛选和榜单变更会重置结果并丢弃过期响应。
