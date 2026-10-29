"""Entry point for the frozen backend (novaai-server.exe). `python -m novaai` does the same from source."""
import multiprocessing
import sys

from novaai.__main__ import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    # No arguments (a double-click) means serve, like `python -m novaai`.
    sys.exit(main())
