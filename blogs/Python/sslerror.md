---
title: SSLError：dh key to small报错如何解决
date: 2022/07/28
tags:
  - 爬虫
  - 报错
categories:
  - Python
---
在使用爬虫库requests爬取页面时发生了"dh key to small"的错误，如下几种情况：

```
requests.exceptions.SSLError: [SSL: SSL_NEGATIVE_LENGTH] dh key too small (_ssl.c:600)
requests.exceptions.SSLError: HTTPSConnectionPool(host='cas.dgut.edu.cn', port=443): Max retries exceeded with url: ... (Caused by SSLError(SSLError(1, '[SSL: DH_KEY_TOO_SMALL] dh key too small (_ssl.c:997)')))
requests.exceptions.SSLError: HTTPSConnectionPool(host='somehost.com', port=443): Max retries exceeded with url: myurl (Caused by SSLError(SSLError(1, '[SSL: WRONG_SIGNATURE_TYPE] wrong signature type (_ssl.c:1108)')))
```

简单分析了一下原因，最新版本的SSL默认不使用弱DH（DH：即Diffie-Hellman，密钥交换协议/算法），因此会报错。

解决思路也比较简单，主要两种：

1. 设置或添加默认值
2. 回退版本

第2种方法适合一些虚拟机、docker之类的，比如把ubuntu20.04改成ubuntu18.04。而在我们自己的主机环境下时，推荐在Python脚本中添加代码修改

- 解决方案1：添加默认密码字符串

```python
import requests

requests.packages.urllib3.util.ssl_.DEFAULT_CIPHERS += ':HIGH:!DH:!aNULL'

...
```

- 解决方案2：降低SECLEVEL级别

```python
import requests

requests.packages.urllib3.util.ssl_.DEFAULT_CIPHERS = 'DEFAULT:@SECLEVEL=1'

...
```

