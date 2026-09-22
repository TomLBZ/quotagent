"""薄转发（迁移阶段 4.1）：src/system/pipeline-view/tests/check-pipeline-route.py"""
import runpy
from pathlib import Path
runpy.run_path(str(Path(__file__).resolve().parents[1] / "src/system/pipeline-view/tests/check-pipeline-route.py"), run_name="__main__")
