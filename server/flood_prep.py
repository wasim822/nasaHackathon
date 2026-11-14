"""Real NISAR flood input: water classification from NISAR L2 GCOV backscatter.

For every NISAR pass over the area of interest (AOI) this script:
  1. finds GCOV products in NASA CMR (validated preferred over provisional),
  2. reads ONLY the AOI window of the 80 m frequency-B HH and HV backscatter (+ valid mask)
     with authenticated HTTP range requests — not the multi-GB file,
  3. averages backscatter (in dB) into the app's ~0.55 km Web-Mercator grid cells,
  4. learns per-pass water thresholds from JRC Global Surface Water reference cells
     (persistent water vs. never-water), classifies each cell water / dry / no-data,
  5. mosaics frames of the same pass and writes compact files the web app loads:
        public/data/nisar-flood/<aoi>/manifest.json
        public/data/nisar-flood/<aoi>/<pass-id>.bin   (uint8 per cell: 0 no data, 1 dry, 2 water)

The Earthdata token is read from .env.local and only used here, never shipped to the browser.

Usage:  server/.venv/Scripts/python server/flood_prep.py --start 2026-06-01 --end 2026-11-14
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import io
import json
import math
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import h5py
import numpy as np
import requests
from PIL import Image
from pyproj import Transformer

sys.path.insert(0, str(Path(__file__).parent))
from httpfile import HttpRangeFile, earthdata_token  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(__file__).parent / "cache"
CMR = "https://cmr.earthdata.nasa.gov/search/granules.json"
JRC = "https://storage.googleapis.com/global-surface-water/tiles2021/occurrence/{z}/{x}/{y}.png"

# Must match src/features/flood/baseline.ts (AOI) exactly.
AOIS = {
    "stl": dict(name="Mississippi–Missouri confluence, St. Louis (USA)", z=9, x0=126, y0=195, tiles_x=3, tiles_y=3, cells_per_tile=128,
                out="nisar-flood"),
    "atchafalaya": dict(name="Atchafalaya Basin wetlands, Louisiana (USA)", z=9, x0=124, y0=209, tiles_x=3, tiles_y=3, cells_per_tile=128,
                        out="nisar-wetland"),
}
COLLECTIONS = [("NISAR_L2_GCOV_V1", "Validated"), ("NISAR_L2_GCOV_PROVISIONAL_V1", "Provisional")]

# Classification parameters (documented in the manifest).
MIN_VALID_FRACTION = 0.3   # of the expected 80 m samples in a cell
THRESH_CLAMP_HH = (-20.0, -11.0)
THRESH_CLAMP_HV = (-28.0, -16.0)
MIN_SEPARATION_DB = 2.0
# Possible inundated vegetation (L-band double bounce): very bright HH with a strong HH/HV ratio.
IV_MIN_HH_DB = -3.0
IV_MIN_RATIO_DB = 7.0
# Cells "inundated vegetation" in at least this share of >= PERSIST_MIN_PASSES passes are treated
# as persistently bright structures (urban, bridges) rather than seasonal flooding.
PERSIST_SHARE = 0.9
PERSIST_MIN_PASSES = 5


try:  # Windows consoles default to cp1252
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:
    pass


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def load_env():
    env = ROOT / ".env.local"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


# ---------------------------------------------------------------- grid
def tile_lat(y: float, z: int) -> float:
    n = math.pi - 2 * math.pi * y / 2 ** z
    return math.degrees(math.atan(math.sinh(n)))


def merc_y(lat):
    return np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))


class Grid:
    def __init__(self, a: dict):
        self.cols = a["tiles_x"] * a["cells_per_tile"]
        self.rows = a["tiles_y"] * a["cells_per_tile"]
        z = a["z"]
        self.west = a["x0"] / 2 ** z * 360 - 180
        self.east = (a["x0"] + a["tiles_x"]) / 2 ** z * 360 - 180
        self.north = tile_lat(a["y0"], z)
        self.south = tile_lat(a["y0"] + a["tiles_y"], z)
        self.yN = float(merc_y(self.north))
        self.yS = float(merc_y(self.south))

    def cell_index(self, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        c = np.floor((lon - self.west) / (self.east - self.west) * self.cols)
        r = np.floor((self.yN - merc_y(lat)) / (self.yN - self.yS) * self.rows)
        ok = (c >= 0) & (c < self.cols) & (r >= 0) & (r < self.rows)
        idx = np.where(ok, r * self.cols + c, -1)
        return idx.astype(np.int64)

    def cell_area_km2(self) -> np.ndarray:
        R = 6371.0088
        lat_edges = np.degrees(np.arctan(np.sinh(np.linspace(self.yN, self.yS, self.rows + 1))))
        dlng = math.radians((self.east - self.west) / self.cols)
        row = R * R * dlng * np.abs(np.sin(np.radians(lat_edges[:-1])) - np.sin(np.radians(lat_edges[1:])))
        return np.repeat(row, self.cols)


def jrc_occurrence(a: dict, grid: Grid) -> np.ndarray:
    """Same resampling as the web app: mean of the blue channel over each 2x2 px cell."""
    px = 256 // a["cells_per_tile"]
    occ = np.zeros((grid.rows, grid.cols), np.uint8)
    for ty in range(a["tiles_y"]):
        for tx in range(a["tiles_x"]):
            url = JRC.format(z=a["z"], x=a["x0"] + tx, y=a["y0"] + ty)
            img = np.asarray(Image.open(io.BytesIO(requests.get(url, timeout=60).content)).convert("RGBA")).astype(np.float32)
            blue = np.where(img[..., 3] > 0, img[..., 2], 0)
            n = a["cells_per_tile"]
            cell = blue.reshape(n, px, n, px).mean(axis=(1, 3))
            occ[ty * n:(ty + 1) * n, tx * n:(tx + 1) * n] = np.minimum(100, np.round(cell * 100 / 255)).astype(np.uint8)
    return occ.ravel()


# ---------------------------------------------------------------- search
def parse_track(title: str):
    m = re.search(r"_(\d{3})_(\d{3})_([AD])_(\d{3})_", title)
    return (int(m.group(2)), m.group(3), int(m.group(4))) if m else (None, None, None)


def search(grid: Grid, start: str, end: str):
    out = {}
    for short, status in COLLECTIONS:
        page = 1
        while True:
            r = requests.get(CMR, params={
                "short_name": short, "bounding_box": f"{grid.west},{grid.south},{grid.east},{grid.north}",
                "temporal": f"{start}T00:00:00Z,{end}T23:59:59Z", "page_size": 200, "page_num": page, "sort_key": "start_date",
            }, timeout=60)
            r.raise_for_status()
            entries = r.json()["feed"]["entry"]
            for e in entries:
                h5 = next((l["href"] for l in e["links"] if l["href"].startswith("https") and l["href"].endswith(".h5") and "/NISAR/" in l["href"]), None)
                if not h5:
                    continue
                track, direction, frame = parse_track(e["title"])
                key = (track, direction, frame, e["time_start"][:16])
                g = dict(title=e["title"], url=h5, start=e["time_start"], end=e.get("time_end", e["time_start"]),
                         status=status, track=track, direction=direction, frame=frame)
                if key not in out or (out[key]["status"] == "Provisional" and status == "Validated"):
                    out[key] = g
            if len(entries) < 200:
                break
            page += 1
    return sorted(out.values(), key=lambda g: g["start"])


# ---------------------------------------------------------------- per-granule classification
def train_threshold(values: np.ndarray, ref_water: np.ndarray, ref_land: np.ndarray, clamp):
    """Threshold between the dark mode of reference-water pixels and the dark tail of land.

    Reference water = pixels in JRC persistent-water cells (some are bank pixels, so the 25th
    percentile is used as the typical water value); reference land = pixels in never-water
    cells (5th percentile, i.e. the darkest common land). Midpoint, clamped.
    """
    w = values[ref_water]
    l = values[ref_land]
    if len(w) < 200 or len(l) < 2000:
        return None, None
    pw, pl = float(np.percentile(w, 25)), float(np.percentile(l, 5))
    return min(max((pw + pl) / 2, clamp[0]), clamp[1]), pl - pw


def read_granule(g: dict, grid: Grid, token: str) -> dict:
    """Reads the AOI window of one GCOV product (80 m frequency B). Returns the grid-cell
    index and HH/HV dB of every valid sample (cached to disk as compact arrays)."""
    CACHE.mkdir(exist_ok=True)
    cpath = CACHE / f"{g['title']}_px.npz"
    if cpath.exists():
        d = np.load(cpath)
        return {k: d[k] for k in d.files}
    f = HttpRangeFile(g["url"], token)
    empty = dict(idx=np.zeros(0, np.int32), hh=np.zeros(0, np.float16), hv=np.zeros(0, np.float16))
    with h5py.File(f, "r") as h:
        gb = h["science/LSAR/GCOV/grids/frequencyB"]
        epsg = int(gb["projection"].attrs["epsg_code"])
        xs = gb["xCoordinates"][()]
        ys = gb["yCoordinates"][()]
        to_utm = Transformer.from_crs(4326, epsg, always_xy=True)
        to_ll = Transformer.from_crs(epsg, 4326, always_xy=True)
        lons = np.concatenate([np.linspace(grid.west, grid.east, 50)] * 2 + [np.full(50, grid.west), np.full(50, grid.east)])
        lats = np.concatenate([np.full(50, grid.north), np.full(50, grid.south), np.linspace(grid.south, grid.north, 50), np.linspace(grid.south, grid.north, 50)])
        ux, uy = to_utm.transform(lons, lats)
        dx = xs[1] - xs[0]
        dy = ys[1] - ys[0]
        c0 = int(np.clip(np.floor((ux.min() - xs[0]) / dx), 0, len(xs)))
        c1 = int(np.clip(np.ceil((ux.max() - xs[0]) / dx) + 1, 0, len(xs)))
        r0 = int(np.clip(np.floor((uy.max() - ys[0]) / dy), 0, len(ys)))
        r1 = int(np.clip(np.ceil((uy.min() - ys[0]) / dy) + 1, 0, len(ys)))
        pols = [p.decode() for p in gb["listOfPolarizations"][()]]
        if c1 - c0 < 2 or r1 - r0 < 2 or "HV" not in pols:
            np.savez_compressed(cpath, **empty)
            return empty
        mask = gb["mask"][r0:r1, c0:c1]
        hh = gb["HHHH"][r0:r1, c0:c1]
        hv = gb["HVHV"][r0:r1, c0:c1]
    X, Y = np.meshgrid(xs[c0:c1], ys[r0:r1])
    lon, lat = to_ll.transform(X, Y)
    idx = grid.cell_index(lat, lon).ravel()
    with np.errstate(invalid="ignore", divide="ignore"):
        hh_db = 10 * np.log10(hh.ravel())
        hv_db = 10 * np.log10(hv.ravel())
    m = mask.ravel()
    valid = (idx >= 0) & (m >= 1) & (m <= 254) & np.isfinite(hh_db) & np.isfinite(hv_db)
    out = dict(idx=idx[valid].astype(np.int32), hh=hh_db[valid].astype(np.float16), hv=hv_db[valid].astype(np.float16))
    log(f"  read {g['title'][17:60]}… {f.bytes_fetched / 1e6:.0f} MB, {valid.sum():,} valid samples")
    np.savez_compressed(cpath, **out)
    return out


def classify_pass(frames: list[dict], occ: np.ndarray, expected: np.ndarray):
    """Classifies one pass. Thresholds are trained on the pooled samples of all its frames
    (same orbit, minutes apart). HH is required; HV is added only if it separates water from
    land on this pass. Per cell, the frame with most valid samples is used; a cell is water if
    at least 50% of those samples are water. Returns (cells, quality) or (None, quality)."""
    n = len(expected)
    idx = np.concatenate([f["idx"] for f in frames]) if frames else np.zeros(0, np.int32)
    hh = np.concatenate([f["hh"] for f in frames]).astype(np.float32) if frames else np.zeros(0, np.float32)
    hv = np.concatenate([f["hv"] for f in frames]).astype(np.float32) if frames else np.zeros(0, np.float32)
    pocc = occ[idx] if len(idx) else np.zeros(0, np.uint8)
    ref_w = pocc >= 90
    ref_l = pocc == 0
    t_hh, sep_hh = train_threshold(hh, ref_w, ref_l, THRESH_CLAMP_HH)
    t_hv, sep_hv = train_threshold(hv, ref_w, ref_l, THRESH_CLAMP_HV)
    use_hv = t_hv is not None and sep_hv is not None and sep_hv >= MIN_SEPARATION_DB
    r2 = lambda v: None if v is None else round(float(v), 2)  # noqa: E731
    quality = dict(threshold_hh_db=r2(t_hh), separation_hh_db=r2(sep_hh), threshold_hv_db=r2(t_hv) if use_hv else None,
                   separation_hv_db=r2(sep_hv), channels="HH+HV" if use_hv else "HH", frames=len(frames))
    if t_hh is None or sep_hh < MIN_SEPARATION_DB:
        return None, quality
    cnt = np.zeros(n)
    wfrac = np.zeros(n)
    vfrac = np.zeros(n)
    for f in frames:
        if not len(f["idx"]):
            continue
        fh = f["hh"].astype(np.float32)
        fv = f["hv"].astype(np.float32)
        water = fh < t_hh
        if use_hv:
            water &= fv < t_hv
        inveg = (fh >= IV_MIN_HH_DB) & (fh - fv >= IV_MIN_RATIO_DB) & ~water
        c = np.bincount(f["idx"], minlength=n).astype(float)
        w = np.bincount(f["idx"][water], minlength=n).astype(float)
        v = np.bincount(f["idx"][inveg], minlength=n).astype(float)
        take = c > cnt
        with np.errstate(invalid="ignore", divide="ignore"):
            wfrac[take] = (w / c)[take]
            vfrac[take] = (v / c)[take]
        cnt = np.maximum(cnt, c)
    ok = cnt >= MIN_VALID_FRACTION * expected
    cls = np.where(ok, np.where(wfrac >= 0.5, 2, np.where(vfrac >= 0.5, 3, 1)), 0).astype(np.uint8)
    return cls, quality


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--aoi", default="stl", choices=list(AOIS))
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--min-coverage", type=float, default=0.35, help="Minimum classified fraction of the AOI to keep a pass")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()

    load_env()
    token = earthdata_token()
    a = AOIS[args.aoi]
    grid = Grid(a)
    out_dir = ROOT / "public" / "data" / a["out"] / args.aoi
    out_dir.mkdir(parents=True, exist_ok=True)

    log("JRC reference occurrence…")
    occ = jrc_occurrence(a, grid)
    cell_km = math.sqrt(float(np.mean(grid.cell_area_km2())))
    expected = np.full(len(occ), (cell_km * 1000 / 80) ** 2)  # 80 m samples per cell (approx.)

    log(f"Searching NISAR GCOV {args.start} → {args.end} over {a['name']}…")
    granules = search(grid, args.start, args.end)
    passes: dict[tuple, list[dict]] = {}
    for g in granules:
        passes.setdefault((g["track"], g["direction"], g["start"][:10]), []).append(g)
    log(f"{len(granules)} granules in {len(passes)} passes")

    reduced: dict[str, dict] = {}
    with cf.ThreadPoolExecutor(args.workers) as ex:
        futs = {ex.submit(read_granule, g, grid, token): g for g in granules}
        for fut in cf.as_completed(futs):
            g = futs[fut]
            try:
                reduced[g["title"]] = fut.result()
            except Exception as e:  # keep going; retried once below
                log(f"  failed (will retry) {g['title']}: {e}")
    for g in granules:
        if g["title"] in reduced:
            continue
        try:  # one sequential retry; signed download URLs can expire under load
            reduced[g["title"]] = read_granule(g, grid, token)
        except Exception as e:
            log(f"  FAILED {g['title']}: {e}")

    manifest_passes = []
    kept: list[tuple[str, np.ndarray]] = []
    for (track, direction, day), gs in sorted(passes.items(), key=lambda kv: kv[1][0]["start"]):
        frames = [reduced[g["title"]] for g in gs if g["title"] in reduced]
        if not frames:
            continue
        cls, quality = classify_pass(frames, occ, expected)
        coverage = float(np.mean(cls > 0)) if cls is not None else 0.0
        pid = f"{day}_T{track:03d}{direction}"
        if cls is None or coverage < args.min_coverage:
            log(f"  skip {pid}: coverage {coverage:.0%}, quality {quality}")
            continue
        kept.append((pid, cls))
        manifest_passes.append(dict(
            id=pid,
            time=min(g["start"] for g in gs),
            track=track,
            direction="Ascending" if direction == "A" else "Descending",
            status="Validated" if all(g["status"] == "Validated" for g in gs) else "Provisional",
            granules=[g["title"] for g in gs],
            coverage=round(coverage, 4),
            waterFraction=round(float(np.mean(cls == 2)), 4),
            **quality,
        ))
        log(f"  {pid}: coverage {coverage:.0%}, water {np.mean(cls == 2):.1%}, bright-veg {np.mean(cls == 3):.1%}, {quality}")

    # Persistently bright cells (bright in nearly every pass) are structures, not seasonal flooding.
    persistent = np.zeros(len(occ), bool)
    if kept:
        stack = np.stack([c for _, c in kept])
        observed = (stack > 0).sum(axis=0)
        bright = (stack == 3).sum(axis=0)
        with np.errstate(invalid="ignore", divide="ignore"):
            persistent = (observed >= PERSIST_MIN_PASSES) & (bright / np.maximum(observed, 1) >= PERSIST_SHARE)
        log(f"Persistently bright cells excluded from inundated vegetation: {int(persistent.sum())}")
    (out_dir / "persistent_bright.bin").write_bytes(persistent.astype(np.uint8).tobytes())
    for (pid, cls), meta in zip(kept, manifest_passes):
        cls = cls.copy()
        cls[(cls == 3) & persistent] = 1
        meta["inundatedVegFraction"] = round(float(np.mean(cls == 3)), 4)
        (out_dir / f"{pid}.bin").write_bytes(cls.tobytes())

    manifest = dict(
        aoi=args.aoi,
        name=a["name"],
        grid=dict(z=a["z"], x0=a["x0"], y0=a["y0"], tilesX=a["tiles_x"], tilesY=a["tiles_y"], cellsPerTile=a["cells_per_tile"]),
        generated=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        range=dict(start=args.start, end=args.end),
        product="NISAR L2 GCOV, frequency B (80 m), HH and HV backscatter",
        classes={"0": "no data", "1": "other / not inundated", "2": "open water", "3": "possible inundated vegetation"},
        method=(
            "Each valid 80 m sample is water if HH backscatter (and HV, when it separates water from land on that pass) is below "
            "a threshold trained per pass on the pooled samples of its frames: the "
            "midpoint between the 25th percentile of samples in JRC persistent-water cells (occurrence >= 90%) and the 5th "
            f"percentile of samples in never-water cells (0%), clamped HH {THRESH_CLAMP_HH} dB / HV {THRESH_CLAMP_HV} dB; passes "
            f"whose water/land separation is < {MIN_SEPARATION_DB} dB are rejected. A ~0.55 km cell is water when >= 50% of its "
            f"valid samples are water; cells with < {int(MIN_VALID_FRACTION * 100)}% valid samples are no-data. Frames of one pass "
            "are mosaicked. Possible inundated vegetation (L-band double bounce): samples with HH >= "
            f"{IV_MIN_HH_DB} dB and HH-HV >= {IV_MIN_RATIO_DB} dB; a cell is labelled so when >= 50% of its samples are. Cells "
            f"bright in >= {int(PERSIST_SHARE * 100)}% of >= {PERSIST_MIN_PASSES} passes are treated as persistent structures "
            "(urban, bridges) and excluded."
        ),
        limitations=(
            "Inundated-vegetation thresholds are fixed literature-style values, not trained on local ground truth; urban areas and "
            "other double-bounce structures can still be confused with flooded vegetation, and some flooded vegetation is not "
            "bright enough to be detected. Wind-roughened water can be missed; radar shadow and very smooth surfaces can be "
            "mistaken for water. Not validated against ground truth."
        ),
        passes=manifest_passes,
    )
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    log(f"Wrote {len(manifest_passes)} passes → {out_dir}")


if __name__ == "__main__":
    main()
