# PyInstaller spec for the bundled backend: a folder build (not one-file, which would unpack to a temp dir on every start).
# Build with tools/build-backend.ps1. Her voice (Kokoro) and speech recognition (faster-whisper) pull in torch and are left out;
# without them the desktop app uses the computer's own voice (see backend/README.md).
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

hidden = collect_submodules("uvicorn") + collect_submodules("novaai") + ["httptools", "websockets", "h11"]
datas = collect_data_files("novaai")   # models.json and any other non-Python files in the package

a = Analysis(
    ["novaai_server.py"],
    pathex=["."],
    datas=datas,
    hiddenimports=hidden,
    excludes=["kokoro", "torch", "faster_whisper", "ctranslate2", "tkinter", "pytest"],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="novaai-server", console=True)
coll = COLLECT(exe, a.binaries, a.datas, name="novaai-server")
