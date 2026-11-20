"""The API process must never load the vision stack (cv2, onnxruntime, PIL: ~43 MB).

Recognition runs in the worker process pool, and the job returns backend-local built-ins.
This runs in a fresh subprocess, because other tests import `sudoku_vision` in-process
(thread mode) and would pollute `sys.modules`.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

FIXTURE = Path(__file__).resolve().parents[2] / "vision" / "tests" / "fixtures" / "synth_7_00.jpg"

SCRIPT = r"""
import sys

from fastapi.testclient import TestClient
from sudoku_api.config import Settings
from sudoku_api.main import create_app
from sudoku_api.models import Base, User, utcnow
from sudoku_api.security import create_access_token

HEAVY = ("cv2", "onnxruntime", "PIL", "sudoku_vision")


def main() -> int:
    settings = Settings(
        _env_file=None,
        jwt_secret="isolation-test-secret-" + "x" * 30,
        database_url="sqlite://",
        rate_limit_enabled=False,
        pool_worker_enabled=False,
        email_backend="console",
        puzzle_source="fixture",
        generator_processes=1,
        log_json=False,
    )
    app = create_app(settings)
    Base.metadata.create_all(app.state.engine)
    with app.state.session_factory() as s:
        user = User(username="iso", email="iso@example.com", password_hash="x",
                    email_verified_at=utcnow())
        s.add(user)
        s.commit()
        token = create_access_token(user.id, settings)
    image = open(sys.argv[1], "rb").read()
    with TestClient(app, base_url="https://testserver") as client:
        r = client.post(
            "/api/v1/imports/recognize",
            files={"file": ("g.jpg", image, "image/jpeg")},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert r.status_code == 200, r.text
    assert len(r.json()["cells"]) == 81
    loaded = sorted(m for m in sys.modules if m.split(".")[0] in HEAVY)
    print("LOADED:", loaded)
    return 1 if loaded else 0


if __name__ == "__main__":  # required: the worker pool uses the spawn context
    sys.exit(main())
"""


def test_api_process_never_imports_vision_stack(tmp_path: Path) -> None:
    script = tmp_path / "isolation_check.py"
    script.write_text(SCRIPT)
    result = subprocess.run(
        [sys.executable, str(script), str(FIXTURE)],
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "LOADED: []" in result.stdout
