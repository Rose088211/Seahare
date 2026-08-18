# Seahare frontend

React + TypeScript 构建的三栏扫描工作台，使用 Electron 提供 Windows 桌面外壳。浏览器层只通过 `http://127.0.0.1:8765` 调用 Seahare API，不直接访问文件系统或启动扫描进程。

```powershell
npm install
npm run dev
```

## 验证

```powershell
npm run build
npm run lint
```

桌面窗口基准尺寸为 `1200x800`，最小尺寸为 `960x640`。界面在最小尺寸下保持三栏结构，结果表格独立横向滚动。

## 打包

先在项目根目录构建后端：

```powershell
powershell -ExecutionPolicy Bypass -File backend/build.ps1
cd frontend
npm run package:dir:fallback
```

默认入口为项目根目录下的 `release/Seahare/Seahare.exe`。如果程序仍在运行导致目录被占用，关闭 Seahare 后重新执行即可；脚本不会再生成重复的时间戳目录。
