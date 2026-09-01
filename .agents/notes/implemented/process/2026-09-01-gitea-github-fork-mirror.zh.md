# Agent Note：在 Gitea Actions 中把 fork 的 master 镜像推送到 GitHub fork

Status: implemented

[English](2026-09-01-gitea-github-fork-mirror.md) | 中文

## Problem

fork 的 master 在内网 Gitea 实例上前进：开发提交直接落在上面，`sync-upstream` 定时任务把 `GithubMirror/deepseek-harness` 合入其中。GitHub 一侧的消费者需要同样的内容，而该账号下此前不存在 `deepseek-ai/deepseek-harness` 的 GitHub fork。宿主机的 `gh` CLI 以 `ChanceFlow` 身份登录并持有 `repo` 权限，`dsh-host` Actions runner 以同一用户执行任务，但它的注册地址仍停留在网络迁移前的旧实例地址，因此拉不到任务，所有 `dsh-host` job 都无法调度。

## Decision

`push-to-github.yml` 在 fork master 的每次 push 上运行——无论开发提交还是定时合并——并把 Gitea 的 master 强制推送到 `github.com/ChanceFlow/deepseek-harness`；若 fork 不存在，首次运行时用 `gh repo fork` 从 `deepseek-ai/deepseek-harness` 创建。Gitea 是唯一事实源；该 fork 是纯下游镜像，除本流水线外任何人不写它的 master。

job 选择 `dsh-host` runner 而非容器：已登录的 `gh` CLI、其 git credential helper、runner 配置好的 HTTP(S) 代理都已存在于宿主机，工作流因此不需要任何承载 GitHub token 的 Gitea secret。Gitea 历史携带不能公网化的内部端点（内网 registry URL、宿主路径、个人作者邮箱），因此每次运行把 Gitea `git clone --mirror` 到一次性目录，用 `git filter-repo` 重写（`--replace-text` + `--replace-message` 处理端点与路径，`--mailmap` 处理作者身份），再强制推送重写后的 `master` 与 tags。Gitea 自身历史从不重写，LAN 安装与 npm `gitHead` provenance 因此不受影响；GitHub SHA 与 Gitea SHA 由此有意不同，`DIFF.md` 里的 commit 引用只在 Gitea 侧可解析。fork 的 `pnpm-lock.yaml` 另去掉了两条内网 registry 的 `tarball:` 钉定：干净树上新跑 `pnpm install --frozen-lockfile` 会经 `.npmrc` 的 scope 路由解析这些包，源码树因此不再嵌入任何内网 URL。`push-to-github` concurrency group 串行化运行。pre-push 的 `typecheck` 钩子仍是进入 master 的守卫。

修复 runner 只需改 `.runner` 注册文件里的 `address` 字段：同一份 Gitea 数据库在迁移到现地址后继续沿用，runner token 仍然有效，重启后即成功注册（declare）。

## Alternatives considered

**Gitea 内置 push-mirror。** 一个仓库设置即可转发每次 push，无需 YAML，但其凭据与目标地址都在版本控制之外，审阅和本文都看不到，也无法在 fork 缺失时自动创建。

**容器 job 安装 `gh` 并挂载 `~/.config/gh`。** check.yml 已证明容器 volume 能挂到宿主路径，这条路可行，但每个镜像都要重新复刻宿主机已有的 gh 登录与代理设置，而隔离收益为零——整个操作就是一次 git push。

**把 GitHub PAT 存成 Gitea Actions secret。** 让 job 可以调度进容器，但复制了一份此后必须在两处同步轮换的凭据；宿主机 gh 登录的 scope 与归属已经明确。

**改为就地重写 Gitea 历史（filter-repo + 强推回 Gitea）。** 一次重写可让两侧共享 SHA、镜像逻辑更简单，但每个可达克隆（本 checkout、backup 分支、已发布 `-chance` 构建的 npm `gitHead` provenance）都要重新同步，而且未来的上游合并仍会把未脱敏内容带上唯一重要的那条轴。推送时重写每次只多一个一次性克隆。

**只允许 fast-forward 的推送。** 会拒绝那些在 Gitea master 上非 fast-forward 的上游合并，恰好卡死在 `sync-upstream` 定时任务产出的那类 push 上。

## Consequences

GitHub 现在在一个 Actions 排队延迟内收到 fork master 的每个提交，且不再有第二个发布位置。GitHub 侧仓库是 upstream `deepseek-ai/deepseek-harness` 的公开 fork，其 `master` 镜像 Gitea master；该仓库的 Actions 已禁用，upstream 的 `.github/workflows` 不会在那里执行。GitHub 上的 visibility 切换会不可逆地把仓库从父 fork 网络剥离；恢复 fork 关联只能删库后从父仓库重新 fork——对本镜像安全的前提是脱敏内容可从 Gitea 确定性再生。因此绝不能在 fork 上执行 visibility 切换。镜像的正确性依赖本文件之外的事实：`dsh-host` runner 保持注册且 `gh` 以 `ChanceFlow` 登录；filter-repo 表达式清单与新工作引入的内部标识保持同步（新增的内网主机、路径或 token 形态字符串一旦进入 Gitea 历史，在补进清单之前都会公网可见——防泄漏职责因此落在每次变更上，而不是镜像上）；新的提交元数据不再携带个人作者邮箱（本仓库的 git 身份已切到 `ChanceFlow` 的 noreply 地址，`sync-upstream` 的合并身份一并切换）。对 fork master 不设任何保护——拥有 GitHub 写权限的人推上去的 master 会在下一次 Gitea push 时被覆盖，这正是设定的权威顺序。强制推送语义意味着本地修正一旦推到 Gitea 就立即改写 fork；fork 永不分叉。
