Original prompt: 修复练习站的空 JSON 报错、ESC 菜单卡死和误入非苦痛之路房间后的黑屏；误入其他房间时自动返回出生点长椅并坐下。ESC 菜单只保留返回出生点、创建标记点、返回标记点；提供 1–9 槽位列表，数字键选择，` 返回，+ 创建。默认加载 1.5.78.11833，确保大资源可由浏览器长期缓存，并增加中文与英文 i18n。先在本地完成并展示，不部署线上。

- 2026-09-19：开始本地修复。已确认活动项目为 Next.js 子项目 pop；现有 Unity 源码已经有单槽标记返回、暂停菜单返回出生点和越界出口守卫，但缺少九槽状态、完整暂停菜单改造和对实际已进入非法场景的二次恢复。
- TODO：修复统一 JSON 响应读取；默认版本；缓存响应；Unity 九槽与热键；暂停菜单；非法房间恢复；双语；构建；完整浏览器验收。
- 2026-09-19：统一修复所有相关接口的 JSON 读取。现在先读取文本并检查空响应、内容类型和 JSON 完整性；空构建清单会显示 Build manifest: 服务器返回了空响应，不再抛出 Unexpected end of JSON input。
- 2026-09-19：默认版本改为 1.5.78.11833，并用偏好修订号迁移旧的默认选择；用户之后主动选择的版本仍会保留。
- 2026-09-19：完成中文和英文界面。练习菜单、九个槽位、快捷键、房间榜单、Replay 相关提示均可随语言切换，偏好保存在 openpop-locale。
- 2026-09-19：ESC 练习菜单只显示返回出生点、创建标记点、返回标记点，并显示九槽列表。已验证数字 1–9 选槽、加号创建、反引号返回；第三槽创建后保存房间与坐标，切换语言后状态保持。
- 2026-09-19：网页运行桥增加非法房间检测。进入非苦痛之路房间时只发送一次 ReturnToPracticeSpawn，等待回到 White_Palace_06 且 atBench=true 后恢复正常状态。
- 2026-09-19：两个 Unity 工程的 OriginalPracticeDebugController.cs 均完成九槽接口、快捷键、非法房间二次恢复，以及同场景返回出生椅的结构性修复。两个控制器已使用 Unity 2020.2.2f1 的实际依赖独立编译通过。
- 2026-09-19：确认普通 HTTP 缓存会让约 92.8 MB 的 data.br 在刷新时重新下载，因此增加 Cache Storage Service Worker。真实浏览器第二次刷新时 framework.js.br、data.br、wasm.br 的 encodedDataLength 全部为 0。
- 2026-09-19：最终通过 npm run typecheck、npm test、npm run build、九槽与双语浏览器测试、非法房间恢复测试、浏览器缓存测试和 npm run verify:site:1578。真实旧活动包进入 White_Palace_06，atBench=true，unexpectedErrors 为空。
- 2026-09-19：Unity 2020.2.2f1 批处理构建被本机许可证阻断，日志为 Unity license has expired 和 Current license is invalid and cannot be activated。因此新九槽 C# 逻辑尚未编进活动 WebGL 包；当前线上和本地真实包仍是 original-practice-1.5.78.11833-marked-return-v2。本轮未部署线上，也未更新 R2。
- TODO：恢复 Unity 许可证后重新构建 1.5.78.11833 WebGL 包，再用真实包验收九槽创建与返回、同场景出生点返回、跨房间出生点返回、非法房间回椅；验收通过后再决定是否上传 R2 和部署服务器。

- 2026-09-19：根据用户纠正，撤销网页自制 ESC 练习弹窗。ESC 继续使用游戏原生暂停菜单；网页不再根据 paused 状态盖层、不再抢走焦点，也不再拦截 1–9、反引号和加号。九槽按键只由 Unity OriginalPracticeDebugController.Update 直接处理。
- 2026-09-19：真实 1.5.78.11833 WebGL 包验证通过。第一次 ESC 后 practice.paused=true，显示 Unity 原生继续、选项、退出到菜单界面；页面不存在 #practice-menu。第二次 ESC 后 practice.paused=false。截图位于 output/playwright/original-escape/original-unity-escape.png。
- 2026-09-19：更新轻量浏览器测试，验证外层菜单不存在；模拟 Unity 画布直接接收 3、Shift+Equal 和反引号后，第三槽创建并返回 White_Palace_18。该测试只验证网页没有截获按键；真实九槽仍需恢复 Unity 许可证并重建运行包后验收。

- 2026-09-21：用户实测旧 WebGL 输入路径中数字键 1–9、加号和反引号均无响应。确认根因不是九槽业务逻辑，而是浏览器焦点、键盘布局与 Unity WebGL 旧输入链路不稳定。
- 2026-09-21：第一次浏览器桥通过 SendMessage 调用字符串方法，在最终发布包中没有产生可验证的 Unity 行为，已舍弃该入口。
- 2026-09-21：最终改为浏览器窗口捕获物理键码并写入整数队列，Unity 控制器每帧主动消费队列。无画布焦点且 event.key=Process 的端到端验证已通过：Digit3 选中第三槽、Shift+Equal 创建第三槽标记、Backquote 返回第三槽标记，页面错误为空。
- 2026-09-21：新本地候选包位于 output/original-practice-1.5.78.11833-keyboard-queue-candidate3，本地测试地址为 http://127.0.0.1:8130/?keyboard-fix=queue1。构建与浏览器验证均通过，尚未上传 R2、部署服务器或提交 Git。
- 2026-09-21：补做全部快捷键遍历验证，数字键 1–9 逐个选槽全部通过；主键盘加号与小键盘加号均可创建标记；反引号返回成功，返回后画面与 HUD 正常。
- 2026-09-21：真实浏览器按键检查发现候选包 3 会被浏览器队列与 Unity 旧输入各处理一次。最终候选包 4 在 WebGL 中只启用浏览器队列，桌面与编辑器保留旧输入；真实按键计数已从 2 次降为 1 次。最终本地地址改为 http://127.0.0.1:8131/?keyboard-fix=final。

## 2026-09-21 最终键盘修复复核

- 最终本地包仍为 `output/original-practice-1.5.78.11833-keyboard-queue-candidate4`，本地地址 `http://127.0.0.1:8131/?keyboard-fix=final` 返回 HTTP 200。
- 回滚脚本以 `-ValidateOnly` 复核通过，退出状态 0；未执行真实回滚。
- 重新运行全部快捷键测试：数字键 1–9、主键盘 Shift+Equal、NumpadAdd、Backquote 全部通过，返回后仍在 `White_Palace_06` 椅子处，页面错误为空，退出状态 0。
- 重新运行真实键盘重复触发测试：选槽和创建标记均只执行一次，退出状态 0。
- 已人工检查复测截图 `output/verification/keyboard-command-queue-candidate4-rerun/all-practice-keys-passed.png`，游戏画面正常，无网页槽位栏。
- 已删除本轮淘汰包 candidate2 和 candidate3，保留最终 candidate4；8131 服务仍可访问。
- 已再次用 Edge 打开最终测试页。未上传 R2、未部署服务器、未提交 Git。
