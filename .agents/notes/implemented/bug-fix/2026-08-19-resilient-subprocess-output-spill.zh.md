# Agent Note: spill 存储消失时保留子进程输出

Status: implemented

[English](2026-08-19-resilient-subprocess-output-spill.md) | 中文

## 问题

`dsh-subprocess-local` 在内存中保留有界尾部，并可选地把完整流写入私有 spill 文件。子进程仍在运行时，操作系统或外部清理工具可能删除私有 spill 目录。下一块跨过内存上限的流数据随后会在流回调中的 spill 写入处抛出 `ENOENT` 或 `EPERM`，使宿主进程崩溃，而不是返回诊断尾部。

## 决定

`OutputCollector.push()` 把 `spillAll()` 抛出的 `ENOENT` 和 `EPERM` 视为可选 spill 层丢失。它调用已有的 `discardSpill()` 清理，禁用该流后续的 spill，并继续正常的有界尾部路径。其他 spill I/O 错误仍然向外传播，因此不会隐藏无关的存储故障。spill 被禁用后，`readFrom()` 和 `finalize()` 只暴露内存中的结果，不会公布已不存在的 spill 路径。

## 备选方案

**重建目录并重试 spill。** 不予采纳，因为原私有目录属于外部清理目标；重建会让 collector 的路径和权限依赖竞态，而有界尾部已经提供了安全的降级结果。

**换用新的临时目录。** 不予采纳，因为已有 collector 可能已经拥有 spill 文件或打开的描述符，中途换目录会把同一份逻辑输出拆到多个路径。

**让所有 spill 错误继续向外传播。** 不予采纳，因为 spill 是可选存储，临时目录消失不应把运行中子进程的输出回调变成宿主进程未捕获的故障。非 `ENOENT`／`EPERM` 错误仍会传播。

## 后果

spill 目录丢失后无法取得完整输出，但最后 `maxBytes` 仍可用，collector 会像未配置 spill 时一样报告截断。一次 spill 失败后，该流不会重复尝试，从而避免连续回调失败和路径竞态；后续流或子进程需要时仍可创建新的默认 spill 目录。

## 测试

`packages/subprocess/subprocess-local/tests/spawn.spec.ts` 在第一次溢出前删除注入的 spill 目录，断言下一块数据写入不会抛错，并验证最终结果只有有界尾部且没有过期的 spill 路径。
