#!/bin/sh
# 只在证书续期完成且配置校验通过后平滑重载HTTPS入口。
set -eu
/usr/sbin/nginx -t
/bin/systemctl reload nginx
