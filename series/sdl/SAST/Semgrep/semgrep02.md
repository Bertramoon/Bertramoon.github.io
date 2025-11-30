---
title: 02 以小见大，如何改写和自定义Semgrep规则
date: '2025-11-22'
---

在我们使用Semgrep进行扫描的时候，会发现存在误报，或者有些问题它扫描不了，没有对应的规则。也就是说，根据公司和项目的风格习惯和编码规范等，我们需要对规则进行改写和自定义。

既然是写规则，那让我们先从开发安全规则角度出发，看看问题可以怎么分类：

- **特征关键词匹配**。常见于不安全函数的使用
- **通用编码问题**。使用污点分析的方式跟踪输入源(source)及中间过程直到汇点(sink)，常用于命令注入、SQL注入等漏洞
- **自研代码编码问题**。属于当前系统或当前系统所对接的其他私有项目的问题，需要专门编写规则用以适配当前系统代码，常见于访问控制、不安全配置项等

对于前两类问题，工具的默认规则基本上涵盖了大部分的问题识别。但是存在一个问题，就是如果我们的校验方法不是使用业界最标准的措施的话（例如自定义了一个白名单规则校验，而不是使用更安全的三方库），那么默认规则肯定是无法识别到这些自定义的校验方法的，就会导致存在误报。此时，如果这个校验方法在我们的代码里是“通用”的，很多项目中都使用到了，那么我们可以通过**改写规则**，加入“消毒”方法使其不会产生误报。

对于最后的自研代码编码问题，我们需要完全**自定义规则**。

而Semgrep作为一款扩展性强的工具，自然是可以改写和自定义规则的。下面，以SQL注入为例，分别进行规则改写和自定义编写。

### 改写现有规则降低误报率

`tainted-sql-string`是Semgrep社区的SQL注入扫描规则，详细如下（仅保留规则核心配置，其他无关信息进行了删减），它使用污点分析模式进行匹配。

- pattern-sources指定了污染源是接口上用户的输入，并且将Integer、Long等类型排除在外
- pattern-sinks指定了SQL拼接的情况，并将控制台输出、日志打印、抛出错误等情况进行排除

```yaml
rules:
  - id: tainted-sql-string
    options:
      taint_unify_mvars: true
    mode: taint
    pattern-sources:
      - patterns:
        - pattern-either:
            - pattern-inside: |
                $METHODNAME(..., @$REQ(...) $TYPE $SOURCE,...) {
                  ...
                }
            - pattern-inside: |
                $METHODNAME(..., @$REQ $TYPE $SOURCE,...) {
                  ...
                }
        - metavariable-regex:
            metavariable: $REQ
            regex: (RequestBody|PathVariable|RequestParam|RequestHeader|CookieValue)
        - metavariable-regex:
            metavariable: $TYPE
            regex: ^(?!(Integer|Long|Float|Double|Char|Boolean|int|long|float|double|char|boolean))
        - focus-metavariable: $SOURCE
    pattern-sinks:
      - patterns:
        - pattern-either:
            - patterns:
                - pattern-inside: |
                    $VAR = "$SQLSTR";
                    ...
                - pattern: $VAR += $TAINTED_KEY
        - pattern-not-inside: System.out.println(...)
        - pattern-not-inside: $LOG.info(...)
        - pattern-not-inside: $LOG.warn(...)
        - pattern-not-inside: $LOG.warning(...)
        - pattern-not-inside: $LOG.debug(...)
        - pattern-not-inside: $LOG.debugging(...)
        - pattern-not-inside: $LOG.error(...)
        - pattern-not-inside: new Exception(...)
        - pattern-not-inside: throw ...;
        - metavariable-regex:
            metavariable: $SQLSTR
            regex: (?i)(select|delete|insert|create|update|alter|drop)\b
```

现在有这样一段代码，有`/jdbc-bad`和`/jdbc-good`两个接口：

