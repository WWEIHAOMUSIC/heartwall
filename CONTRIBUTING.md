# 参与开发

谢谢你想改进这个项目。先说三条底线，改代码前请先看一眼：

1. **不加第三方依赖。** 服务端只用 Node 自带的 `http`/`fs`，前端用原生模块。
2. **不加构建步骤。** 没有 webpack / vite / babel，浏览器里跑的就是仓库里的源码。
3. **现场不能出弹窗。** 异常一律 `console.warn`，播放页正在大屏上跑，弹个 `alert` 会毁掉整场。

## 本地跑起来

```bash
git clone <本仓库>
cd 爱心墙
node start.js          # 或双击 start.command / start.bat / start.sh
```

想手动指定端口、不开浏览器：

```bash
PORT=9000 NO_OPEN=1 node server.js
```

## 跑测试

```bash
node --test
```

测试不许碰真实数据：

- `tests/api.test.mjs` 通过 `HEARTWALL_ROOT` 把整套服务指到一个临时目录，
  跑完自动删掉。你 `photos/` 里的照片一张都不会被动。
- 新增接口测试时，请继续用这个环境变量，不要往真实目录里写东西。

## 改心形排版

排版算法全在 `public/heart.js`，是一个纯函数：

```js
import { layoutHeart } from './public/heart.js';

const L = layoutHeart(41, 1920, 1080, aspects, cfg);
// L.cells[i].x/y/w/h   每张照片的落点
// L.rows / L.heartW / L.heartH / L.rowH
```

改完必须跑 `node --test`，里面有几何、行数、面积守恒、极端参数的断言。

几个**不要动**的地方，都是踩过坑才留在那儿的：

- `cap = min(maxRows, floor(n * 0.8))` —— 少了它，行数超过照片数就会算出 `NaN`
  坐标，照片凭空消失且控制台一行错都不报。
- 凹口采样（`NOTCH_D` / `NOTCH_ROWH`）—— 拿掉它心形顶部就是一条平线。
- `enforceTaper()` 的 `[3, 2, 1]` 收口 —— 拿掉它底部会出现连续的单张孤岛。
- `heartH * 0.0045` —— 看着像魔法数，但它与 `gapRatio × baseRowH` 解耦，
  改坏了二分查找就不收敛。

## 想加一种新形状（推荐用插件，别改核心）

1. 建目录 `addons/<id>/`，写一个 `manifest.json`
2. 形状代码放 `addons/<id>/public/`，服务端会自动挂到 `/addons/<id>/`
3. 前端通过 `GET /api/addons` 拿到列表，用动态 `import()` 加载
4. 重启服务，终端会打印「已加载插件：…」，管理台「扩展插件」里能看到

详细协议见 [addons/README.md](addons/README.md)。

## 提交前自查

- [ ] `node --test` 全绿
- [ ] 没引入 `npm install` 才能跑的东西
- [ ] 新增的异常路径用的是 `console.warn`，不是 `alert`
- [ ] 写盘的地方走的是 `writeFileAtomic`（先写 `.tmp` 再 `rename`），不是直接覆盖
- [ ] 中文注释跟得上代码（这个项目的使用者不是工程团队）

## 文档

- `docs/architecture.md` —— 架构与模块边界
- `docs/visual-spec.md` —— 视觉规格（颜色、动效参数）
- `docs/class-diagram.mermaid` / `docs/sequence-diagram.mermaid` —— 图
- `使用说明.txt` —— 给现场操作员看的，改文案请用大白话
