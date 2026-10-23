# 扩展插件（addons）

把插件文件夹整个拷进 `addons/`，**重启服务**即可生效。不用装依赖，不用打包。

## 目录约定

```
addons/
└── shape-pack/                 ← 目录名建议与 id 一致
    ├── manifest.json           ← 必须有，没有会被跳过并打一行提示
    └── public/                 ← 可选，这里的文件会自动挂到 /addons/shape-pack/
        ├── index.js
        └── style.css
```

- `addons/<id>/manifest.json` —— 描述插件
- `addons/<id>/public/**` —— 静态资源，浏览器通过 `/addons/<id>/**` 访问

**没有插件时（目录不存在或为空），所有现有功能与以前完全一致。**

## manifest.json 字段

```json
{
  "id": "shape-pack",
  "name": "形状包",
  "version": "1.2.0",
  "description": "除心形外，还能聚成星形、圆形、文字轮廓",
  "author": "你的名字",
  "entry": "index.js"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 插件唯一标识，同时决定挂载路径 `/addons/<id>/`。只能是字母、数字、`-`、`_` |
| `name` |  | 显示名，缺省用 `id` |
| `version` |  | 版本号字符串，缺省 `"0.0.0"` |
| `description` |  | 一句话说明，会显示在管理台「扩展插件」里 |
| `author` |  | 作者 |
| `entry` |  | 入口脚本，相对 `public/`；服务端会把它补全成 `/addons/<id>/<entry>` 返回给前端 |

## 前端怎么用

管理台会请求 `GET /api/addons` 拿到已启用的插件列表：

```json
{
  "code": 0,
  "data": {
    "total": 1,
    "addons": [
      {
        "id": "shape-pack",
        "name": "形状包",
        "version": "1.2.0",
        "description": "除心形外，还能聚成星形、圆形、文字轮廓",
        "author": "你的名字",
        "entry": "/addons/shape-pack/index.js"
      }
    ]
  }
}
```

前端拿到 `entry` 后用动态 `import()` 加载即可，不需要构建工具：

```js
const res = await fetch('/api/addons').then((r) => r.json());
for (const addon of res.data.addons) {
  if (addon.entry) await import(addon.entry);
}
```

## 安全边界

- 只有 **已加载插件的 id** 才能映射到磁盘，未知 id 一律拒绝，
  不会把 `addons/` 下的任意文件暴露成静态资源。
- 路径里的 `..` 和空字节会被拦掉。
- 单个插件的 `manifest.json` 坏掉只会跳过它，服务照常启动。

## 写一个最小插件

```bash
mkdir -p addons/demo/public
cat > addons/demo/manifest.json <<'EOF'
{ "id": "demo", "name": "示例插件", "version": "0.1.0", "entry": "index.js" }
EOF
echo "console.log('插件已加载');" > addons/demo/public/index.js
```

重启服务，终端会打印 `已加载插件：demo v0.1.0`，
管理台「扩展插件」里会出现「已启用 · demo」。
