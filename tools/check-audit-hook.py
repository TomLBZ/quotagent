"""薄转发（迁移阶段 4.1）：src/system/audit-hook/tests/check-audit-hook.py"""
import runpy
from pathlib import Path
runpy.run_path(str(Path(__file__).resolve().parents[1] / "src/system/audit-hook/tests/check-audit-hook.py"), run_name="__main__")
