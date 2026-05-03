## 网页访问策略

访问外部网页时优先使用 WebFetch（速度快）。
如果 WebFetch 失败（403、被拦截、内容为空或需要 JavaScript 渲染），
且 agent-browser 可用，立即改用 agent-browser 通过真实浏览器访问。不要反复重试 WebFetch。
