#!/usr/bin/env python3
"""Workspace gateway launcher for the native Cordis product composition."""
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[4]
if '--healthz' in sys.argv:
    port = sys.argv[sys.argv.index('--healthz') + 1]
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/quotagent/api/health', timeout=3) as response:
            sys.exit(0 if response.status == 200 else 1)
    except (OSError, socket.timeout):
        sys.exit(1)
if not (ROOT / 'host/node_modules/cordis').exists():
    subprocess.run(['npm', 'ci', '--prefix', str(ROOT / 'host'), '--no-audit', '--no-fund'], check=True)
if not (ROOT / 'src/system/webui/client/dist/index.html').exists():
    subprocess.run(['npm', '--prefix', str(ROOT / 'host'), 'run', 'build'], check=True, cwd=ROOT)
os.chdir(ROOT)
node = shutil.which('node')
if not node:
    raise RuntimeError('Node.js is required; activate the workspace runtime first.')
os.execvpe(node, [node, str(ROOT / 'host/product.mjs')], os.environ)
