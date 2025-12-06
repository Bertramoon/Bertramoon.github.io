---
title: docker安装及常用命令
date: 2023/06/12
tags:
  - docker
categories:
  - 容器
---

## 安装

### Linux

建议使用国内镜像软件源。具体步骤为：

1. 开启最高权限

```
sudo -i
```

2. 备份源文件

```
cp /etc/apt/sources.list /etc/apt/sources.list.backup
```

3. 清空sources.list并插入新配置（最好去[阿里云](https://developer.aliyun.com/mirror/ )等镜像网站更换虚拟机软件镜像）

4. 更新软件源

```
apt-get update
```

5. 下载docker

```
apt-get install docker.io
```

## 基本使用过程

1. 搜索镜像
2. 下载镜像 
3. 创建并运行实例
4. 通过外部链接访问容器，或者连接容器内部进行文件操作等


## 常用命令

### 操作镜像

**搜索镜像**
`docker search <mirror name>`

**查看镜像**
`docker image ls`

**下载镜像**
`docker pull <mirror name>`

**构建镜像**
`docker build -t <tagname:tagvalue> -f <dockfile path> [--no-cache]`

**删除镜像**
`docker rmi <mirror name>`

### 操作容器

**查看所有容器**
`docker ps -a`

**查看当前运行中的容器**
`docker ps`

**返回运行中容器的id**
`docker ps -q`

**查看运行状态**
`docker stats`

**创建容器**

在后台运行，返回ID值
`docker run --name <container name> -d -p <local port>:<container port> <mirror name>`

以交互模式创建
`docker run --name <container name> -i -t -p <local port>:<container port> <mirror name>`

`--link <container name>`：关联容器

`-v <local dir>:<container dir>`：将本地目录与容器目录做映射，方便对容器内部数据的存取，也方便容器可以操作外部数据

**启动容器**
`docker start <container name>`

**重启容器**
`docker restart <container name>`

**连接容器**
`docker exec -it <container name> /bin/bash`

**终止容器**
`docker stop <container name>`

**删除容器**
`docker rm <container name>`

### 文件操作

**复制到本地**
`docker cp <container name>:<container path> <local path>`

---

## WEB安全常用镜像下载

### upload-labs

```bash
docker pull c0ny1/upload-labs
docker run --name upload-labs -d -p 8081:80 c0ny1/upload-labs
```

### sqli-labs

```bash
docker pull acgpiano/sqli-labs
docker run --name sqli-labs -d -p 8082:80 acgpiano/sqli-labs
```

### dvwa

```
docker pull citizenstig/dvwa
docker run --name dvwa -d -p 8083:80 citizenstig/dvwa
```

### pikachu

```bash
docker pull area39/pikachu
docker run --name pikachu -d -p 8084:80 area39/pikachu
```

### AWVS

```bash
docker pull secfa/docker-awvs
docker run --name awvs -d -p 13443:3443 secfa/docker-awvs
```

> awvs13 username: admin@admin.com
> awvs13 password: Admin123

