from pathlib import Path

import uvicorn


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    uvicorn.run(
        "backend.app:app",
        host="127.0.0.1",
        port=8000,
        reload=True,
        app_dir=str(root),
        reload_dirs=[str(root / "backend")],
    )
