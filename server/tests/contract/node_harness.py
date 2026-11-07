"""
Runs the v3 (Python) API test suite against the Node.js server over HTTP,
to prove the v4 port behaves identically. Starts a real Node server on a
temporary SQLite database (or TEST_DATABASE_URL), like a browser would use it.
"""
import atexit
import json as _json
import os
import socket
import sqlite3
import subprocess
import tempfile
import time
from pathlib import Path

import requests

SERVER_DIR = Path(__file__).resolve().parents[2]
TMP = tempfile.mkdtemp(prefix="iskolens-v4-test-")
DB_URL = os.environ.get("TEST_DATABASE_URL", f"sqlite:///{TMP}/test.db")
_procs = []


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def env(**extra):
    e = dict(os.environ)
    e.update({"DATABASE_URL": DB_URL, "BCRYPT_ROUNDS": "4", "MAIL_SERVER": "", "INSTANCE_DIR": TMP,
              "DOCUMENTS_DIR": f"{TMP}/documents", "BACKUP_DIR": f"{TMP}/backups",
              "RATE_LIMIT_FAILED_LOGINS": "1000", "RATE_LIMIT_PASSWORD_RESETS": "1000", "RATE_LIMIT_SIGNUPS": "1000",
              "SECRET_KEY": "test-secret"})
    e.update({k: str(v) for k, v in extra.items()})
    return e


def cli(*args, **extra):
    r = subprocess.run(["node", "src/cli.js", *args], cwd=SERVER_DIR, env=env(**extra), capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr or r.stdout)
    return r.stdout.strip()


def start_server(**extra):
    port = _free_port()
    p = subprocess.Popen(["node", "src/server.js"], cwd=SERVER_DIR, env=env(PORT=port, **extra),
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    _procs.append(p)
    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            requests.get(base + "/api/auth/csrf", timeout=1)
            return base
        except requests.RequestException:
            time.sleep(0.1)
    raise RuntimeError("Node server did not start: " + p.stdout.read().decode()[:2000])


@atexit.register
def _stop():
    for p in _procs:
        p.terminate()


def sql(statement, params=()):
    """Direct database change, standing in for the v3 tests' SQLAlchemy edits."""
    if DB_URL.startswith("sqlite:///"):
        con = sqlite3.connect(DB_URL[len("sqlite:///"):])
        con.execute(statement, params)
        con.commit()
        con.close()
    else:
        import pymysql
        import re
        m = re.match(r"mysql(?:\+\w+)?://([^:@/]*)(?::([^@/]*))?@([^:/?]+)(?::(\d+))?/([^?]+)", DB_URL)
        con = pymysql.connect(user=m[1], password=m[2] or "", host=m[3], port=int(m[4] or 3306), database=m[5])
        with con.cursor() as cur:
            cur.execute(statement.replace("?", "%s"), params)
        con.commit()
        con.close()


class Resp:
    def __init__(self, r):
        self.status_code = r.status_code
        self.data = r.content
        self.mimetype = (r.headers.get("Content-Type") or "").split(";")[0].strip()
        self.is_json = self.mimetype == "application/json"

    def get_json(self, silent=False):
        try:
            return _json.loads(self.data)
        except ValueError:
            if silent:
                return None
            raise


class HttpClient:
    """Same interface as Flask's test client, but talking to the Node server."""

    def __init__(self, base):
        self.base = base
        self.s = requests.Session()

    def open(self, method, url, json=None, headers=None, data=None, content_type=None):
        files = None
        if data and content_type == "multipart/form-data":
            files, form = {}, {}
            for k, v in data.items():
                if isinstance(v, tuple):
                    stream, name = v
                    files[k] = (name, stream.read())
                else:
                    form[k] = v
            data = form
        r = self.s.request(method.upper(), self.base + url, json=json, headers=headers or {}, data=data, files=files,
                           allow_redirects=False)
        return Resp(r)

    def __getattr__(self, method):
        if method in ("get", "post", "patch", "put", "delete"):
            return lambda url, **kw: self.open(method, url, **kw)
        raise AttributeError(method)
