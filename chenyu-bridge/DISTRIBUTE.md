# 晨羽桥接（Chenyu Bridge）· 独立部署说明

这是一个**可独立运行的中间件**：把「晨羽智云 Pod + ComfyUI 工作流」包装成 HTTP 服务，自带管理控制台。
**只需要这一个容器**，不需要影策或其它后端即可使用（也可作为影策的系统渠道接入）。

---

## 1. 运行

```bash
docker run -d --name chenyu-bridge \
  -p 3400:3400 \
  -v /你的数据目录:/app/data \
  --restart unless-stopped \
  chenyu-bridge:latest
```

可选环境变量：
| 变量 | 说明 |
| --- | --- |
| `BRIDGE_ADMIN_TOKEN` | 管理口令；设置后 `/api/bridge/*` 与开关机需口令。建议公网部署时设置 |
| `BRIDGE_API_KEY` | 业务接口密钥；设置后 `/v1/*` 需 `Authorization: Bearer` 或 `x-api-key`，为空则开放。公网暴露时建议设置 |
| `CHENYU_API_KEY` | 晨羽 API Key；也可不设，启动后在后台「设置」里填 |
| `BRIDGE_PUBLIC_BASE` | 对外访问地址（如 `http://你的域名:3400`），用于返回产物链接 |
| `BRIDGE_PORT` | 默认 3400 |

> 数据（`settings.json`、`presets.json`、上传的工作流、产物）都在 `/app/data`，**务必挂载卷**，重建容器不丢。

## 2. 首次配置（全部在网页完成）

打开 `http://<主机>:3400/`（或 `/admin`）：

1. **设置** → 填「晨羽 API Key」→ 保存
2. **工作流** → 「+ 新增工作流」：
   - 从晨羽 Pod 列表选择（自动填 UUID/Tag），或手动填 Pod UUID；
   - 点「选择文件」上传该 Pod 的 ComfyUI 工作流 `.api.json` → **自动解析**输出节点与字段映射；
   - 保存
3. **任务** → 「测试生成」发一条，确认能出图/出视频
4. **接入** → 复制服务地址与接口示例，给到你的客户端

## 3. 接口（无需鉴权）

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/v1/models` | GET | 模型列表（`预设@GPU`） |
| `/v1/images/generations` | POST | 图片生成（OpenAI Images 兼容），返回 `data[].url` |
| `/v1/videos` | POST | 提交视频任务（异步），返回 `id` |
| `/v1/videos/{id}` | GET | 查询视频任务，返回 `status` / `video_url` |
| `/files/{name}` | GET | 获取产物文件 |
| `/healthz` | GET | 存活检查（容器用，始终 200） |
| `/healthz/ready` | GET | 就绪检查（校验 API Key 与晨羽余额；未就绪返回 503） |

示例：
```bash
BASE=http://127.0.0.1:3400

# 图片
curl -s $BASE/v1/images/generations -H 'content-type: application/json' \
  -d '{"model":"moss@4080","prompt":"一只柴犬，纯色背景","aspect_ratio":"16:9","megapixels":3}'

# 视频（异步）
ID=$(curl -s $BASE/v1/videos -H 'content-type: application/json' \
  -d '{"model":"h3@4080","input":{"prompt":"镜头缓慢推进"},"parameters":{"ratio":"16:9","duration":6}}' | sed -E 's/.*"id":"([^"]+)".*/\1/')
curl -s $BASE/v1/videos/$ID
```

## 4. 安全与费用

- 业务接口（`/v1/*`、`/files`、`/healthz`）默认无鉴权，**请只在内网使用或加反向代理鉴权**。
- 管理后台涉及开关机与配置，**公网务必设置 `BRIDGE_ADMIN_TOKEN`**。
- 生成会真实消耗晨羽 GPU 资源并计费；后台可设「每日预算」「最低余额」「预算保护」防止超支。
- 任务结束无排队时会**立即关机**停止计费；有排队任务时复用实例。

## 5. 稳定性与防护（内置）

- **重启恢复**：服务重启后，之前未完成（running/pending）的任务会标记为失败并附带原因，影策轮询能及时拿到失败，不会一直“进行中”。
- **幂等去重**：视频/图片提交支持 `Idempotency-Key` 请求头（或 body 里 `idempotencyKey`）；同一请求在 15 分钟内重复提交会复用原任务/结果，避免超时重试导致重复开机计费。
- **限流与队列上限**：默认每分钟最多 60 次提交、同时进行/排队任务最多 30 个，超限返回 429。可用环境变量 `BRIDGE_RATE_PER_MIN`、`BRIDGE_MAX_QUEUE` 调整。
- **快速失败**：晨羽开机接口报错立即返回；开机中又回到关机、或 90 秒迟迟起不来，会尽快判定开机失败并把原因回给调用方。
- **图片冷启动预热**：管理后台「任务 → 预热实例」可先开机，避免同步图片接口在冷启动时超时（预热后空闲会按策略关机）。
