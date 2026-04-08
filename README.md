# Instagram Scraper Proxy

用于绕过云函数直连 Instagram 被拒绝（`ECONNREFUSED ...:443`）的问题。

## 1) 启动代理服务

```bash
cd scraper_proxy
npm install
npm start
```

默认端口：`8787`，提供接口：
- `GET /healthz`
- `GET /fetch-instagram-html?username=natgeo`

## 2) 部署到可访问 Instagram 的服务器

建议部署到海外机器（或任意可访问 instagram.com 的网络）。

部署后拿到公网地址，例如：

`https://your-proxy.example.com`

## 3) 配置云函数环境变量

在微信云开发控制台 -> 云函数 `insAgentFunctions` -> 环境变量，新增：

- `SCRAPER_PROXY_BASE_URL` = `https://your-proxy.example.com`

然后重新部署云函数（云端安装依赖）。

## 4) 验证

小程序点击搜索时，云函数将优先调用代理：

`{SCRAPER_PROXY_BASE_URL}/fetch-instagram-html?username=xxx`

若未配置该变量，则回退为云函数直连 Instagram。

