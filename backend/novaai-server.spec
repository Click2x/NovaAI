# PyInstaller spec for the bundled backend: a folder build (not one-file, which would unpack to a temp dir on every start).
# Build with tools/build-backend.ps1. Her voice (kokoro-onnx) and ears (faster-whisper) run without torch, so they are bundled; their model
# files are the voice pack (novaai/voicepack.py), downloaded at setup. The torch build of Kokoro is left out.
from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

hidden = collect_submodules("uvicorn") + collect_submodules("novaai") + ["httptools", "websockets", "h11"]
datas = collect_data_files("novaai")   # models.json and any other non-Python files in the package
binaries = []
# Packages with native libraries or data files PyInstaller does not find by import alone.
for pkg in ("kokoro_onnx", "espeakng_loader", "phonemizer", "language_tags", "segments", "csvw", "onnxruntime", "ctranslate2", "faster_whisper", "av", "tokenizers"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hidden += h

a = Analysis(
    ["novaai_server.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hidden,
    excludes=["kokoro", "torch", "tkinter", "pytest"],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="novaai-server", console=True)
coll = COLLECT(exe, a.binaries, a.datas, name="novaai-server")
