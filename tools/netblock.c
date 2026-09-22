/*
 * netblock.c —— 一键运行**断网验收**用的最小 LD_PRELOAD 垫片（`tools/verify.sh run-once` 编译到 tmp/ 里用）。
 *
 * 它做什么：把**非回环**的对外连接与域名解析**拒绝**掉，并把每次尝试记一行到 $QUOTAGENT_NETBLOCK_LOG
 * （缺省不写日志文件）。回环（127.0.0.0/8、::1）放行 —— 服务自身的健康检查要走它。
 *
 * 为什么需要它：本环境里 `unshare -n`（网络命名空间）被内核/权限拒绝（实测 "Operation not permitted"），
 * 所以做不到内核级断网。这个垫片是**进程级**的等效手段：任何 `connect()`/`getaddrinfo()` 只要指向外网
 * 就被拒（返回值与 errno 按真实失败语义给），于是"不访问网络也能 up"这条判据可以真跑而不是靠嘴说。
 *
 * 诚实边界（门会把这一行打出来）：它只能拦 **libc 层** 的调用 —— 静态链接的二进制、直接发 raw syscall、
 * 或不经 libc 的运行时不受它管。所以它证明的是"这条启动路径在 libc 层没有依赖外网"，不是"物理断网"。
 *
 * 编译：gcc -shared -fPIC -O0 -o netblock.so netblock.c -ldl
 * 用法：LD_PRELOAD=/path/netblock.so QUOTAGENT_NETBLOCK_LOG=/path/attempts.log ./run up ...
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <netdb.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int (*real_connect)(int, const struct sockaddr *, socklen_t) = NULL;
static int (*real_getaddrinfo)(const char *, const char *, const struct addrinfo *, struct addrinfo **) = NULL;

/* 失败尝试的留痕（一行一条：kind + 目标）。文件不存在就不写；写失败不影响判定。 */
static void log_attempt(const char *kind, const char *target) {
  const char *path = getenv("QUOTAGENT_NETBLOCK_LOG");
  if (path == NULL || path[0] == '\0') return;
  FILE *fp = fopen(path, "a");
  if (fp == NULL) return;
  fprintf(fp, "%s %s\n", kind, target);
  fclose(fp);
}

/* 回环判定：127.0.0.0/8（含 127.0.0.1）、::1、以及 AF_UNIX 都算"本机"。 */
static int is_local(const struct sockaddr *addr) {
  if (addr == NULL) return 1;
  if (addr->sa_family == AF_UNIX) return 1;
  if (addr->sa_family == AF_INET) {
    const struct sockaddr_in *v4 = (const struct sockaddr_in *)addr;
    unsigned char b0 = (unsigned char)((ntohl(v4->sin_addr.s_addr) >> 24) & 0xff);
    return b0 == 127;
  }
  if (addr->sa_family == AF_INET6) {
    const struct sockaddr_in6 *v6 = (const struct sockaddr_in6 *)addr;
    static const unsigned char loopback[16] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1};
    if (memcmp(&v6->sin6_addr, loopback, 16) == 0) return 1;
    if (IN6_IS_ADDR_V4MAPPED(&v6->sin6_addr)) {
      unsigned char *raw = (unsigned char *)&v6->sin6_addr;
      return raw[12] == 127;
    }
    return 0;
  }
  return 0;
}

int connect(int fd, const struct sockaddr *addr, socklen_t len) {
  if (real_connect == NULL) real_connect = dlsym(RTLD_NEXT, "connect");
  if (!is_local(addr)) {
    char shown[64] = "non-loopback";
    if (addr != NULL && addr->sa_family == AF_INET) {
      const struct sockaddr_in *v4 = (const struct sockaddr_in *)addr;
      char ip[INET_ADDRSTRLEN] = "?";
      inet_ntop(AF_INET, &v4->sin_addr, ip, sizeof(ip));
      snprintf(shown, sizeof(shown), "%s:%u", ip, (unsigned)ntohs(v4->sin_port));
    }
    log_attempt("connect", shown);
    errno = ENETUNREACH;            /* 与"没有路由"同一语义：调用方应当按网络不可用处理 */
    return -1;
  }
  return real_connect(fd, addr, len);
}

int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints,
                struct addrinfo **res) {
  if (real_getaddrinfo == NULL) real_getaddrinfo = dlsym(RTLD_NEXT, "getaddrinfo");
  if (node != NULL && strcmp(node, "localhost") != 0 && strcmp(node, "127.0.0.1") != 0
      && strcmp(node, "::1") != 0 && strcmp(node, "ip6-localhost") != 0) {
    log_attempt("getaddrinfo", node);
    return EAI_FAIL;                /* 名字解析一律失败（DNS 不可用） */
  }
  return real_getaddrinfo(node, service, hints, res);
}