```java
package com.example.demo.controller;

import com.example.demo.entity.User;
import com.example.demo.service.SQLiService;
import com.example.demo.vo.Response;
import com.example.demo.vo.sqli.SQLiRequest;
import jakarta.annotation.Resource;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.sql.*;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/sqli")
public class SQLiController {
    @Value("${spring.datasource.url}")
    private String dbUrl;

    @Value("${spring.datasource.username}")
    private String dbUsername;

    @Value("${spring.datasource.password}")
    private String dbPassword;

    @PostMapping("/jdbc-bad")
    public Response<List<User>> jdbcBad(@RequestBody SQLiRequest request) {
        Map<String, Object> conditions = request.getConditions();
        List<Object> args = new ArrayList<>();
        List<User> result = new ArrayList<>();
        try (Connection connection = DriverManager.getConnection(dbUrl, dbUsername, dbPassword)) {
            String sql = "SELECT * FROM user WHERE 1=1";
            if (conditions != null && !conditions.isEmpty()) {
                for (Map.Entry<String, Object> condition : conditions.entrySet()) {
                    // 存在SQL拼接用户输入，不安全
                    sql += " AND " + condition.getKey() + " = ?";
                    args.add(condition.getValue());
                }
            }
            try (PreparedStatement statement = connection.prepareStatement(sql)) {
                for (int i = 0; i < args.size(); i++) {
                    statement.setObject(i + 1, args.get(i));
                }
                try (ResultSet resultSet = statement.executeQuery()) {
                    while (resultSet.next()) {
                        int id = resultSet.getInt("id");
                        String username = resultSet.getString("username");
                        result.add(new User(id, username, null));
                    }
                }
            }
            return Response.success(result);
        } catch (SQLException e) {
            e.printStackTrace();
            return Response.fail(e.getMessage());
        }
    }

    @PostMapping("/jdbc-good")
    public Response<List<User>> jdbcGood(@RequestBody SQLiRequest request) {
        Map<String, Object> conditions = request.getConditions();
        List<Object> args = new ArrayList<>();
        List<User> result = new ArrayList<>();
        try (Connection connection = DriverManager.getConnection(dbUrl, dbUsername, dbPassword)) {
            String sql = "SELECT * FROM user WHERE 1=1";
            if (conditions != null && !conditions.isEmpty()) {
                for (Map.Entry<String, Object> condition : conditions.entrySet()) {
                    // 检查字段名是否在User类的属性中，所以是安全的
                    checkFieldName(condition.getKey());
                    sql += " AND " + condition.getKey() + " = ?";
                    args.add(condition.getValue());
                }
            }
            try (PreparedStatement statement = connection.prepareStatement(sql)) {
                for (int i = 0; i < args.size(); i++) {
                    statement.setString(i + 1, (String) args.get(i));
                }
                try (ResultSet resultSet = statement.executeQuery()) {
                    while (resultSet.next()) {
                        int id = resultSet.getInt("id");
                        String username = resultSet.getString("username");
                        result.add(new User(id, username, null));
                    }
                }
            }
            return Response.success(result);
        } catch (SQLException e) {
            e.printStackTrace();
            return Response.fail(e.getMessage());
        }
    }

    private void checkFieldName(String fieldName) {
        if (Arrays.stream(User.class.getDeclaredFields()).noneMatch(field -> field.getName().equals(fieldName))) {
            throw new IllegalArgumentException("字段名不存在");
        }
    }
}
```

接口`/jdbc-bad`使用外部输入作为表名拼接到SQL语句中，存在SQL注入。接口`/jdbc-good`在使用外部输入作为表名拼接SQL前，调用`checkFieldName`进行了校验，因为不会存在SQL注入问题。然而，在使用`tainted-sql-string`规则进行检查时，会发现两条规则都会匹配命中。那么如果我们希望减少误报率，该怎么做呢？其实也很简单，Semgrep提供了pattern-sanitizers用于指定消毒规则。我们只需要加上如下规则即可：

