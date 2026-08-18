# Seahare backend

Seahare 后端是仅监听本机的 Python 扫描服务，使用标准库完成 HTTP 扫描、REST/SSE API 和 SQLite 持久化，不需要运行时第三方依赖。

```powershell
python -m backend
```

默认地址为 `http://127.0.0.1:8765`。完整接口契约见 [api.md](api.md)。

## 数据与恢复

- 数据库：`%LOCALAPPDATA%\Seahare\seahare.db`
- 自定义字典：`%LOCALAPPDATA%\Seahare\dictionaries\`
- 覆盖数据目录：设置 `SEAHARE_DATA_DIR`
- 启动恢复：遗留的活动任务会转换为 `interrupted`，可通过 retry API 复制并重试

## 测试

```powershell
python -m unittest backend.test_backend -v
python -m py_compile backend/server.py backend/__main__.py
```

测试覆盖任务生命周期、持久化、启动恢复、策略/字典接口、SSE、游标结果、风险汇总、重试、重定向范围保护与 CSV 导出。

## Windows 可执行文件

```powershell
python -m pip install -r backend/requirements-build.txt
powershell -ExecutionPolicy Bypass -File backend/build.ps1
```

产物位于 `dist/seahare-backend.exe`。
