"""薄转发（迁移阶段 4.1）：src/system/config/tests/check-config-route.py"""
import runpy
from pathlib import Path
runpy.run_path(str(Path(__file__).resolve().parents[1] / "src/system/config/tests/check-config-route.py"), run_name="__main__")
