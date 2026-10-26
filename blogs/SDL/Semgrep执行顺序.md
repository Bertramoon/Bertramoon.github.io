---
title: Semgrep执行顺序及特性总结
date: 2026/10/26
tags:
  - 应用安全
categories:
  - SDL
---

## 1. 核心模型：`patterns` 的分阶段求值

`patterns` 是一个逻辑 **AND**，但内部子句**不是**按书写顺序逐个短路求值，而是分 4 个阶段整体求值。官方文档明确：

> "The order in which the child patterns are declared in a `patterns` operator does not affect the final result."

| 阶段  | 类别     | 操作符                                                       |
| ----- | -------- | ------------------------------------------------------------ |
| **1** | 正向匹配 | `pattern`、`pattern-inside`、`pattern-regex`、`pattern-either` |
| **2** | 负向过滤 | `pattern-not`、`pattern-not-inside`、`pattern-not-regex`     |
| **3** | 条件约束 | `metavariable-regex`、`metavariable-pattern`、`metavariable-comparison`、`metavariable-name` |
| **4** | 聚焦     | `focus-metavariable`                                         |

各阶段逻辑：

1. **阶段 1（正向）**：所有正向 pattern 的匹配范围**取交集**，得到"正向范围"集合，并携带 **metavariable 绑定**（`$X` 绑定到具体代码）。
2. **阶段 2（负向）**：所有负向 pattern 得到"负向范围"，用来**从正向结果中剔除**（等价于 `(∩ 正向) − (∪ 负向)`）。
3. **阶段 3（条件）**：条件操作符只对**阶段 1 正向绑定、且通过阶段 2 过滤后留下的** metavariable 求值，取交集过滤。
4. **阶段 4（聚焦）**：`focus-metavariable` 对正向绑定范围的交集做"放大"，只高亮该区域。

> 每个类别内部都是**纯集合运算**（交 / 减 / 过滤），不产生可被其他类别读取的中间状态，因此**书写顺序不影响最终结果**

## 2. 各操作符的执行顺序与特点

### 2.1 正向匹配（阶段 1）

**书写顺序无关。** 实测验证：

- `pattern-inside` 放前 / 放中 / 放后，结果完全一致（`pattern-inside: def $F($X)` 与 `pattern: open($X)` 无论顺序，都只匹配参数一致的 `open(path)`）。官方提到，底层实现中因为`pattern-inside`的特殊性，需要单独提取出来放到最后面做计算，否则会存在BUG，因此表面看是与顺序无关，实际上底层实现是有顺序的
- 多个正向 pattern 之间通过**范围交集 + metavariable 一致化**组合（AND 语义）。
- `pattern-either` 也属正向，但与普通 `pattern` 的元变量行为不同（见 §5）。

### 2.2 负向过滤（阶段 2）

**书写顺序无关，取并集后统一剔除。** 实测验证：

- 多个 `pattern-not` 之间顺序无关（如剔除 `call("a")` 和 `call("b")`，先 a 后 b 与先 b 后 a 结果相同）。
- `pattern-not` 可内嵌 `pattern-either`（对 OR 整体取反）。
- `pattern-not-inside` 是 `pattern-inside` 的否定（保持"不在该上下文内"的匹配）。

注意：`pattern-not` 、`pattern-not-regex`、`pattern-not-inside`都不复用正向pattern中的元变量，因为元变量不对负向过滤有效。因此，有且仅有`pattern-not`能使用包含正向pattern的方式来使用元变量过滤，如下例子，可以匹配参数不是"haha"的所有eval调用，之所以能使用元变量帮助负向过滤，完全是因为`pattern-not`下面可以包含`patterns`或者`pattern-either`：

```yaml
rules:
  - id: eval
    message: Detect function eval
    severity: HIGH
    languages:
      - python
    patterns:
      - pattern: eval($X)
      - pattern-not:
          patterns:
            - pattern: eval($Y)
            - metavariable-comparison:
                metavariable: $Y
                comparison: str($Y) == "haha"
```

### 2.3 条件约束（阶段 3）

**书写顺序无关，取交集过滤。** 它们只做过滤、不改变匹配信息：

- `metavariable-regex` / `metavariable-comparison` / `metavariable-pattern` / `metavariable-name` 都只读取**正向预绑定**的 metavariable，做布尔过滤。
- `metavariable-pattern` 中的负向过滤可以复用与`metavariable-pattern`同一级的正向匹配的元变量，这一点是特殊的
- 多个条件之间是 AND 交集，顺序无关（嵌套作用域内也一样）。

**静态校验约束**（与求值顺序无关，但必须满足）：

- `patterns` **至少要有一个正向 term**（不能只有 `pattern-not` + `metavariable-*`），否则报错 *"need at least one positive term"*（issue #10514）。
- `pattern-either` 内部所有子项必须都是正向的。

