# Dedalix Desktop Client

基于 Electron 的 Dedalix 协作平台桌面客户端。

## 功能特性

- **自定义协议**: 注册 `dedalix://` 协议，支持从浏览器深度链接唤起
- **单实例锁**: 确保同时只运行一个应用实例
- **窗口状态持久化**: 记住窗口位置和大小
- **系统托盘**: 支持最小化到系统托盘
- **跨平台**: 支持 macOS、Windows、Linux
- **User-Agent 标识**: 自定义 UA 包含 `Dedalix/` 前缀，前端可检测客户端环境

## 开发

```bash
# 安装依赖
npm install

# 编译 TypeScript
npm run build

# 启动开发模式
npm start

# 监听文件变化（开发时）
npm run watch
```

## 构建

```bash
# 打包当前平台
npm run dist

# 指定平台打包
npm run dist:mac      # macOS (.dmg + .zip)
npm run dist:win      # Windows (.exe 安装程序)
npm run dist:linux    # Linux (.deb + .AppImage + .rpm)

# 仅打包目录（不生成安装程序，用于测试）
npm run pack
```

构建产物输出到 `build_dist/` 目录。

## 深度链接协议

应用注册 `dedalix://` 协议。URL 格式：

```
dedalix://ai.optibot.cn:8065/invite?id=xxx&type=yyy
```

客户端收到后自动转换为 `https://` 并导航：

```
dedalix://ai.optibot.cn:8065/invite?id=xxx
→ https://ai.optibot.cn:8065/invite?id=xxx
```

### 平台行为

| 平台 | 冷启动 | 应用已运行 |
|------|--------|-----------|
| macOS | `open-url` 事件 | `open-url` 事件 |
| Windows | `process.argv` 包含 URL | `second-instance` 事件转发 argv |
| Linux | `process.argv` 包含 URL | `second-instance` 事件转发 argv |

## 配置

服务器地址硬编码在 `src/protocol.ts` 的 `APP_URL` 常量中：

```typescript
export const APP_URL = 'https://ai.optibot.cn:8066';
```

如需修改服务器地址，直接编辑此常量即可。

## 图标

当前 `resources/` 目录包含占位图标，发布前请替换为正式图标：

- `icon.png` — 512×512 PNG（Linux 通用）
- `icon.ico` — Windows ICO（含 16/32/48/64/128/256 px）
- `icon.icns` — macOS ICNS
- `tray-icon.png` — 22×22 系统托盘图标（Linux/Windows）
- `tray-icon-Template.png` — macOS 系统托盘（单色，自动适配深色模式）

## 项目结构

```
dedalix_electron_app/
├── package.json              # 项目配置
├── tsconfig.json             # TypeScript 配置
├── electron-builder.yml      # 打包配置
├── resources/                # 应用图标资源
│   ├── icon.png
│   ├── icon.ico
│   ├── icon.icns
│   ├── tray-icon.png
│   └── tray-icon-Template.png
├── src/
│   ├── main.ts               # 主进程入口 — 应用生命周期、单实例、协议注册
│   ├── protocol.ts           # dedalix:// 协议处理 — URL 解析、导航
│   ├── window.ts             # 窗口管理 — 创建、状态持久化、User-Agent
│   ├── tray.ts               # 系统托盘 — 图标、上下文菜单
│   └── preload.ts            # 预加载脚本 — 向渲染进程暴露安全 API
└── dist/                     # TypeScript 编译输出（git ignored）
```

## 前端检测

Webapp 通过 User-Agent 检测是否在客户端内运行：

```typescript
function isInsideDedalixClient(): boolean {
    return /Dedalix\//.test(navigator.userAgent);
}
```

客户端内，`/invite` 页面会自动跳过协议唤起按钮，直接展示登录入口。
