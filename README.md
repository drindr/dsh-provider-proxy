# provider-proxy

dsh 插件：**只让指定的 provider 走 HTTP(S) 代理**，并提供一个 Settings UI 让用户自己配置。

- Host 侧：包装 `globalThis.fetch`，只对配置里启用的 provider host 注入 `undici.ProxyAgent`，其他请求全部直连。
- Client 侧：在 dsh 设置里新增 **Provider Proxy** 页面，编辑 `provider-proxy` settings namespace。
- 配置文件：写入 dsh 标准 settings 文档（默认 `~/.dsh/settings.yaml`），不是散落的单独文件。
- 默认值：内置一个默认禁用规则 `openai -> api.openai.com`，用户只需在 UI 里勾选 Enabled 并填代理地址。

## 安装

在 `~/.dsh/plugins` 下建立 symlink（或按本仓库通用插件安装方式）：

```bash
PLUGIN_SRC=/path/to/dsh-plugin
mkdir -p "$HOME/.dsh/plugins/@dsh-external"
ln -s "$PLUGIN_SRC/provider-proxy" "$HOME/.dsh/plugins/provider-proxy"
```

在 `~/.dsh/profiles/web/package.json` 的 dependencies 中加入：

```json
"provider-proxy": "link:<REPO>/provider-proxy"
```

在 `~/.dsh/profiles/web/cordis.patch.yml` 中加入：

```yaml
- insert:
    - id: provider-proxy
      name: provider-proxy
```

然后 `pnpm install` 并重启 `dsh web`。

## 配置

### 通过 Settings UI

1. 打开 dsh Web 设置。
2. 左侧选择 **Provider Proxy**。
3. 默认会看到 `openai` 规则，host 为 `api.openai.com`。
4. 勾选 **Enabled**，填上代理地址，例如 `http://127.0.0.1:7890`。
5. 保存。

### 直接改配置文件

等价地，也可以直接编辑 `~/.dsh/settings.yaml`：

```yaml
provider-proxy:
  providers:
    openai:
      enabled: true
      proxyUrl: http://127.0.0.1:7890
      hosts:
        - api.openai.com
```

其他 provider 不配置/不启用就不会走代理。

## 说明

- 代理 URL 只支持 `http://` 和 `https://`；SOCKS/PAC 请先转换成本地 HTTP(S) 代理或使用支持 SOCKS 的转发层。
- 该插件是针对“dsh/pi-ai 的 OpenAI SDK 路径不会自动读取全局 `HTTPS_PROXY`”这一现状的补充。如果你已经有 OpenAI 兼容中转/网关，也可以直接在 `llm-pi-ai.providers.<name>.baseURL` 里指过去，不一定要用本插件。