```yaml
pattern-sanitizers:
  - patterns:
      - pattern-either:
          - pattern: checkFieldName($X.$_)
          - pattern: checkFieldName($X.$_(...))
      - focus-metavariable: $X
    by-side-effect: true
```

规则表示当调用`checkFieldName`对污染源进行消毒时，之后的访问都是安全的，pattern-sinks将不会触发。`by-side-effect`的作用可以参考[官方文档](https://semgrep.dev/docs/writing-rules/data-flow/taint-mode/advanced#taint-sanitizers-by-side-effect )，按照官方解释来说就是是否受到函数“副作用”的影响，这个所谓“副作用”指的是处理过程（如函数）是否对入参本身造成影响。简单来说就是：

- `by-side-effect: false`（默认）：处理过程不会对输入对象造成影响，只会对返回已经“消毒”的结果。例如`result = sanitizers(source)`，source不会发生变化，还是未经消毒的输入源，而result是经过消毒、可以信任的处理数据
- `by-side-effect: only`：处理过程只会对输入对象进行“消毒”，不会对返回结果造成影响。例如`result = sanitizers(source)`，result不会进行消毒，但source是经过消毒的、可以信任的处理数据
- `by-side-effect: true`：处理过程既对输入对象“消毒”，也对返回的结果“消毒”。例如`result = sanitizers(source)`，result和source是经过消毒的，可以信任的数据

就像下面这个例子：

```python
source = userInput

# by-side-effect: true
data = sanitizers(source)
sink(data)  # ok
sanitizers(source)
sink(source)  # ok

# by-side-effect: false
data = sanitizers(source)
sink(data)  # ok
sanitizers(source)
sink(source)  # not ok

# by-side-effect: only
data = sanitizers(source)
sink(data)  # not ok
sanitizers(source)
sink(source)  # ok
```

最后，我们得到的完整规则如下：

```yaml
rules:
  - id: tainted-sql-string-custom
    languages:
      - java
    severity: ERROR
    message: 自定义的spring SQL注入扫描(源自tainted-sql-string)-V1
    metadata:
      cwe:
        - "CWE-89: Improper Neutralization of Special Elements used in an SQL
          Command ('SQL Injection')"
      owasp:
        - A01:2017 - Injection
        - A03:2021 - Injection
      references:
        - https://docs.oracle.com/javase/7/docs/api/java/sql/PreparedStatement.html
      category: security
      technology:
        - spring
      cwe2022-top25: true
      cwe2021-top25: true
      subcategory:
        - vuln
      likelihood: HIGH
      impact: MEDIUM
      confidence: MEDIUM
      interfile: true
      license: Semgrep Rules License v1.0. For more details, visit
        semgrep.dev/legal/rules-license
      vulnerability_class:
        - SQL Injection
    options:
      taint_assume_safe_numbers: true
      taint_assume_safe_booleans: true
      interfile: true
    mode: taint
    pattern-sources:
      - patterns:
          - pattern-either:
              - pattern-inside: |
                  $METHODNAME(..., @$REQ(...) $TYPE $SOURCE,...) {
                    ...
                  }
              - pattern-inside: |
                  $METHODNAME(..., @$REQ $TYPE $SOURCE,...) {
                    ...
                  }
          - metavariable-regex:
              metavariable: $REQ
              regex: (RequestBody|PathVariable|RequestParam|RequestHeader|CookieValue)
          - metavariable-regex:
              metavariable: $TYPE
              regex: ^(?!(Integer|Long|Float|Double|Char|Boolean|int|long|float|double|char|boolean))
          - focus-metavariable: $SOURCE
    pattern-sanitizers:
      - patterns:
          - pattern-either:
              - pattern: checkFieldName($X.$_)
              - pattern: checkFieldName($X.$_(...))
          - focus-metavariable: $X
        by-side-effect: true
    pattern-sinks:
      - patterns:
          - pattern-either:
              - pattern: |
                  "$SQLSTR" + ...
              - pattern: |
                  "$SQLSTR".concat(...)
              - patterns:
                  - pattern-inside: |
                      StringBuilder $SB = new StringBuilder("$SQLSTR");
                      ...
                  - pattern: $SB.append(...)
              - patterns:
                  - pattern-inside: |
                      $VAR = "$SQLSTR";
                      ...
                  - pattern: $VAR += ...
              - pattern: String.format("$SQLSTR", ...)
              - patterns:
                  - pattern-inside: |
                      String $VAR = "$SQLSTR";
                      ...
                  - pattern: String.format($VAR, ...)
          - pattern-not-inside: System.out.println(...)
          - pattern-not-inside: $LOG.info(...)
          - pattern-not-inside: $LOG.warn(...)
          - pattern-not-inside: $LOG.warning(...)
          - pattern-not-inside: $LOG.debug(...)
          - pattern-not-inside: $LOG.debugging(...)
          - pattern-not-inside: $LOG.error(...)
          - pattern-not-inside: new Exception(...)
          - pattern-not-inside: throw ...;
          - metavariable-regex:
              metavariable: $SQLSTR
              regex: (?i)(select|delete|insert|create|update|alter|drop)\b
```

扫描结果如下，位于169行的该漏洞点消失了

![image-20251122002415894](semgrep.assets/image-20251122002415894.png)

![image-20251122002517945](semgrep.assets/image-20251122002517945.png)

### 自定义规则实现漏洞扫描

Semgrep没有针对Mybatis的SQL注入校验规则，需要我们自行编写，分别用于注解方式和XML配置文件方式的情况下检测SQL注入问题。

```yaml
rules:
  - id: mybatis-sqli-annotation
    message: Mybatis SQL injection vulnerability using annotation
    severity: HIGH
    languages:
      - java
    options:
      interfile: true
    patterns:
      - pattern-either:
          - pattern: |
              @$OPERATION("$SQL")
              $RET $METHODNAME(..., @Param("$PARAM") $TYPE $_, ...);
          - patterns:
              - pattern: |
                  @$OPERATION("$SQL")
                  $RET $METHODNAME(..., $TYPE $PARAM, ...);
              - pattern-not: |
                  @$OPERATION("$SQL")
                  $RET $METHODNAME(..., @$ANNOTATION(...) $TYPE $PARAM, ...);
      - metavariable-regex:
          metavariable: $OPERATION
          regex: (?i)(select|insert|update|delete)
      - metavariable-regex:
          metavariable: $TYPE
          regex: (?i)(^(?!.*short|int|integer|long|float|double|boolean).*$)
      - metavariable-comparison:
          metavariable: $SQL
          comparison: str($PARAM) in str($SQL)
      - metavariable-pattern:
          language: generic
          metavariable: $SQL
          pattern: ... ${$X} ...
  - id: mybatis-sqli-xml
    message: Mybatis SQL injection vulnerability using XML
    severity: HIGH
    languages:
      - xml
    options:
      interfile: true
    patterns:
      - pattern-either:
          - pattern: |
              <select>$...KEY</select>
          - pattern: |
              <insert>$...KEY</insert>
          - pattern: |
              <update>$...KEY</update>
          - pattern: |
              <delete>$...KEY</delete>
          - pattern: |
              <sql>$...KEY</sql>
      - metavariable-pattern:
          language: generic
          metavariable: $...KEY
          pattern: ... ${$X} ...
```

这里规则写得比较简单（存在优化空间），当SQL语句注解中或者XML的SQL语句配置中出现了"${...}"，就认为存在SQL注入。扫描结果如下。

注解方式：

![image-20251121234821130](semgrep.assets/image-20251121234821130.png)

XML文件：

![image-20251121234728119](semgrep.assets/image-20251121234728119.png)

如果使用AppSec Platform查看，还能看到AI智能修复建议：

![image-20251121234615187](semgrep.assets/image-20251121234615187.png)
