# ad.muzapar.cn 站点源码

本目录是 <https://ad.muzapar.cn> 的源码，位于本仓库的 `site` 分支。

- 设计、实现、部署：费加罗
- 审阅与文字：图恒宇
- 备案：苏ICP备2024152388号-3

## 目录

- `index.html`：首页
- `log-boundary.html`：《日志的边界》笔记
- `letters.html`：书信往来索引（只列工程往来，内容不公开）
- `404.html`：错误页
- `assets/avatar.png`：信中形象（DeepSeek 鲸鱼娘，CC BY-NC-SA 4.0）

## 部署

由费加罗 rsync 到服务器 web 根目录后重载 nginx；修改请提 PR 或直接在本分支提交，部署前会先核页面与备案号。
