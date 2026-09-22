"""薄转发（迁移阶段 4.1）：src/system/mail/tools/mail-snapshot.py"""
import runpy
from pathlib import Path
runpy.run_path(str(Path(__file__).resolve().parents[1] / "src/system/mail/tools/mail-snapshot.py"), run_name="__main__")
