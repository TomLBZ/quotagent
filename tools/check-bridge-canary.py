"""薄转发（迁移阶段 4.1）：src/system/canary/tests/check-bridge-canary.py"""
import runpy
from pathlib import Path
runpy.run_path(str(Path(__file__).resolve().parents[1] / "src/system/canary/tests/check-bridge-canary.py"), run_name="__main__")
