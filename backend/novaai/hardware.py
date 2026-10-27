"""What the machine can run: GPU memory and RAM, and the tier the model router plans for."""
from __future__ import annotations

import ctypes
import os
import subprocess
from dataclasses import asdict, dataclass

TIERS = ("cpu", "low", "mid", "high")   # cpu: no usable GPU; low: <8 GB; mid: 8-15.9 GB; high: 16 GB and up
RESERVE_GB = 1.5                        # left for the desktop, the avatar and the context cache


@dataclass(frozen=True)
class Hardware:
    gpu_name: str = ""
    vram_gb: float = 0.0
    ram_gb: float = 0.0

    @property
    def tier(self) -> str:
        if self.vram_gb <= 0:
            return "cpu"
        return "low" if self.vram_gb < 8 else "mid" if self.vram_gb < 16 else "high"

    @property
    def budget_gb(self) -> float:
        """Memory one model may use: GPU memory minus a reserve, or half the RAM when there is no GPU."""
        return max(self.vram_gb - RESERVE_GB, 0.0) if self.vram_gb > 0 else max(self.ram_gb * 0.5, 0.0)

    def to_dict(self) -> dict:
        return {**asdict(self), "tier": self.tier, "budget_gb": round(self.budget_gb, 1)}


def _ram_gb() -> float:
    try:
        if os.name == "nt":
            class MEM(ctypes.Structure):
                _fields_ = [("l", ctypes.c_ulong), ("load", ctypes.c_ulong), ("total", ctypes.c_ulonglong), ("avail", ctypes.c_ulonglong),
                            ("pt", ctypes.c_ulonglong), ("pa", ctypes.c_ulonglong), ("vt", ctypes.c_ulonglong), ("va", ctypes.c_ulonglong), ("ve", ctypes.c_ulonglong)]
            m = MEM()
            m.l = ctypes.sizeof(MEM)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):   # type: ignore[attr-defined]
                return round(m.total / 1024**3, 1)
        else:
            return round(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024**3, 1)
    except (OSError, ValueError, AttributeError):
        pass
    return 0.0


def detect(run=subprocess.run) -> Hardware:
    """Best GPU by memory via nvidia-smi (3 s timeout); no nvidia-smi, no GPU. Never raises."""
    name, vram = "", 0.0
    try:
        r = run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=3)
        if r.returncode == 0:
            for line in r.stdout.strip().splitlines():
                parts = [p.strip() for p in line.rsplit(",", 1)]
                if len(parts) == 2 and parts[1].replace(".", "", 1).isdigit():
                    mem = float(parts[1]) / 1024
                    if mem > vram:
                        name, vram = parts[0], mem
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return Hardware(gpu_name=name, vram_gb=round(vram, 1), ram_gb=_ram_gb())
