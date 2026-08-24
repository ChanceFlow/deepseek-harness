# npm Registry 使用指南

本仓库的 `@deepseek-ai` 包发布在 Gitea 包仓库（`http://<gitea-host>:3000/api/packages/chanceflow/npm/`）。本文说明如何接入、如何选择与鉴别版本。

## 接入

npm / pnpm / yarn 通用：在 `~/.npmrc` 或项目 `.npmrc` 中加一行 scope 路由。

```ini
@deepseek-ai:registry=http://<gitea-host>:3000/api/packages/chanceflow/npm/
```

此后 `@deepseek-ai/*` 包全部从该 registry 解析，其余包走各自默认源。registry 支持匿名读取；若访问被要求认证，在 Gitea（Settings → Applications）生成带 `read:package` 权限的 token 并追加一行。

```ini
//<gitea-host>:3000/api/packages/chanceflow/npm/:_authToken=<token>
```

## 版本命名

| 形态 | 含义 |
|---|---|
| `0.1.0-rc.N` | 上游官方发布 |
| `0.1.0-rc.N-chance.M` | 本仓库的 fork 构建：base 为上游 `rc.N`，`M` 为 fork 迭代号 |

两类版本并存于同一 registry。`latest` dist-tag 始终指向当前推荐的 fork 构建。

```sh
$ npm view @deepseek-ai/dsh dist-tags --registry=http://<gitea-host>:3000/api/packages/chanceflow/npm/
{ next: '0.1.0-rc.8-chance.1', latest: '0.1.0-rc.8-chance.1' }
```

## 安装

```sh
# 跟随推荐版
npm install -g @deepseek-ai/dsh

# 精确钉版（可复现，生产推荐）
npm install -g @deepseek-ai/dsh@0.1.0-rc.8-chance.1
```

避免 `^` / `~` 宽范围：registry 同时收录上游官方版与 fork 构建，范围解析可能混入不含 fork 修复的上游版本，造成难以排查的不一致。用 dist-tag 或精确版本号。

## 鉴别与验证

```sh
# 已安装版本
dsh --version

# 查询某版本的完整性指纹与下载地址
npm view @deepseek-ai/dsh@0.1.0-rc.8-chance.1 dist.integrity dist.tarball \
  --registry=http://<gitea-host>:3000/api/packages/chanceflow/npm/

# 浏览器查看全部版本与文件清单
http://<gitea-host>:3000/chanceflow/-/packages
```

安装时 npm 自动校验 tarball 的 sha512 与 registry 记录的 `dist.integrity` 一致，传输篡改会直接报错；选对版本（dist-tag 或精确号）是使用者的主要鉴别动作。
