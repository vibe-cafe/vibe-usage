# Cursor 配额接入方案

## 现在的规则

Vibe Usage 目前只识别 Cursor，不读取配额。产品发现阶段不读取凭据，也不联网。

## 准备怎么改

用户主动勾选 Cursor 后，CLI 才执行以下操作：

1. 只读 Cursor 的 `state.vscdb`，仅查询 `cursorAuth/accessToken`。
2. 使用当前登录态请求 Cursor 网页使用的 `GET https://cursor.com/api/usage-summary`。
3. 显示订阅类型、本周期用量和 `billingCycleEnd`；周期重置后由下一次请求自动更新。
4. 收到 401/403 时重新读取一次数据库；Token 已变化则重试一次，否则提示用户重新登录 Cursor。
5. 不自行刷新或修改 Cursor Token，不读取浏览器 Cookie，不抓取网络流量或界面。

Token 只在单次请求的内存中使用，不写入 Vibe Usage 配置、Keychain、配额缓存、日志、诊断或上传数据。配额缓存只保存标准化后的百分比、周期时间和套餐名称，并按本地账号标识的单向哈希隔离。

产品发现仍然只检查 Cursor 是否安装。没有勾选 Cursor 时，不读取数据库，也不发起请求。

## 兼容和失败处理

- Cursor 免费账号或无配额字段：显示暂无可用订阅配额。
- 数据库不存在、Token 过期：提示在 Cursor 中登录。
- 网络失败或接口临时异常：使用未过期的配额缓存，并标注数据时间。
- 返回结构变化：拒绝不完整数据，不猜测配额。
- 不迁移现有配置；已选择 Cursor 的用户升级后才开始读取，仍可随时取消选择。

`usage-summary` 是 Cursor 网页内部接口，没有公开的版本和兼容承诺。实现会把接口变化视为可恢复错误，不能把它描述为 Cursor 官方开放 API。

## 涉及仓库

- CLI：增加 Cursor quota provider、缓存隔离和自动化测试。
- macOS：让已选择的 Cursor 进入现有 CLI 配额刷新流程，删除“等待官方配额接口”的占位说明。
- Windows：更新内置 CLI 后复测，不另写一套 Cursor 请求逻辑。

## 发布和回滚

先合并并发布 CLI，再更新 macOS 和 Windows 固定的 CLI 版本。发布前至少使用一个 Cursor Pro/Ultra 账号验证成功响应、周期时间、401 后重新读取登录态和账号切换。

如 Cursor 修改接口或维护者撤回该读取方式，回滚 CLI provider，并把两个桌面端恢复为只识别；现有用量同步和其他产品配额不受影响。

## 请维护者确认

是否同意在“用户主动选择 Cursor”后，按上述边界只读 Cursor 本机登录态并调用 `usage-summary`？
