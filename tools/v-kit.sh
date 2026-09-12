#!/bin/sh
# 打包某条 V（或无参数时全部）的现场材料。
#   tools/v-kit.sh V-002             → tmp/v-kit/V-002/
#   tools/v-kit.sh --all             → tmp/v-kit/all/
#   tools/v-kit.sh V-002 --out DIR   → DIR/
# 只复制已入库的材料（执行包 + 模板 + 示例），不生成任何新事实、不写仓库外文件。
set -u
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
VDIR="$ROOT/docs/work/validation"

usage() {
  echo "用法: tools/v-kit.sh V-001..V-012|--all [--out DIR]" >&2
  exit 2
}

TARGET=""
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --all) TARGET="all" ;;
    --out) shift; [ $# -gt 0 ] || usage; OUT="$1" ;;
    -h|--help) usage ;;
    *) TARGET="$1" ;;
  esac
  shift
done

[ -n "$TARGET" ] || usage
if [ "$TARGET" != "all" ] && [ ! -f "$VDIR/$TARGET.md" ]; then
  echo "未知的验证条目: $TARGET（已知: $(ls "$VDIR" | grep '^V-' | sed 's/\.md$//' | tr '\n' ' '))" >&2
  exit 2
fi
[ -n "$OUT" ] || OUT="$ROOT/tmp/v-kit/$TARGET"
mkdir -p "$OUT"

collect() {
  item="$1"
  dest="$2"
  mkdir -p "$dest"
  cp "$VDIR/$item.md" "$dest/$item.txt"
  # 执行包“准备的材料”小节里以 backtick 标出的模板/示例路径
  sed -n '/## 准备的材料/,/## 怎么做/p' "$VDIR/$item.md" \
    | grep -o '`[^`]*\(templates\|examples\)/[^`]*`' | tr -d '`' | sort -u \
    | while read -r rel; do
        if [ -f "$VDIR/$rel" ]; then
          case "$rel" in
            *.md) out=$(basename "$rel" .md).txt ;;
            *) out=$(basename "$rel") ;;
          esac
          cp "$VDIR/$rel" "$dest/$out" && echo "  + $out"
        fi
      done
  if [ "$item" = "V-002" ] && [ ! -f "$dest/V-002-example-filled.csv" ]; then
    cp "$VDIR/examples/V-002-example-filled.csv" "$dest/" 2>/dev/null && echo "  + examples/V-002-example-filled.csv"
  fi
}

if [ "$TARGET" = "all" ]; then
  for item in V-001 V-002 V-003 V-004 V-005 V-006 V-007 V-008 V-009 V-010 V-011 V-012; do
    echo "[$item]"
    collect "$item" "$OUT/$item"
  done
  echo
  echo "全部材料已打包到: $OUT"
  echo "下一步: 读 docs/work/validation/README.md 的『接手指令』；结论写进 docs/work/validation/register.json"
  exit 0
fi

echo "[$TARGET] 材料打包中"
collect "$TARGET" "$OUT"
echo
echo "打包位置: $OUT"
echo "文件清单:"
ls -1 "$OUT" | sed 's/^/  /'
echo
echo "这一条的『放回哪里』（摘自执行包）:"
sed -n '/## 放回哪里/,$p' "$VDIR/$TARGET.md" | sed '1d;/^$/d;s/^/  /'
echo
echo "登记表: docs/work/validation/register.json → checks[$TARGET]"
echo "校验:    tools/verify.sh v"
