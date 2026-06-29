from pathlib import Path

import uvicorn


if __name__ == "__main__":
    root = Path(__file__).resolve().parent
    uvicorn.run("backend.app:app", host="127.0.0.1", port=8000, app_dir=str(root))
