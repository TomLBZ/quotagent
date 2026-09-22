"""薄转发（迁移阶段 4.1）：src/system/runtime/tests/check-run-once.py"""
import runpy
from pathlib import Path
runpy.run_path(str(Path(__file__).resolve().parents[1] / "src/system/runtime/tests/check-run-once.py"), run_name="__main__")
