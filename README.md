# droid2api

OpenAI 兼容的本地代理，负责统一转发不同厂商的 LLM 接口请求，并提供多密钥管理、鉴权和观测能力。

## 功能速览
- 统一暴露 `/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/messages` 等 OpenAI 兼容端点。
- 支持单 Key、多个 `FACTORY_API_KEY` 的轮询策略（weighted/simple）以及 402 自动废弃。
- 自适应 OpenAI / Anthropic / Common API 请求与响应格式，流式与非流式均可透明转发。
- 提供 `/status` 仪表盘，用于查看密钥健康度、端点成功率以及废弃 Key 列表。

## 快速开始
1. **安装依赖**
   ```bash
   npm install
   ```
2. **配置 `config.json`（示例）**
   ```json
   {
     "port": 3000,
     "round-robin": "weighted",
     "remove_on_402": true,
     "enable_server_auth": false,
     "models": [
       { "name": "GPT-5", "id": "gpt-5-2025-08-07", "type": "openai", "reasoning": "auto" },
       { "name": "Claude Sonnet 4.5", "id": "claude-sonnet-4-5-20250929", "type": "anthropic", "reasoning": "auto" }
     ]
   }
   ```
   - `enable_server_auth` 可以在文件或环境变量中控制（详见下文）。
   - `round-robin`：`weighted` 基于健康度，`simple` 顺序轮询。
3. **选择上游认证方式（按优先级）**
   - 设置 `FACTORY_API_KEY` 或 `factory_keys.txt`（分号 / 多行支持多个 key）。
   - 设置 `DROID_REFRESH_KEY` 或 `~/.factory/auth.json`。
   - 若不做任何配置，回退到客户端请求头提供的凭据。
4. **启动服务**
   ```bash
   npm start
   ```
5. **验证**
   ```bash
   curl http://localhost:3000/v1/models
   ```

## 服务器访问密钥（enable_server_auth）
- 控制中间件 `serverAuthMiddleware` 是否要求所有请求携带服务器访问密钥。
- 优先级：环境变量 `ENABLE_SERVER_AUTH` > `config.json` 的 `enable_server_auth` > 默认值 `true`。
- 当开关开启时：
  1. 建议在启动前通过环境变量 `SERVER_AUTH_KEY` 配置密钥；如需使用 `/status` 表单首次写入，可在未配置密钥时直接访问该页面提交。
  2. 访问 `GET /status` 会先出现登录表单，输入服务器访问密钥后方可查看详情；若尚未配置密钥，可在该页面直接完成首次设置。
  3. 其他 API 请求需携带 `Authorization: Bearer <server-key>` 才能通过中间件。

- 当开关关闭时，中间件直接放行，不校验服务器密钥。

> 建议：生产环境启用服务器认证，并使用环境变量保存密钥；内网或本地调试可关闭。

## 上游认证与请求头优先级
内部函数 `getApiKey` 会根据当前配置返回需要转发到上游接口的 `Authorization` 头：

1. **服务器内部 Key 池**：`FACTORY_API_KEY`（可分号分隔多个）或 `factory_keys.txt`。
2. **刷新令牌机制**：`DROID_REFRESH_KEY` 或 `~/.factory/auth.json`。
3. **客户端请求头**：按照路由优先级选择。

路由层的头部优先级如下：

| 路由 | 首选头部 | 其次 | 最后 |
|------|----------|------|------|
| `/v1/chat/completions` | `X-Endpoint-Authorization` | `Authorization` | （无） |
| `/v1/responses` | `X-API-Key` | `X-Endpoint-Authorization` | `Authorization` |
| `/v1/messages` | `X-API-Key` | `X-Endpoint-Authorization` | `Authorization` |

转发时会将选出的值写入上游请求的 `Authorization` 头（并根据目标提供商补齐其它必需头）。

### 安全提示
- **开启服务器认证时**：`Authorization` 头通常仅用于携带服务器密钥。若同时需要上游凭据，请使用 `X-Endpoint-Authorization` 或 `X-API-Key`，避免误把服务器密钥转发给上游。
- **`GET /status` 登录表单**：页面不会要求 `Authorization` 头，但会校验输入的服务器密钥，并在浏览器中写入基于密钥摘要的短时 Cookie；请确认部署环境与浏览器的物理安全。
- **关闭服务器认证且未配置内部 Key 时**：客户端的上述头部会直接被转发；如只提供 `Authorization`，它会被用作上游凭据。

## 状态与监控
- `GET /status`：展示当前轮询算法、活跃 Key 成功率、废弃 Key 列表、端点统计。
- `GET /status/balance/:index`、`GET /status/balances`：手动触发额度查询。
- `POST /status/query-keys`：查询临时输入的官方 Key 使用情况。

## 运行与部署
- **本地开发**：`npm start`，默认端口 `3000`。
- **Docker**：
  ```bash
  docker build -t droid2api .
  docker run -d -p 3000:3000 \
    -e ENABLE_SERVER_AUTH=true \
    -e SERVER_AUTH_KEY=your_server_key \
    -e FACTORY_API_KEY="key1;key2" \
    --name droid2api \
    droid2api
  ```
- 常用环境变量：
  - `ENABLE_SERVER_AUTH`：`true`/`false`。
  - `SERVER_AUTH_KEY`：服务器访问密钥。
  - `FACTORY_API_KEY`：单个或多个上游密钥。
  - `DROID_REFRESH_KEY`：刷新令牌。
  - `PORT`、`NODE_ENV`。

## 常见问题
- **如何区分服务器密钥与上游密钥？**  
  服务器密钥用于通过代理自身的校验；上游密钥通过上述优先级体系传入，如果需要与服务器密钥共存，务必使用 `X-Endpoint-Authorization` 或 `X-API-Key` 提供上游凭据。

- **多 Key 轮询如何生效？**  
  设置多个 `FACTORY_API_KEY` 或 `factory_keys.txt` 后，系统会根据 `round-robin` 算法选择 Key，并在配置允许时对 402 响应自动下线失效 Key。

- **推理级别有哪些？**  
  `reasoning` 字段支持 `auto/off/low/medium/high`。Anthropic 模型会据此调整 `thinking` 字段与 `anthropic-beta` 头；OpenAI 模型会调整 `reasoning` 字段。

## 许可证

MIT License
