# 上游同步 / 合并流程（二次开发用）

本仓库是 `ddcat-ai/open-ai-canvas`（影策）的二次开发分支。为方便长期跟进上游，采用「`main` 镜像上游 + `custom` 放自己的改动」的分支模型。

## 远程与分支

| 名称 | 作用 |
| --- | --- |
| `origin` | 自己的 fork：`yueguang2/open-ai-canvas` |
| `upstream` | 上游原仓库：`ddcat-ai/open-ai-canvas` |
| `main` | **干净镜像**，始终对齐 `upstream/main`，不放自己的改动；跟踪 `upstream/main` |
| `custom` | 二次开发分支，所有自定义改动都在这里；跟踪 `origin/custom` |

日常开发都在 `custom`。不要直接在 `main` 上改。

## 上游更新后的合并步骤（标准操作）

```bash
cd 无限画布

# 1) 拉取上游
git fetch upstream

# 2) 更新 main，使其等于上游
git switch main
git merge upstream/main          # 一般直接快进
git push origin main             # 同步到 fork

# 3) 把上游改动并入 custom，在这里解决冲突
git switch custom
git merge main
#   —— 解决冲突、跑构建/测试 ——
git push origin custom
```

如果第 3 步很干净、想保持线性历史，也可以改用 `git rebase main`（会改写 custom 的提交，需要 `git push --force-with-lease origin custom`；单人使用没问题）。

## 冲突处理原则

- 冲突几乎只会在 `custom` 分支出现，不影响 `main` 镜像。
- 这个项目明确「不保留旧接口兼容层、接口会变」，所以合并后通常还要**手动适配**自己的改动（模型渠道、画布、前端契约等），不是纯自动合并。
- 自己改动越集中在「新增文件 / 插件 / 薄封装」，冲突越少；尽量少改上游核心文件：
  - `web/vite.config.ts`（可能和上游冲突）
  - `backend/internal/app/**`、`backend/internal/handler/**`
  - `web/src/services/api/**`、`web/src/pages/**`
- 解决冲突后至少验证：`cd web && bun run build`；`cd backend && go test ./...`（按改动范围取舍）。

## 自己的改动清单（custom 相对上游）

- `scripts/start-local-magpie.sh`：本地一键启动后端(SQLite)+前端预览
- `scripts/configure-local-magpie.mjs`：注册管理员、创建「本机 Magpie」渠道、标注文本能力、生成前台逻辑模型
- `web/vite.config.ts`：为 `vite preview` 增加 `/api` 代理
- `LOCAL-MAGPIE.md`、`UPSTREAM-SYNC.md`：本地运行与同步说明

## 回滚 / 备份

- 给可用版本打标签，例如：`git tag v1.8.2-custom.1 && git push origin v1.8.2-custom.1`
- 合并前若想保险，可先 `git branch custom-backup-<日期>` 留一个指针。

## 回馈上游 / PR 约定

- 后续遇到 **bug 修复** 或 **可通用化的改善项** 时，修改完成先**询问主人是否需要向上游提 PR**，不要擅自创建 PR。
- 仅属于本地/部署集成、或依赖我们私有环境的改动（本地启动脚本、私有渠道配置等）默认不提 PR。
- 提 PR 前仍遵循本文件的验证要求，并在 `custom` 完成验证后再从独立分支向上游发起。
