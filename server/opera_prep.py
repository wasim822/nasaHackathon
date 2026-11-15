"""Real flood observations from NASA OPERA DSWx-S1 (Sentinel-1 surface-water maps, North America).

Downloads the 30 m water-classification layer (B01_WTR) of every DSWx-S1 tile over the area and
date range, groups tiles acquired on the same pass, and aggregates them to the app's Web-Mercator
grid. Writes the same per-pass class files the app's flood pipeline reads for NISAR:

    public/data/opera-flood/<aoi>/manifest.json
    public/data/opera-flood/<aoi>/<pass>.bin     (one byte per grid cell: 0 no data, 1 dry, 2 water)

DSWx-S1 WTR classes (OPERA DSWx-S1 product spec v1.0): 0 not water, 1 open water,
3 inundated vegetation, 250 HAND masked, 251 layover/shadow masked, 255 no data.

Usage:
    server/.venv/Scripts/python server/opera_prep.py --start 2025-03-15 --end 2025-05-15
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import io
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests
import tifffile
from pyproj import Transformer

sys.path.insert(0, str(Path(__file__).parent))
import flood_prep as fp  # noqa: E402  (grid, env, logging, CMR endpoint)
from httpfile import earthdata_token  # noqa: E402

ROOT = fp.ROOT
CACHE = fp.CACHE / "opera"
log = fp.log
COLLECTION = "C2949811996-POCLOUD"  # OPERA_L3_DSWX-S1_V1 (PO.DAAC)

# Must match src/features/flood/operaFlood.ts (OPERA_AOI) exactly.
AOIS = {
    # Missouri Bootheel & NE Arkansas lowlands: widespread flooding after the 2–6 April 2025 rains.
    "bootheel25": dict(name="Missouri Bootheel & NE Arkansas lowlands (USA)", z=9, x0=126, y0=199, tiles_x=3, tiles_y=3, cells_per_tile=128),
}

WATER = (1, 3)          # open water, inundated vegetation
VALID_MAX = 3           # classes 0–3 are observations; 250+ are masks / no data
SUBSAMPLE = 3           # 30 m → 90 m samples (≈36 per ~0.55 km cell)
MIN_VALID_FRACTION = 0.3
WATER_SHARE = 0.5


def search(grid: fp.Grid, start: str, end: str) -> list[dict]:
    out, page = [], 1
    while True:
        r = requests.get(fp.CMR, params={
            "concept_id": COLLECTION, "bounding_box": f"{grid.west},{grid.south},{grid.east},{grid.north}",
            "temporal": f"{start}T00:00:00Z,{end}T23:59:59Z", "page_size": 200, "page_num": page, "sort_key": "start_date",
        }, timeout=90)
        r.raise_for_status()
        entries = r.json()["feed"]["entry"]
        for e in entries:
            wtr = next((l["href"] for l in e["links"] if l["href"].startswith("https") and l["href"].endswith("_B01_WTR.tif")), None)
            if wtr:
                out.append(dict(title=e["title"], url=wtr, start=e["time_start"], tile=e["title"].split("_")[3]))
        if len(entries) < 200:
            break
        page += 1
    return out


def read_tile(g: dict, grid: fp.Grid, token: str) -> tuple[np.ndarray, np.ndarray]:
    """Per-cell counts of valid and water samples for one DSWx-S1 tile."""
    n = grid.rows * grid.cols
    cpath = CACHE / f"{g['title']}.npz"
    if cpath.exists():
        d = np.load(cpath)
        return d["valid"], d["water"]
    r = requests.get(g["url"], headers={"Authorization": f"Bearer {token}"}, timeout=180)
    r.raise_for_status()
    with tifffile.TiffFile(io.BytesIO(r.content)) as t:
        a = t.pages[0].asarray()
        geo = t.geotiff_metadata
    epsg = int(geo["ProjectedCSTypeGeoKey"])
    x0, y0 = geo["ModelTiepoint"][3], geo["ModelTiepoint"][4]
    dx, dy = geo["ModelPixelScale"][0], geo["ModelPixelScale"][1]
    sub = a[::SUBSAMPLE, ::SUBSAMPLE]
    rows, cols = np.mgrid[0:a.shape[0]:SUBSAMPLE, 0:a.shape[1]:SUBSAMPLE]
    xs = x0 + (cols + 0.5) * dx
    ys = y0 - (rows + 0.5) * dy
    lon, lat = Transformer.from_crs(epsg, 4326, always_xy=True).transform(xs, ys)
    idx = grid.cell_index(lat, lon).ravel()
    v = sub.ravel()
    ok = idx >= 0
    valid = np.bincount(idx[ok], weights=(v[ok] <= VALID_MAX), minlength=n)
    water = np.bincount(idx[ok], weights=np.isin(v[ok], WATER), minlength=n)
    CACHE.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cpath, valid=valid, water=water)
    log(f"  read {g['title'][:60]}… {len(r.content) // 1024} KB")
    return valid, water


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--aoi", default="bootheel25", choices=list(AOIS))
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--min-coverage", type=float, default=0.15, help="Minimum imaged fraction of the area to keep a pass")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()
    fp.load_env()
    token = earthdata_token()
    a = AOIS[args.aoi]
    grid = fp.Grid(a)
    n = grid.rows * grid.cols
    cell_km = float(np.sqrt(np.mean(grid.cell_area_km2())))
    expected = (cell_km * 1000 / (30 * SUBSAMPLE)) ** 2
    out_dir = ROOT / "public" / "data" / "opera-flood" / args.aoi
    out_dir.mkdir(parents=True, exist_ok=True)

    log(f"Searching OPERA DSWx-S1 {args.start} → {args.end} over {a['name']}…")
    granules = search(grid, args.start, args.end)
    # Tiles acquired within the same hour belong to one Sentinel-1 pass.
    passes: dict[str, list[dict]] = {}
    for g in granules:
        passes.setdefault(g["start"][:13], []).append(g)
    log(f"{len(granules)} tiles in {len(passes)} passes")

    counts: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    with cf.ThreadPoolExecutor(args.workers) as ex:
        futs = {ex.submit(read_tile, g, grid, token): g for g in granules}
        for fut in cf.as_completed(futs):
            g = futs[fut]
            try:
                counts[g["title"]] = fut.result()
            except Exception as e:
                log(f"  FAILED {g['title']}: {e}")

    manifest_passes = []
    for key, gs in sorted(passes.items()):
        got = [counts[g["title"]] for g in gs if g["title"] in counts]
        if not got:
            continue
        valid = np.sum([v for v, _ in got], axis=0)
        water = np.sum([w for _, w in got], axis=0)
        cls = np.zeros(n, np.uint8)
        seen = valid >= expected * MIN_VALID_FRACTION
        cls[seen] = 1
        cls[seen & (water >= WATER_SHARE * np.maximum(valid, 1))] = 2
        coverage = float(seen.mean())
        pid = f"{key[:10]}_S1_{key[11:13]}h"
        if coverage < args.min_coverage:
            log(f"  skip {pid}: coverage {coverage:.0%}")
            continue
        (out_dir / f"{pid}.bin").write_bytes(cls.tobytes())
        manifest_passes.append(dict(
            id=pid, time=min(g["start"] for g in gs), tiles=sorted({g["tile"] for g in gs}), granules=[g["title"] for g in gs],
            coverage=round(coverage, 4), waterFraction=round(float(np.mean(cls == 2)), 4),
        ))
        log(f"  {pid}: {len(gs)} tiles, coverage {coverage:.0%}, water {np.mean(cls == 2):.1%} of area")

    manifest = dict(
        aoi=args.aoi, name=a["name"], product="OPERA L3 DSWx-S1 v1 (Sentinel-1)",
        grid=dict(z=a["z"], x0=a["x0"], y0=a["y0"], tilesX=a["tiles_x"], tilesY=a["tiles_y"], cellsPerTile=a["cells_per_tile"]),
        generated=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        range=dict(start=args.start, end=args.end),
        method=("NASA/JPL OPERA DSWx-S1 classifies Sentinel-1 C-band VV/VH backscatter into surface water at 30 m. "
                "Open water and inundated vegetation count as water. Each ~0.55 km cell is water when at least half of its "
                f"90 m samples are (sampled every {SUBSAMPLE}th pixel), and no data when fewer than {int(MIN_VALID_FRACTION * 100)}% "
                "of its expected samples were imaged (layover/shadow and unimaged areas are no data). Tiles from the same "
                "Sentinel-1 pass are combined."),
        limitations=("Sentinel-1, not NISAR (these floods predate NISAR's launch). Radar misses water under dense canopy and can "
                     "mistake smooth surfaces or wet fields for water. This is rice country: some fields are flooded on purpose "
                     "in late spring, so not every new-water region is floodwater. Each pass images part of the area."),
        passes=manifest_passes,
    )
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    log(f"Wrote {len(manifest_passes)} passes → {out_dir}")


if __name__ == "__main__":
    main()