### 2.4 聚焦（阶段 4）

- `focus-metavariable` **不执行匹配**，只对正向绑定范围取交集、缩小高亮区域。
- 单个 focus：聚焦到该元变量区域。
- 多个 focus：**集合交集**语义——若两个元变量范围不相交，则交集为空，0 匹配。

## 3. 元变量传播边界（重点）

这是最容易踩坑的部分。核心原则：**元变量绑定只由"正向 pattern"产生，并向容器内的其他操作符传播。**

| 生产者 / 消费者                      | 能否使用 | 说明                                                       |
| ------------------------------------ | -------- | ---------------------------------------------------------- |
| 正向 pattern → 同级正向 pattern      | ✅        | AND 一致化约束                                             |
| 正向 pattern → 同级 `pattern-not`    | ❌        | 负向的元变量是独立的，不共享                               |
| 正向 pattern → 同级 `metavariable-*` | ✅        | 条件读取正向绑定                                           |
| 正向 pattern → `focus-metavariable`  | ✅        | 聚焦正向绑定范围                                           |
| `pattern-not` → 其他 `pattern-not`   | ❌        | 负向不产生可共享的新绑定（各用正向绑定）                   |
| `pattern-not` → `metavariable-*`     | ❌        | validate 拒绝（`never bound by a positive pattern`）       |
| `pattern-either` 分支之间            | ❌        | 各分支独立，无一致化                                       |
| `pattern-either` 分支 → 同级条件     | ✅        | 命中分支的绑定可被同级 `metavariable-*` 使用（1.165 实测） |

## 4. pattern-regex 与 metavariable-regex 的正则捕获组

### 4.1 `pattern-regex` 的捕获组（`(?P<DATA>...)`）—— **能力全面且可靠** ✅

实测 `pattern-regex: call\((?P<DATA>\w+)\)` 捕获的 `$DATA`（同时自动生成编号组 `$1`）可用于：

| 用途                                             | 是否可用 | 说明                                  |
| ------------------------------------------------ | -------- | ------------------------------------- |
| `metavariable-regex` / `metavariable-comparison` | ✅        | 作为条件过滤                          |
| `focus-metavariable`                             | ✅        | 聚焦到捕获文本位置                    |
| `fix` / `message`                                | ✅        | 稳定插值（`safe($DATA)` → `safe(a)`） |
| 同级 `pattern`（如 `pattern: $DATA`）            | ✅        | 捕获值可作为表达式匹配                |

### 4.2 `metavariable-regex` 的捕获组 —— **有限且不可靠** ⚠️

- ✅ 可用于 `focus-metavariable`（validate 通过，正确聚焦）。
- ⚠️ **用于 `fix` / `message` 插值时不稳定**：同一规则产生了未插值（`found $A`）和插值（`found a`）两条结果。
- **建议**：需要把正则捕获的文本用于 `fix` 或后续匹配时，用 `pattern-regex`（可靠）而非 `metavariable-regex`。

## 5. pattern-either 的独立性

- **内部独立**：多个分支各自独立匹配，**分支之间不做元变量一致性约束**。`call($X)` OR `use($X)` 会匹配所有 `call(...)` 和 `use(...)`，`$X` 在各分支独立绑定
- **可引用外部**：分支**能**使用同级 / 父级 pattern 绑定的元变量，并做一致性约束
- **可导出内部**：命中分支的绑定**能**被同级 `metavariable-*` 读取

## 6. 常见误区总结

| 误区                                                 | 真相                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| "`pattern-not` 和 `pattern-either` 的顺序会影响结果" | 无关。它们属于不同阶段（负向 / 正向），各取并集 / 交集，顺序不影响结果 |
| "`pattern-inside` 必须放最前/后"                     | 不必。前置 / 后置 / 中间结果一致，元变量绑定在阶段 1 统一建立 |
| "metavariable-* 按书写顺序执行并互相影响"            | 无关。它们只做过滤、不重绑定，最终取交集                     |
| "pattern-either 完全独立，元变量不外传"              | 部分过时。1.165 中命中分支绑定可被同级条件读取               |

## 7. 一句话总结

`patterns` 的求值等价于：**`(∩ 所有正向匹配) − (∪ 所有负向匹配)`，再对结果施加 `∩ 所有 metavariable-* 条件`，最后按 `focus-metavariable` 取交集。** 由于每个类别内部都是纯集合运算、且不产生可被其他类别读取的中间状态，**书写顺序不影响最终结果**——真正影响语义的是**操作符类别（正 / 负 / 条件 / 聚焦）与嵌套作用域**，而非它们在 `patterns` 列表里的先后位置。元变量绑定只由正向 pattern（含 pattern-regex 捕获组）产生并向下传播。